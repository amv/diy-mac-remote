'use strict';

// macOS virtual key codes for named special keys.
//
// Reference: HIToolbox Events.h (kVK_*). Used with AppleScript `key code N`.
// The hex beside each one is the constant it comes from, so this table can be
// checked against Events.h by eye — worth having, because the numbers are not
// guessable: F1 to F4 are scattered (122, 120, 99, 118) while F5 to F9 run
// consecutively from 96, so a wrong entry looks no different from a right one.
const KEY_CODES = {
  return: 36,        // kVK_Return         0x24
  enter: 36,
  tab: 48,           // kVK_Tab            0x30
  space: 49,         // kVK_Space          0x31
  delete: 51,        // kVK_Delete         0x33  (backspace)
  backspace: 51,
  escape: 53,        // kVK_Escape         0x35
  esc: 53,
  forwarddelete: 117, // kVK_ForwardDelete 0x75
  globe: 63,         // kVK_Function       0x3F  Fn / 🌐 — does little on its own;
  fn: 63,            //                          mirrors the Mac key
  home: 115,         // kVK_Home           0x73
  end: 119,          // kVK_End            0x77
  pageup: 116,       // kVK_PageUp         0x74
  pagedown: 121,     // kVK_PageDown       0x79
  left: 123,         // kVK_LeftArrow      0x7B
  right: 124,        // kVK_RightArrow     0x7C
  down: 125,         // kVK_DownArrow      0x7D
  up: 126,           // kVK_UpArrow        0x7E
  f1: 122,           // kVK_F1             0x7A
  f2: 120,           // kVK_F2             0x78
  f3: 99,            // kVK_F3             0x63
  f4: 118,           // kVK_F4             0x76
  f5: 96,            // kVK_F5             0x60
  f6: 97,            // kVK_F6             0x61
  f7: 98,            // kVK_F7             0x62
  f8: 100,           // kVK_F8             0x64
  f9: 101,           // kVK_F9             0x65
  f10: 109,          // kVK_F10            0x6D
  f11: 103,          // kVK_F11            0x67
  f12: 111,          // kVK_F12            0x6F
};

// AppleScript modifier names accepted in `using {... down}`.
const MODIFIERS = {
  command: 'command down',
  cmd: 'command down',
  option: 'option down',
  alt: 'option down',
  control: 'control down',
  ctrl: 'control down',
  shift: 'shift down',
};

module.exports = { KEY_CODES, MODIFIERS };
