// SDL2 subset: window/canvas, WebGL context, input events (written in SDL's
// binary layout), relative mouse mode via pointer lock, text input, clipboard.

const SDL_KEYDOWN = 0x300, SDL_KEYUP = 0x301, SDL_TEXTINPUT = 0x303, SDL_MOUSEMOTION = 0x400,
  SDL_MOUSEBUTTONDOWN = 0x401, SDL_MOUSEBUTTONUP = 0x402, SDL_MOUSEWHEEL = 0x403;
const KMOD_LSHIFT = 0x1, KMOD_RSHIFT = 0x2, KMOD_LCTRL = 0x40, KMOD_RCTRL = 0x80,
  KMOD_LALT = 0x100, KMOD_RALT = 0x200, KMOD_LGUI = 0x400, KMOD_RGUI = 0x800;
const SDL_WINDOW_INPUT_FOCUS = 0x200, SDL_WINDOW_OPENGL = 0x2, SDL_WINDOW_SHOWN = 0x4;
const SCANCODE_MASK = 1 << 30;

// KeyboardEvent.code -> [SDL scancode, SDL keycode (US layout)]
const KEYS = {};
(() => {
  for (let i = 0; i < 26; i++) KEYS['Key' + String.fromCharCode(65 + i)] = [4 + i, 97 + i];
  for (let i = 1; i <= 9; i++) KEYS['Digit' + i] = [29 + i, 48 + i];
  KEYS.Digit0 = [39, 48];
  const specials = {
    Enter: [40, 13], Escape: [41, 27], Backspace: [42, 8], Tab: [43, 9], Space: [44, 32],
    Minus: [45, 45], Equal: [46, 61], BracketLeft: [47, 91], BracketRight: [48, 93],
    Backslash: [49, 92], Semicolon: [51, 59], Quote: [52, 39], Backquote: [53, 96],
    Comma: [54, 44], Period: [55, 46], Slash: [56, 47], Delete: [76, 127],
    IntlBackslash: [100, 60],
  };
  Object.assign(KEYS, specials);
  const plain = {
    CapsLock: 57, PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75,
    End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
    NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87,
    NumpadEnter: 88, Numpad1: 89, Numpad2: 90, Numpad3: 91, Numpad4: 92, Numpad5: 93,
    Numpad6: 94, Numpad7: 95, Numpad8: 96, Numpad9: 97, Numpad0: 98, NumpadDecimal: 99,
    ContextMenu: 101, ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
    ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
  };
  for (const [k, sc] of Object.entries(plain)) KEYS[k] = [sc, sc | SCANCODE_MASK];
  for (let i = 1; i <= 12; i++) KEYS['F' + i] = [57 + i, (57 + i) | SCANCODE_MASK];
})();

// SDL scancode names (SDL_GetScancodeName), matched case-insensitively
const SCANCODE_NAMES = (() => {
  const m = new Map();
  for (let i = 0; i < 26; i++) m.set(String.fromCharCode(97 + i), 4 + i);
  for (let i = 1; i <= 9; i++) m.set(String(i), 29 + i);
  m.set('0', 39);
  const names = {
    return: 40, enter: 40, escape: 41, backspace: 42, tab: 43, space: 44, '-': 45, '=': 46,
    '[': 47, ']': 48, '\\': 49, '#': 50, ';': 51, "'": 52, '`': 53, ',': 54, '.': 55, '/': 56,
    capslock: 57, printscreen: 70, scrolllock: 71, pause: 72, insert: 73, home: 74,
    pageup: 75, delete: 76, end: 77, pagedown: 78, right: 79, left: 80, down: 81, up: 82,
    numlock: 83, 'keypad /': 84, 'keypad *': 85, 'keypad -': 86, 'keypad +': 87,
    'keypad enter': 88, 'keypad 1': 89, 'keypad 2': 90, 'keypad 3': 91, 'keypad 4': 92,
    'keypad 5': 93, 'keypad 6': 94, 'keypad 7': 95, 'keypad 8': 96, 'keypad 9': 97,
    'keypad 0': 98, 'keypad .': 99, application: 101, 'left ctrl': 224, 'left shift': 225,
    'left alt': 226, 'left gui': 227, 'right ctrl': 228, 'right shift': 229,
    'right alt': 230, 'right gui': 231,
  };
  for (const [k, v] of Object.entries(names)) m.set(k, v);
  for (let i = 1; i <= 12; i++) m.set('f' + i, 57 + i);
  return m;
})();

// keys the browser must not act upon while playing
const KEEP_DEFAULT = new Set(['F5', 'F11', 'F12']);

// The game's name for a key (KeyboardEvent.code), as the bind command takes it; null for
// keys the game does not get or that stay the browser's (Esc releases the mouse first).
export function bindKeyName(code) {
  const key = KEYS[code];
  if (!key || code === 'Escape' || KEEP_DEFAULT.has(code)) return null;
  for (const [name, sc] of SCANCODE_NAMES) if (sc === key[0]) return name;
  return null;
}

export function createSDL(rt, canvas, hooks = {}) {
  const queue = [];
  let textInput = false;
  let relativeMouse = false;
  let clipboard = '';
  let gl = null;
  let active = false;
  const enc = new TextEncoder();
  const t0 = performance.now();
  let frameClock = 0, lastClock = 0;

  function now() { return (performance.now() - t0) | 0; }

  function modState(e) {
    let m = 0;
    if (e.shiftKey) m |= KMOD_LSHIFT;
    if (e.ctrlKey) m |= KMOD_LCTRL;
    if (e.altKey) m |= KMOD_LALT;
    if (e.metaKey) m |= KMOD_LGUI;
    return m;
  }
  let lastMods = 0;

  function onKey(e, down) {
    if (!active) return;
    const key = KEYS[e.code];
    lastMods = modState(e);
    const isPaste = down && (e.ctrlKey || e.metaKey) && e.code === 'KeyV';
    if (!KEEP_DEFAULT.has(e.code) && !isPaste) e.preventDefault();
    if (!key) return;
    queue.push({ type: down ? SDL_KEYDOWN : SDL_KEYUP, scancode: key[0], sym: key[1],
      mod: lastMods, repeat: e.repeat ? 1 : 0 });
    if (down && e.key && [...e.key].length === 1) {
      const altGr = e.ctrlKey && e.altKey;
      if (altGr || !(e.ctrlKey || e.altKey || e.metaKey)) queue.push({ type: SDL_TEXTINPUT, text: e.key });
    }
  }

  function onMouseMove(e) {
    if (!active) return;
    const last = queue[queue.length - 1];
    if (last && last.type === SDL_MOUSEMOTION) {
      last.xrel += e.movementX;
      last.yrel += e.movementY;
    } else {
      queue.push({ type: SDL_MOUSEMOTION, x: e.offsetX | 0, y: e.offsetY | 0,
        xrel: e.movementX, yrel: e.movementY });
    }
  }

  function onMouseButton(e, down) {
    if (!active) return;
    e.preventDefault();
    if (down && relativeMouse && document.pointerLockElement !== canvas) {
      requestLock();
      return;
    }
    queue.push({ type: down ? SDL_MOUSEBUTTONDOWN : SDL_MOUSEBUTTONUP, button: e.button + 1,
      x: e.offsetX | 0, y: e.offsetY | 0 });
  }

  function requestLock() {
    try {
      const p = canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { canvas.requestPointerLock(); } catch (_) {} });
    } catch (_) {
      try { canvas.requestPointerLock(); } catch (_) {}
    }
  }

  // hooks.input === false: the page handles input itself (the spectator); the game gets none
  if (hooks.input !== false) {
    window.addEventListener('keydown', (e) => onKey(e, true), true);
    window.addEventListener('keyup', (e) => onKey(e, false), true);
    // events on the canvas bubble to the document, also while the pointer is locked
    document.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', (e) => onMouseButton(e, true));
    window.addEventListener('mouseup', (e) => { if (active) onMouseButton(e, false); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (!active) return;
      e.preventDefault();
      queue.push({ type: SDL_MOUSEWHEEL, x: 0, y: e.deltaY < 0 ? 1 : -1 });
    }, { passive: false });
    document.addEventListener('paste', (e) => {
      if (!active) return;
      clipboard = (e.clipboardData && e.clipboardData.getData('text')) || '';
      e.preventDefault();
    });
  }
  document.addEventListener('pointerlockchange', () => {
    if (hooks.onPointerLock) hooks.onPointerLock(document.pointerLockElement === canvas);
  });
  window.addEventListener('blur', () => {
    // release everything so keys do not get stuck when the window loses focus
    if (!active) return;
    for (const code of Object.keys(KEYS)) {
      queue.push({ type: SDL_KEYUP, scancode: KEYS[code][0], sym: KEYS[code][1], mod: 0, repeat: 0 });
    }
    for (let b = 1; b <= 5; b++) queue.push({ type: SDL_MOUSEBUTTONUP, button: b, x: 0, y: 0 });
  });

  function writeEvent(ptr, ev) {
    const u8 = rt.u8();
    u8.fill(0, ptr, ptr + 56);
    const dv = rt.dv();
    dv.setUint32(ptr, ev.type, true);
    dv.setUint32(ptr + 4, now(), true);
    dv.setUint32(ptr + 8, 1, true);
    switch (ev.type) {
      case SDL_KEYDOWN: case SDL_KEYUP:
        dv.setUint8(ptr + 12, ev.type === SDL_KEYDOWN ? 1 : 0);
        dv.setUint8(ptr + 13, ev.repeat);
        dv.setInt32(ptr + 16, ev.scancode, true);
        dv.setInt32(ptr + 20, ev.sym, true);
        dv.setUint16(ptr + 24, ev.mod, true);
        break;
      case SDL_TEXTINPUT: {
        const b = enc.encode(ev.text).subarray(0, 31);
        u8.set(b, ptr + 12);
        break;
      }
      case SDL_MOUSEMOTION:
        dv.setInt32(ptr + 20, ev.x, true);
        dv.setInt32(ptr + 24, ev.y, true);
        dv.setInt32(ptr + 28, Math.round(ev.xrel), true);
        dv.setInt32(ptr + 32, Math.round(ev.yrel), true);
        break;
      case SDL_MOUSEBUTTONDOWN: case SDL_MOUSEBUTTONUP:
        dv.setUint8(ptr + 16, ev.button);
        dv.setUint8(ptr + 17, ev.type === SDL_MOUSEBUTTONDOWN ? 1 : 0);
        dv.setUint8(ptr + 18, 1);
        dv.setInt32(ptr + 20, ev.x, true);
        dv.setInt32(ptr + 24, ev.y, true);
        break;
      case SDL_MOUSEWHEEL:
        dv.setInt32(ptr + 16, ev.x, true);
        dv.setInt32(ptr + 20, ev.y, true);
        break;
    }
  }

  const api = {
    SDL_Init: () => 0,
    SDL_Quit: () => {},
    SDL_CreateWindow: (titlePtr, x, y, w, h, flags) => {
      canvas.width = w;
      canvas.height = h;
      if (hooks.onWindow) hooks.onWindow(w, h);
      return 1;
    },
    SDL_GetWindowFlags: () => SDL_WINDOW_OPENGL | SDL_WINDOW_SHOWN |
      (document.hasFocus() ? SDL_WINDOW_INPUT_FOCUS : 0),
    SDL_MinimizeWindow: () => {},
    SDL_GL_SetAttribute: () => 0,
    SDL_GL_CreateContext: () => {
      if (!gl) {
        gl = canvas.getContext('webgl2', {
          alpha: false, antialias: false, depth: false, stencil: false,
          preserveDrawingBuffer: false, powerPreference: 'high-performance',
        });
      }
      return gl ? 1 : 0;
    },
    SDL_GL_MakeCurrent: () => 0,
    SDL_GL_SetSwapInterval: () => 0,
    SDL_GL_SwapWindow: () => {},
    SDL_GetCurrentDisplayMode: (index, ptr) => {
      const [w, h] = hooks.displaySize ? hooks.displaySize() : [canvas.width, canvas.height];
      const dv = rt.dv();
      dv.setUint32(ptr, 0x16362004, true);
      dv.setInt32(ptr + 4, w, true);
      dv.setInt32(ptr + 8, h, true);
      dv.setInt32(ptr + 12, 60, true);
      dv.setUint32(ptr + 16, 0, true);
      return 0;
    },
    SDL_PollEvent: (ptr) => {
      if (!queue.length) return 0;
      const ev = queue.shift();
      if (ptr) writeEvent(ptr, ev);
      return 1;
    },
    SDL_StartTextInput: () => { textInput = true; },
    SDL_StopTextInput: () => { textInput = false; },
    SDL_SetRelativeMouseMode: (on) => {
      relativeMouse = !!on && hooks.input !== false;
      if (relativeMouse && document.pointerLockElement !== canvas && navigator.userActivation &&
          navigator.userActivation.isActive) requestLock();
      if (!relativeMouse && document.pointerLockElement === canvas) document.exitPointerLock();
      return 0;
    },
    SDL_GetModState: () => lastMods,
    SDL_GetScancodeFromName: (namePtr) => SCANCODE_NAMES.get(rt.cstr(namePtr).toLowerCase()) || 0,
    SDL_SetClipboardText: (ptr) => {
      clipboard = rt.cstr(ptr);
      if (navigator.clipboard) navigator.clipboard.writeText(clipboard).catch(() => {});
      return 0;
    },
    // Only the frame timing reads this: it returns the display frame's timestamp,
    // so every frame advances the simulation and interpolation by exactly one
    // refresh interval instead of by when the callback happened to run.
    SDL_GetPerformanceCounter: () => {
      const t = Math.max(frameClock || performance.now(), lastClock);
      lastClock = t;
      return BigInt(Math.round(t * 1000));
    },
    SDL_GetPerformanceFrequency: () => 1000000n,
    SDL_GetTicks: () => now(),
    MessageBox: (titlePtr, textPtr, buttons) => {
      const title = rt.cstr(titlePtr), text = rt.cstr(textPtr);
      if (hooks.onMessage) hooks.onMessage(title, text);
      if (buttons > 1) return window.confirm(title + '\n\n' + text) ? 0 : 1;
      console.warn('[soldat]', title + ': ' + text);
      return 0;
    },
    GetClipboardText: (buf, size) => {
      const b = enc.encode(clipboard).subarray(0, Math.max(0, size - 1));
      rt.u8().set(b, buf);
      rt.u8()[buf + b.length] = 0;
      return b.length;
    },
  };

  api.setActive = (on) => {
    active = on;
    queue.length = 0;
    if (!on && document.pointerLockElement === canvas) document.exitPointerLock();
  };
  api.requestLock = requestLock;
  // timestamp of the display frame being produced, 0 outside the frame loop
  api.setFrameClock = (t) => { frameClock = t; };
  api.wantsPointerLock = () => relativeMouse;
  api.getContext = () => gl;
  return api;
}
