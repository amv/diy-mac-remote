#!/usr/bin/perl
#
# server.pl — the Node-free entrypoint: plain HTTP, in Perl, in front of the
# same backend server.js uses.
#
# Why this exists
# ---------------
# The Node entrypoint has to be given a Node.js first, which means either
# trusting whatever is installed or downloading and verifying an official build
# (ensure-node.sh). On a Mac that is already running the application inside
# `osascript -l JavaScript`, that is a whole dependency for a socket. Perl ships
# with macOS. So does osascript. Between them there is nothing left to install.
#
# What you give up: TLS. This entrypoint speaks plain HTTP and only plain HTTP —
# no certificate, no HTTPS. That is a deliberate limit, not an omission, and it
# is why this path is meant for one of two situations:
#
#   * over Tailscale, where the tailnet already encrypts and authenticates
#     every packet between the phone and the Mac (the recommended pairing), or
#   * on a network with no route to the internet at all.
#
# The application's own encryption (ChaCha20 + HMAC, see README > Security) is
# in place either way; what plain HTTP costs you is protection against an active
# attacker on the local network rewriting the page itself. If that is a risk
# where you are, use server.js with a certificate instead.
#
# What it does
# ------------
# Accept connections, parse HTTP, serve public/, and hand the two requests that
# need a secret — GET /nonce and POST /msg — to the backend over the line
# protocol in app/protocol.js. It knows nothing about nonces, pairing or
# keystrokes; that all lives in app/, shared byte-for-byte with the Node path.
#
# Core Perl only: no CPAN, nothing to install, auditable in one sitting — and
# deliberately little to parse. The protocol to the backend is `key: value`
# lines, so reading it takes a split and writing it takes a sprintf. Static
# files are looked up in a listing of public/ rather than built from the
# request. A request body must carry Content-Length. Every one of those is the
# same trade: less code standing between the port and anyone who can reach it.
#
#   perl server.pl [detect|wifi|tailscale|<url>] [--reset-token]
#   ./start-plain.sh ...
#
# (No `use utf8` on purpose: every string in here is bytes — what came off a
# socket, what goes to a socket, what goes to the terminal — and treating them
# as anything else is how encodings get applied twice.)

use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;
use File::Basename qw(dirname);
use Cwd qw(abs_path);
use POSIX ();

my $ROOT = dirname(abs_path($0));
my $PUBLIC = "$ROOT/public";
my $PORT = $ENV{PORT} || 8765;
# Explicit bind-address override. Unset (the normal case) we bind all
# interfaces; set, we bind exactly that address.
my $BIND = $ENV{HOST} || '0.0.0.0';
my $MAX_BODY = 64 * 1024;
my @ARGS = @ARGV;
my $REQ_ID = 0;

$SIG{PIPE} = 'IGNORE';   # a client that hangs up must not take the server down
$| = 1;                  # our output is a log; keep it in order with the backend's

# ---------------------------------------------------------------------------
# The protocol: `key: value` lines, blank line ends the message
# ---------------------------------------------------------------------------
#
# Values are percent-encoded, so they can never contain a newline (which would
# break the framing) and a message is always plain ASCII. See app/protocol.js
# for the full description — this is the same format from the other side.

sub pct_encode {
    my ($value) = @_;
    $value = '' unless defined $value;
    $value =~ s/([^\x20-\x24\x26-\x7e])/sprintf('%%%02X', ord($1))/ge;   # all but '%'
    return $value;
}

sub pct_decode {
    my ($value) = @_;
    $value =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
    return $value;
}

# Build a message from a list of key => value pairs. A value may be an array
# reference, which writes the key once per element (that is how a command line
# and a certificate's names travel).
sub message {
    my (@pairs) = @_;
    my $out = '';
    while (@pairs) {
        my ($key, $value) = (shift @pairs, shift @pairs);
        next unless defined $value;
        for my $item (ref $value eq 'ARRAY' ? @$value : ($value)) {
            $out .= $key . ': ' . pct_encode($item) . "\n";
        }
    }
    return $out . "\n";
}

# Read one message from the backend into { key => [values] }, or undef at EOF.
sub read_message {
    my ($fh) = @_;
    my %msg;
    my $got = 0;
    while (defined(my $line = readline($fh))) {
        $line =~ s/\r?\n\z//;
        last if $line eq '';
        $got = 1;
        my ($key, $value) = $line =~ /\A([^:]*):[ ]?(.*)\z/s or next;
        push @{ $msg{$key} }, pct_decode($value);
    }
    return undef unless $got;
    return \%msg;
}

sub one { my ($msg, $key) = @_; return $msg->{$key} ? $msg->{$key}[0] : undef; }

# ---------------------------------------------------------------------------
# The backend
# ---------------------------------------------------------------------------

# Which interpreter runs the application. macOS gets JXA, where input events are
# posted from inside the process; anything else gets Node, which logs them
# instead (development and the test suite). DIY_MAC_REMOTE_BACKEND forces either.
sub backend_command {
    my $forced = $ENV{DIY_MAC_REMOTE_BACKEND} || '';
    my $use_jxa = $forced ? ($forced eq 'jxa') : ($^O eq 'darwin');
    return ('osascript', '-l', 'JavaScript', "$ROOT/app/host-jxa.js") if $use_jxa;
    my $node = -x "$ROOT/node/bin/node" ? "$ROOT/node/bin/node" : 'node';
    return ($node, "$ROOT/app/host-node.js");
}

my ($BACKEND_IN, $BACKEND_OUT, $BACKEND_PID, $BACKEND_KIND);

sub start_backend {
    my @cmd = backend_command();
    $BACKEND_KIND = $cmd[0] =~ /osascript/ ? 'jxa' : 'node';

    pipe(my $child_stdin,  my $to_child)     or die "pipe: $!\n";
    pipe(my $from_child,   my $child_stdout) or die "pipe: $!\n";
    # The backend's stderr is its human output — log lines, warnings and the
    # pairing QR. Keep a handle on our real stdout so the child can send it
    # there, since its own stdout is about to become the message pipe.
    open(my $our_stdout, '>&', \*STDOUT) or die "dup stdout: $!\n";

    # osascript is handed a script path, not a module: it has no __dirname and
    # finds the checkout through the environment.
    $ENV{DIY_MAC_REMOTE_ROOT} = $ROOT;

    my $pid = fork();
    die "fork: $!\n" unless defined $pid;
    if ($pid == 0) {
        close $to_child;
        close $from_child;
        open(STDIN,  '<&', $child_stdin)  or POSIX::_exit(127);
        open(STDOUT, '>&', $child_stdout) or POSIX::_exit(127);
        open(STDERR, '>&', $our_stdout)   or POSIX::_exit(127);
        # ("no warnings 'exec'" only silences perl's guess that the line below
        # is unreachable — it is reached exactly when exec fails, which is the
        # case worth handling.)
        { no warnings 'exec'; exec { $cmd[0] } @cmd; }
        POSIX::_exit(127);    # exec failed: the command isn't there
    }
    close $child_stdin;
    close $child_stdout;
    select((select($to_child), $| = 1)[0]);    # no buffering on the message pipe

    ($BACKEND_IN, $BACKEND_OUT, $BACKEND_PID) = ($to_child, $from_child, $pid);
}

sub backend_died {
    my ($why) = @_;
    print "\n❌ $why\n";
    exit 1;
}

# Send one message and read the answer. The backend handles messages strictly in
# order, one at a time, so this is the whole of the client: write one, read one.
# (It also means a slow request delays the next one — with a single phone on the
# other end, that is a trade worth making for how little there is to go wrong.)
sub backend_call {
    my ($message) = @_;
    print { $BACKEND_IN } $message
        or backend_died("Lost the $BACKEND_KIND backend while sending a request.");
    my $answer = read_message($BACKEND_OUT);
    backend_died("The $BACKEND_KIND backend exited."
        . ($BACKEND_KIND eq 'jxa'
            ? " If this happened at startup, check that osascript can run:\n"
            . '   osascript -l JavaScript -e "1+1"' : ''))
        unless defined $answer;
    return $answer;
}

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

my %STATUS_TEXT = (
    200 => 'OK',           400 => 'Bad Request',    401 => 'Unauthorized',
    403 => 'Forbidden',    404 => 'Not Found',      405 => 'Method Not Allowed',
    411 => 'Length Required', 413 => 'Payload Too Large',
    500 => 'Internal Server Error',
    502 => 'Bad Gateway',
);

# public/ is served from here rather than from the backend, so no file bytes
# ever cross the protocol — which is why that protocol can be plain text.
#
# A static request is answered by listing the directory and looking the requested
# path up in that listing. Nothing a client sends is ever joined onto a directory
# name or turned into a path: the path we open is one this server built from what
# it found on disk, and a request that doesn't match one of those exactly is a
# 404. There is no traversal to defend against, no normalization to get subtly
# wrong, and no encoding trick to try.
#
# Listing per request rather than once at startup costs a readdir of four files,
# and only on a page load — the phone loads the page once and then talks to /msg
# for the rest of the session. In exchange, a file dropped into public/ is served
# immediately, with nothing to restart.
#
# (server.js does the same thing in the same way; test/perl.test.js holds the two
# implementations to the same answers.)
my %MIME = (
    'html'        => 'text/html; charset=utf-8',
    'js'          => 'text/javascript; charset=utf-8',
    'css'         => 'text/css; charset=utf-8',
    'svg'         => 'image/svg+xml',
    'ico'         => 'image/x-icon',
    'png'         => 'image/png',
    'json'        => 'application/json',
    'webmanifest' => 'application/manifest+json',
);

# Walk public/ and record what is in it: URL path -> [ file, content type ].
# Symlinks are skipped — one could point anywhere at all, and "only what is in
# this directory" is the whole point.
sub list_public {
    my ($dir, $prefix, $found) = @_;
    opendir(my $dh, $dir) or return $found;
    for my $name (sort readdir($dh)) {
        next if $name eq '.' || $name eq '..';
        my $file = "$dir/$name";
        my $url  = "$prefix/$name";
        next if -l $file;
        if (-d $file) { list_public($file, $url, $found); next; }
        next unless -f $file;
        my $type = 'application/octet-stream';
        $type = $MIME{lc $1} if $name =~ /\.([A-Za-z0-9]+)\z/ && $MIME{lc $1};
        $found->{$url} = [$file, $type];
    }
    closedir($dh);
    return $found;
}

sub write_all {
    my ($fh, $data) = @_;
    my $off = 0;
    while ($off < length($data)) {
        my $n = syswrite($fh, $data, length($data) - $off, $off);
        return 0 unless defined $n && $n > 0;    # client hung up
        $off += $n;
    }
    return 1;
}

sub send_response {
    my ($fh, $status, $type, $body, $keepalive) = @_;
    my $out = "HTTP/1.1 $status " . ($STATUS_TEXT{$status} || 'OK') . "\r\n";
    $out .= "Content-Type: $type\r\n";
    $out .= "Cache-Control: no-store\r\n";
    $out .= 'Content-Length: ' . length($body) . "\r\n";
    $out .= 'Connection: ' . ($keepalive ? 'keep-alive' : 'close') . "\r\n\r\n";
    return write_all($fh, $out . $body);
}

sub send_json {
    my ($fh, $status, $body, $keepalive) = @_;
    return send_response($fh, $status, 'application/json', $body, $keepalive);
}

sub send_error {
    my ($fh, $status, $error) = @_;
    my $escaped = $error;
    $escaped =~ s/(["\\])/\\$1/g;
    return send_json($fh, $status, '{"error":"' . $escaped . '"}', 0);
}

sub serve_static {
    my ($fh, $path, $keepalive) = @_;
    my $files = list_public($PUBLIC, '', {});
    $files->{'/'} = $files->{'/index.html'} if $files->{'/index.html'};
    my $entry = $files->{$path} or return send_error($fh, 404, 'Not found');
    open(my $in, '<', $entry->[0]) or return send_error($fh, 404, 'Not found');
    binmode($in);
    my $body = do { local $/; <$in> };
    close($in);
    return send_response($fh, 200, $entry->[1], $body, $keepalive);
}

# Two paths need a secret to answer and go to the backend. Everything else is a
# file, or a mistake.
sub serve_request {
    my ($fh, $method, $target, $body, $keepalive) = @_;
    my ($path) = split /\?/, $target, 2;

    unless (($method eq 'GET' && $path eq '/nonce') || ($method eq 'POST' && $path eq '/msg')) {
        return serve_static($fh, $path, $keepalive) if $method eq 'GET' || $method eq 'HEAD';
        return send_error($fh, 405, 'Method not allowed');
    }

    my $answer = backend_call(message(
        't'      => 'req',
        'id'     => ++$REQ_ID,
        'method' => $method,
        'path'   => $target,
        'body'   => $body,
    ));
    return send_json($fh, one($answer, 'status') || 500, one($answer, 'body') || '', $keepalive);
}

# Pull complete requests out of a connection's buffer, one at a time. Returns
# false when the connection should be closed.
sub process_buffer {
    my ($fh, $conn) = @_;
    while (1) {
        my $end = index($conn->{in}, "\r\n\r\n");
        return 1 if $end < 0;                       # headers still arriving
        if ($end > 32 * 1024) { send_error($fh, 400, 'Headers too large'); return 0; }

        my @lines = split /\r\n/, substr($conn->{in}, 0, $end);
        my ($method, $target, $version) = split / /, (shift(@lines) || '');
        unless (defined $method && defined $target) {
            send_error($fh, 400, 'Malformed request line');
            return 0;
        }

        my %headers;
        for my $line (@lines) {
            next unless $line =~ /^([^:]+):\s*(.*)$/;
            $headers{ lc $1 } = $2;
        }

        # A body must come with its length. The page always sends one (fetch
        # sets Content-Length for a string body), so the only thing supporting
        # Transfer-Encoding would buy is a chunk decoder sitting on the
        # unauthenticated path — parsing code answering to anyone who can reach
        # the port. Refuse it in the one line HTTP has for exactly this.
        if (exists $headers{'transfer-encoding'}) {
            send_error($fh, 411, 'Send a body with Content-Length; Transfer-Encoding is not accepted');
            return 0;
        }

        my $length = $headers{'content-length'} || 0;
        $length = 0 unless $length =~ /^\d+$/;
        if ($length > $MAX_BODY) { send_error($fh, 413, 'Request body too large'); return 0; }
        return 1 if length($conn->{in}) < $end + 4 + $length;    # body still arriving
        my $body = substr($conn->{in}, $end + 4, $length);
        substr($conn->{in}, 0, $end + 4 + $length) = '';

        # HTTP/1.1 keeps the connection open unless asked not to; HTTP/1.0 is the
        # other way round.
        my $connection = lc($headers{connection} || '');
        my $keepalive = ($version && $version eq 'HTTP/1.0')
            ? ($connection eq 'keep-alive')
            : ($connection ne 'close');

        my $written = serve_request($fh, uc($method), $target, $body, $keepalive);
        return 0 unless $written && $keepalive;
    }
}

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

# Bind before the backend is asked to resolve its credentials: a pairing run
# mints a master, prints it once and forgets it, so discovering the port is
# taken afterwards would leave an install nothing can ever pair against.
my $listener = IO::Socket::INET->new(
    LocalAddr => $BIND,
    LocalPort => $PORT,
    Listen    => 128,
    ReuseAddr => 1,
    Proto     => 'tcp',
);
unless ($listener) {
    my $why = $@ || $!;
    if ($why =~ /in use/i) {
        print "\n❌ Port $PORT is already in use. Stop the other process, or set PORT=<n>.\n";
    } else {
        print "\n❌ Server failed to start: $why\n";
    }
    exit 1;
}

start_backend();

my $ready = backend_call(message(
    't'      => 'hello',
    'scheme' => 'http',
    'port'   => $PORT,
    'entry'  => 'perl',
    'arg'    => \@ARGS,
));

unless ((one($ready, 'ok') || '') eq '1') {
    print "\n❌ " . (one($ready, 'error') || 'the backend refused to start') . "\n";
    exit 1;
}

print "diy-mac-remote server running.\n";
print "   Serving plain HTTP — this entrypoint has no TLS at all. Use it over a\n";
print "   tailnet, or on a network with no route to the internet. See README >\n";
print "   \"Run it without Node.js\".\n";
print '   Backend: ' . ($BACKEND_KIND eq 'jxa' ? 'osascript -l JavaScript' : 'node') . ".\n";
if ((one($ready, 'dry-run') || '') eq '1') {
    print "NOTE: input is being logged, not executed (dry-run) — this is not a Mac,\n";
    print "      or DIY_MAC_REMOTE_BACKEND=node was set.\n";
}

backend_call(message('t' => 'banner'));

# ---------------------------------------------------------------------------
# Serve
# ---------------------------------------------------------------------------
#
# One process, one select loop, no threads and no forking per connection: the
# backend handles one request at a time anyway, so there would be nothing for a
# second worker to do but wait its turn.

my $select = IO::Select->new($listener);
my %conns;    # "fileno" -> { fh, in }

while (1) {
    my @ready = $select->can_read();
    for my $fh (@ready) {
        if ($fh == $listener) {
            my $client = $listener->accept() or next;
            $client->autoflush(1);
            binmode($client);
            $select->add($client);
            $conns{ fileno($client) } = { fh => $client, in => '' };
            next;
        }

        my $conn = $conns{ fileno($fh) };
        next unless $conn;

        my $n = sysread($fh, my $chunk, 65536);
        if (!defined $n || $n == 0) {
            close_connection($select, \%conns, $fh);
            next;
        }
        $conn->{in} .= $chunk;
        # A client that sends a huge request line and never a blank line must
        # not be able to grow this buffer without limit.
        if (length($conn->{in}) > $MAX_BODY + 32 * 1024) {
            send_error($fh, 413, 'Request too large');
            close_connection($select, \%conns, $fh);
            next;
        }
        close_connection($select, \%conns, $fh) unless process_buffer($fh, $conn);
    }
}

sub close_connection {
    my ($select, $conns, $fh) = @_;
    $select->remove($fh);
    delete $conns->{ fileno($fh) };
    close($fh);
}
