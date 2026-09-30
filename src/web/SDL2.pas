{
  SDL2 replacement for the WebAssembly build of Soldat.

  Exposes the subset of the SDL2 API the game uses. Window, GL context, input events,
  timers and clipboard are implemented in JavaScript (import module "sdl"); small helpers
  like RWops and WAV decoding are implemented here in Pascal. Record layouts follow SDL2 so
  the game code compiles unchanged, and the JS side writes events using the same layout.
}
unit SDL2;

{$mode delphi}

interface

uses
  SysUtils;

type
  UInt8 = Byte;
  UInt16 = Word;
  UInt32 = LongWord;
  SInt32 = LongInt;
  SInt16 = SmallInt;
  UInt64 = QWord;
  SInt64 = Int64;
  PUInt8 = ^UInt8;
  PPUInt8 = ^PUInt8;
  PUInt16 = ^UInt16;
  PUInt32 = ^UInt32;
  TSDL_Bool = LongBool;

  PSDL_Window = Pointer;
  TSDL_GLContext = Pointer;
  PSDL_Surface = Pointer;

  TSDL_ScanCode = LongInt;
  TSDL_KeyCode = LongInt;
  TSDL_Keymod = UInt16;
  TSDL_GLattr = LongInt;

  TSDL_Keysym = record
    scancode: TSDL_ScanCode;
    sym: TSDL_KeyCode;
    _mod: UInt16;
    unicode: UInt32;
  end;

  TSDL_CommonEvent = record
    type_: UInt32;
    timestamp: UInt32;
  end;

  TSDL_KeyboardEvent = record
    type_: UInt32;
    timestamp: UInt32;
    windowID: UInt32;
    state: UInt8;
    _repeat: UInt8;
    padding2: UInt8;
    padding3: UInt8;
    keysym: TSDL_Keysym;
  end;

  TSDL_TextInputEvent = record
    type_: UInt32;
    timestamp: UInt32;
    windowID: UInt32;
    text: array[0..31] of Char;
  end;

  TSDL_MouseMotionEvent = record
    type_: UInt32;
    timestamp: UInt32;
    windowID: UInt32;
    which: UInt32;
    state: UInt32;
    x: SInt32;
    y: SInt32;
    xrel: SInt32;
    yrel: SInt32;
  end;

  TSDL_MouseButtonEvent = record
    type_: UInt32;
    timestamp: UInt32;
    windowID: UInt32;
    which: UInt32;
    button: UInt8;
    state: UInt8;
    clicks: UInt8;
    padding1: UInt8;
    x: SInt32;
    y: SInt32;
  end;

  TSDL_MouseWheelEvent = record
    type_: UInt32;
    timestamp: UInt32;
    windowID: UInt32;
    which: UInt32;
    x: SInt32;
    y: SInt32;
    direction: UInt32;
  end;

  TSDL_WindowEvent = record
    type_: UInt32;
    timestamp: UInt32;
    windowID: UInt32;
    event: UInt8;
    padding1, padding2, padding3: UInt8;
    data1: SInt32;
    data2: SInt32;
  end;

  PSDL_Event = ^TSDL_Event;
  TSDL_Event = record
    case Integer of
      0: (type_: UInt32);
      1: (common: TSDL_CommonEvent);
      2: (key: TSDL_KeyboardEvent);
      3: (text: TSDL_TextInputEvent);
      4: (motion: TSDL_MouseMotionEvent);
      5: (button: TSDL_MouseButtonEvent);
      6: (wheel: TSDL_MouseWheelEvent);
      7: (window: TSDL_WindowEvent);
      8: (padding: array[0..55] of UInt8);
  end;

  PSDL_DisplayMode = ^TSDL_DisplayMode;
  TSDL_DisplayMode = record
    format: UInt32;
    w: SInt32;
    h: SInt32;
    refresh_rate: SInt32;
    driverdata: Pointer;
  end;

  PSDL_MessageBoxButtonData = ^TSDL_MessageBoxButtonData;
  TSDL_MessageBoxButtonData = record
    flags: UInt32;
    buttonid: SInt32;
    text: PAnsiChar;
  end;

  PSDL_MessageBoxData = ^TSDL_MessageBoxData;
  TSDL_MessageBoxData = record
    flags: UInt32;
    window: PSDL_Window;
    title: PAnsiChar;
    _message: PAnsiChar;
    numbuttons: SInt32;
    buttons: PSDL_MessageBoxButtonData;
    colorScheme: Pointer;
  end;

  PSDL_RWops = ^TSDL_RWops;
  TSDL_RWops = record
    Data: PByte;
    Size: SInt64;
    Pos: SInt64;
  end;

  PSDL_AudioSpec = ^TSDL_AudioSpec;
  TSDL_AudioSpec = record
    freq: SInt32;
    format: UInt16;
    channels: UInt8;
    silence: UInt8;
    samples: UInt16;
    padding: UInt16;
    size: UInt32;
    callback: Pointer;
    userdata: Pointer;
  end;

const
  SDL_FALSE = False;
  SDL_TRUE = True;

  SDL_INIT_TIMER = $00000001;
  SDL_INIT_AUDIO = $00000010;
  SDL_INIT_VIDEO = $00000020;

  SDL_QUITEV = $100;
  SDL_WINDOWEVENT = $200;
  SDL_KEYDOWN = $300;
  SDL_KEYUP = $301;
  SDL_TEXTEDITING = $302;
  SDL_TEXTINPUT = $303;
  SDL_MOUSEMOTION = $400;
  SDL_MOUSEBUTTONDOWN = $401;
  SDL_MOUSEBUTTONUP = $402;
  SDL_MOUSEWHEEL = $403;

  SDL_WINDOWEVENT_FOCUS_GAINED = 12;
  SDL_WINDOWEVENT_FOCUS_LOST = 13;

  SDL_BUTTON_LEFT = 1;
  SDL_BUTTON_MIDDLE = 2;
  SDL_BUTTON_RIGHT = 3;

  SDL_WINDOWPOS_UNDEFINED = $1FFF0000;
  SDL_WINDOW_FULLSCREEN = $00000001;
  SDL_WINDOW_OPENGL = $00000002;
  SDL_WINDOW_SHOWN = $00000004;
  SDL_WINDOW_INPUT_FOCUS = $00000200;
  SDL_WINDOW_FULLSCREEN_DESKTOP = SDL_WINDOW_FULLSCREEN or $00001000;

  SDL_GL_RED_SIZE = 0;
  SDL_GL_DOUBLEBUFFER = 5;
  SDL_GL_MULTISAMPLEBUFFERS = 13;
  SDL_GL_MULTISAMPLESAMPLES = 14;
  SDL_GL_CONTEXT_MAJOR_VERSION = 17;
  SDL_GL_CONTEXT_MINOR_VERSION = 18;
  SDL_GL_CONTEXT_PROFILE_MASK = 21;
  SDL_GL_CONTEXT_PROFILE_CORE = $0001;
  SDL_GL_CONTEXT_PROFILE_COMPATIBILITY = $0002;
  SDL_GL_CONTEXT_PROFILE_ES = $0004;

  SDL_MESSAGEBOX_ERROR = $00000010;
  SDL_MESSAGEBOX_WARNING = $00000020;
  SDL_MESSAGEBOX_INFORMATION = $00000040;
  SDL_MESSAGEBOX_BUTTON_RETURNKEY_DEFAULT = $00000001;
  SDL_MESSAGEBOX_BUTTON_ESCAPEKEY_DEFAULT = $00000002;

  KMOD_NONE = $0000;
  KMOD_LSHIFT = $0001;
  KMOD_RSHIFT = $0002;
  KMOD_LCTRL = $0040;
  KMOD_RCTRL = $0080;
  KMOD_LALT = $0100;
  KMOD_RALT = $0200;
  KMOD_LGUI = $0400;
  KMOD_RGUI = $0800;
  KMOD_SHIFT = KMOD_LSHIFT or KMOD_RSHIFT;
  KMOD_CTRL = KMOD_LCTRL or KMOD_RCTRL;
  KMOD_ALT = KMOD_LALT or KMOD_RALT;
  KMOD_GUI = KMOD_LGUI or KMOD_RGUI;

  AUDIO_U8 = $0008;
  AUDIO_S8 = $8008;
  AUDIO_S16LSB = $8010;
  AUDIO_S16 = AUDIO_S16LSB;
  AUDIO_S32LSB = $8020;
  AUDIO_F32LSB = $8120;
  AUDIO_F32 = AUDIO_F32LSB;
  AUDIO_S16SYS = AUDIO_S16LSB;
  AUDIO_S32SYS = AUDIO_S32LSB;
  AUDIO_F32SYS = AUDIO_F32LSB;

  // scancodes (USB HID usage page 7), as in SDL_scancode.h
  SDL_SCANCODE_UNKNOWN = 0;
  SDL_SCANCODE_A = 4;
  SDL_SCANCODE_Z = 29;
  SDL_SCANCODE_1 = 30;
  SDL_SCANCODE_2 = 31;
  SDL_SCANCODE_3 = 32;
  SDL_SCANCODE_4 = 33;
  SDL_SCANCODE_5 = 34;
  SDL_SCANCODE_6 = 35;
  SDL_SCANCODE_7 = 36;
  SDL_SCANCODE_8 = 37;
  SDL_SCANCODE_9 = 38;
  SDL_SCANCODE_0 = 39;
  SDL_SCANCODE_RETURN = 40;
  SDL_SCANCODE_ESCAPE = 41;
  SDL_SCANCODE_BACKSPACE = 42;
  SDL_SCANCODE_TAB = 43;
  SDL_SCANCODE_SPACE = 44;
  SDL_SCANCODE_F1 = 58;
  SDL_SCANCODE_F2 = 59;
  SDL_SCANCODE_F3 = 60;
  SDL_SCANCODE_F4 = 61;
  SDL_SCANCODE_F5 = 62;
  SDL_SCANCODE_F6 = 63;
  SDL_SCANCODE_F7 = 64;
  SDL_SCANCODE_F8 = 65;
  SDL_SCANCODE_F9 = 66;
  SDL_SCANCODE_F10 = 67;
  SDL_SCANCODE_F11 = 68;
  SDL_SCANCODE_F12 = 69;
  SDL_SCANCODE_INSERT = 73;
  SDL_SCANCODE_HOME = 74;
  SDL_SCANCODE_PAGEUP = 75;
  SDL_SCANCODE_DELETE = 76;
  SDL_SCANCODE_END = 77;
  SDL_SCANCODE_PAGEDOWN = 78;
  SDL_SCANCODE_RIGHT = 79;
  SDL_SCANCODE_LEFT = 80;
  SDL_SCANCODE_DOWN = 81;
  SDL_SCANCODE_UP = 82;
  SDL_SCANCODE_KP_ENTER = 88;
  SDL_NUM_SCANCODES = 512;

  SDLK_SCANCODE_MASK = 1 shl 30;
  SDLK_UNKNOWN = 0;
  SDLK_BACKSPACE = 8;
  SDLK_TAB = 9;
  SDLK_RETURN = 13;
  SDLK_ESCAPE = 27;
  SDLK_SPACE = 32;
  SDLK_DELETE = 127;
  SDLK_a = 97;
  SDLK_c = 99;
  SDLK_v = 118;
  SDLK_x = 120;
  SDLK_INSERT = SDL_SCANCODE_INSERT or SDLK_SCANCODE_MASK;
  SDLK_HOME = SDL_SCANCODE_HOME or SDLK_SCANCODE_MASK;
  SDLK_END = SDL_SCANCODE_END or SDLK_SCANCODE_MASK;
  SDLK_PAGEUP = SDL_SCANCODE_PAGEUP or SDLK_SCANCODE_MASK;
  SDLK_PAGEDOWN = SDL_SCANCODE_PAGEDOWN or SDLK_SCANCODE_MASK;
  SDLK_RIGHT = SDL_SCANCODE_RIGHT or SDLK_SCANCODE_MASK;
  SDLK_LEFT = SDL_SCANCODE_LEFT or SDLK_SCANCODE_MASK;
  SDLK_DOWN = SDL_SCANCODE_DOWN or SDLK_SCANCODE_MASK;
  SDLK_UP = SDL_SCANCODE_UP or SDLK_SCANCODE_MASK;
  SDLK_KP_ENTER = SDL_SCANCODE_KP_ENTER or SDLK_SCANCODE_MASK;

// implemented in JavaScript (module "sdl")
function SDL_Init(flags: UInt32): SInt32; cdecl; external 'sdl' name 'SDL_Init';
procedure SDL_Quit; cdecl; external 'sdl' name 'SDL_Quit';
function SDL_CreateWindow(title: PAnsiChar; x, y, w, h: SInt32; flags: UInt32): PSDL_Window; cdecl; external 'sdl' name 'SDL_CreateWindow';
function SDL_GetWindowFlags(window: PSDL_Window): UInt32; cdecl; external 'sdl' name 'SDL_GetWindowFlags';
procedure SDL_MinimizeWindow(window: PSDL_Window); cdecl; external 'sdl' name 'SDL_MinimizeWindow';
function SDL_GL_SetAttribute(attr: TSDL_GLattr; value: SInt32): SInt32; cdecl; external 'sdl' name 'SDL_GL_SetAttribute';
function SDL_GL_CreateContext(window: PSDL_Window): TSDL_GLContext; cdecl; external 'sdl' name 'SDL_GL_CreateContext';
function SDL_GL_MakeCurrent(window: PSDL_Window; context: TSDL_GLContext): SInt32; cdecl; external 'sdl' name 'SDL_GL_MakeCurrent';
function SDL_GL_SetSwapInterval(interval: SInt32): SInt32; cdecl; external 'sdl' name 'SDL_GL_SetSwapInterval';
procedure SDL_GL_SwapWindow(window: PSDL_Window); cdecl; external 'sdl' name 'SDL_GL_SwapWindow';
function SDL_GetCurrentDisplayMode(displayIndex: SInt32; mode: PSDL_DisplayMode): SInt32; cdecl; external 'sdl' name 'SDL_GetCurrentDisplayMode';
function SDL_PollEvent(event: PSDL_Event): SInt32; cdecl; external 'sdl' name 'SDL_PollEvent';
procedure SDL_StartTextInput; cdecl; external 'sdl' name 'SDL_StartTextInput';
procedure SDL_StopTextInput; cdecl; external 'sdl' name 'SDL_StopTextInput';
function SDL_SetRelativeMouseMode(enabled: TSDL_Bool): SInt32; cdecl; external 'sdl' name 'SDL_SetRelativeMouseMode';
function SDL_GetModState: TSDL_Keymod; cdecl; external 'sdl' name 'SDL_GetModState';
function SDL_GetScancodeFromName(name: PAnsiChar): TSDL_ScanCode; cdecl; external 'sdl' name 'SDL_GetScancodeFromName';
function SDL_SetClipboardText(text: PAnsiChar): SInt32; cdecl; external 'sdl' name 'SDL_SetClipboardText';
function SDL_GetPerformanceCounter: UInt64; cdecl; external 'sdl' name 'SDL_GetPerformanceCounter';
function SDL_GetPerformanceFrequency: UInt64; cdecl; external 'sdl' name 'SDL_GetPerformanceFrequency';
function SDL_GetTicks: UInt32; cdecl; external 'sdl' name 'SDL_GetTicks';
function js_sdl_messagebox(title, text: PAnsiChar; buttons: SInt32): SInt32; cdecl; external 'sdl' name 'MessageBox';
function js_sdl_clipboard(buf: PAnsiChar; size: SInt32): SInt32; cdecl; external 'sdl' name 'GetClipboardText';

// implemented in Pascal
function SDL_GetError: PAnsiChar;
function SDL_GetPrefPath(org, app: PAnsiChar): PAnsiChar;
function SDL_GetBasePath: PAnsiChar;
function SDL_GetClipboardText: PAnsiChar;
procedure SDL_free(mem: Pointer);
function SDL_ShowSimpleMessageBox(flags: UInt32; title, message: PAnsiChar; window: PSDL_Window): SInt32;
function SDL_ShowMessageBox(messageboxdata: PSDL_MessageBoxData; buttonid: PInteger): SInt32;
procedure SDL_SetWindowIcon(window: PSDL_Window; icon: PSDL_Surface);
function SDL_RWFromMem(mem: Pointer; size: SInt32): PSDL_RWops;
function SDL_RWclose(context: PSDL_RWops): SInt32;
function SDL_LoadWAV_RW(src: PSDL_RWops; freesrc: SInt32; spec: PSDL_AudioSpec;
  audio_buf: PPUInt8; audio_len: PUInt32): PSDL_AudioSpec;
procedure SDL_FreeWAV(audio_buf: PUInt8);
function SDL_LoadBMP_RW(src: PSDL_RWops; freesrc: SInt32): PSDL_Surface;
procedure SDL_FreeSurface(surface: PSDL_Surface);

implementation

const
  EmptyError: AnsiString = '';
  PrefPath: AnsiString = '/user/';
  BasePath: AnsiString = '/soldat/';

var
  ClipboardBuf: array[0..4095] of AnsiChar;

function SDL_GetError: PAnsiChar;
begin
  Result := PAnsiChar(EmptyError);
end;

function SDL_GetPrefPath(org, app: PAnsiChar): PAnsiChar;
begin
  Result := PAnsiChar(PrefPath);
end;

function SDL_GetBasePath: PAnsiChar;
begin
  Result := PAnsiChar(BasePath);
end;

function SDL_GetClipboardText: PAnsiChar;
begin
  ClipboardBuf[0] := #0;
  js_sdl_clipboard(@ClipboardBuf[0], SizeOf(ClipboardBuf));
  Result := @ClipboardBuf[0];
end;

procedure SDL_free(mem: Pointer);
begin
  // SDL_GetClipboardText returns a static buffer in this build; nothing to free.
end;

function SDL_ShowSimpleMessageBox(flags: UInt32; title, message: PAnsiChar; window: PSDL_Window): SInt32;
begin
  js_sdl_messagebox(title, message, 1);
  Result := 0;
end;

function SDL_ShowMessageBox(messageboxdata: PSDL_MessageBoxData; buttonid: PInteger): SInt32;
var
  Choice: SInt32;
begin
  Choice := js_sdl_messagebox(messageboxdata^.title, messageboxdata^._message,
    messageboxdata^.numbuttons);
  // JS returns 0 for the first (accept) button, 1 for the second (cancel)
  if (Choice < 0) or (Choice >= messageboxdata^.numbuttons) then
    Choice := messageboxdata^.numbuttons - 1;
  if messageboxdata^.numbuttons > 0 then
    buttonid^ := PSDL_MessageBoxButtonData(PByte(messageboxdata^.buttons) +
      Choice * SizeOf(TSDL_MessageBoxButtonData))^.buttonid
  else
    buttonid^ := -1;
  Result := 0;
end;

procedure SDL_SetWindowIcon(window: PSDL_Window; icon: PSDL_Surface);
begin
end;

function SDL_RWFromMem(mem: Pointer; size: SInt32): PSDL_RWops;
begin
  New(Result);
  Result^.Data := mem;
  Result^.Size := size;
  Result^.Pos := 0;
end;

function SDL_RWclose(context: PSDL_RWops): SInt32;
begin
  Dispose(context);
  Result := 0;
end;

const
  WAVE_FORMAT_PCM = 1;
  WAVE_FORMAT_ADPCM = 2;        // Microsoft ADPCM
  WAVE_FORMAT_IEEE_FLOAT = 3;
  WAVE_FORMAT_IMA_ADPCM = $11;
  WAVE_FORMAT_EXTENSIBLE = $FFFE;

type
  PSmallIntArray = ^TSmallIntArray;
  TSmallIntArray = array[0..$3FFFFFF] of SmallInt;

function Clamp16(v: LongInt): SmallInt; inline;
begin
  if v > 32767 then
    v := 32767
  else if v < -32768 then
    v := -32768;
  Result := v;
end;

function RdS16(p: PByte): LongInt; inline;
begin
  Result := SmallInt(p[0] or (p[1] shl 8));
end;

// Microsoft ADPCM (4 bits per sample), decoded like SDL_LoadWAV_RW does.
// Fmt points to the fmt chunk body; returns the number of sample frames written.
function DecodeMSADPCM(Fmt: PByte; FmtSize: UInt32; Data: PByte; DataSize: UInt32;
  Channels: Integer; Frames: UInt32; Output: PSmallIntArray): UInt32;
const
  ADAPTATION: array[0..15] of LongInt =
    (230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230);
  DEFAULT_COEFS: array[0..6, 0..1] of LongInt =
    ((256, 0), (512, -256), (0, 0), (192, 64), (240, 0), (460, -208), (392, -232));
var
  BlockAlign, SamplesPerBlock, NumCoef: Integer;
  Coef: array of array[0..1] of LongInt;
  Pred, Delta, S1, S2, C1, C2: array[0..1] of LongInt;
  Block, BlockEnd, q: PByte;
  c, i, Nibble, Idx, BlockSamples: Integer;
  Frame, Written: UInt32;
  NewSample: LongInt;
begin
  Result := 0;
  BlockAlign := PUInt16(Fmt + 12)^;
  SamplesPerBlock := 0;
  NumCoef := 0;
  if FmtSize >= 22 then
  begin
    SamplesPerBlock := PUInt16(Fmt + 18)^;
    NumCoef := PUInt16(Fmt + 20)^;
  end;
  if (NumCoef < 7) or (FmtSize < 22 + UInt32(NumCoef) * 4) then
  begin
    NumCoef := 7;
    SetLength(Coef, 7);
    for i := 0 to 6 do
    begin
      Coef[i][0] := DEFAULT_COEFS[i][0];
      Coef[i][1] := DEFAULT_COEFS[i][1];
    end;
  end
  else
  begin
    SetLength(Coef, NumCoef);
    for i := 0 to NumCoef - 1 do
    begin
      Coef[i][0] := RdS16(Fmt + 22 + i * 4);
      Coef[i][1] := RdS16(Fmt + 24 + i * 4);
    end;
  end;
  if (Channels < 1) or (Channels > 2) or (BlockAlign < 7 * Channels) then
    Exit;
  if SamplesPerBlock <= 0 then
    SamplesPerBlock := (BlockAlign - 7 * Channels) * 2 div Channels + 2;

  Written := 0;
  Block := Data;
  while (Block + 7 * Channels <= Data + DataSize) and (Written < Frames) do
  begin
    BlockEnd := Block + BlockAlign;
    if BlockEnd > Data + DataSize then
      BlockEnd := Data + DataSize;  // truncated final block
    q := Block;
    for c := 0 to Channels - 1 do
    begin
      Idx := q^;
      Inc(q);
      if Idx >= NumCoef then
        Idx := 0;
      C1[c] := Coef[Idx][0];
      C2[c] := Coef[Idx][1];
    end;
    for c := 0 to Channels - 1 do
    begin
      Delta[c] := RdS16(q);
      Inc(q, 2);
    end;
    for c := 0 to Channels - 1 do
    begin
      S1[c] := RdS16(q);
      Inc(q, 2);
    end;
    for c := 0 to Channels - 1 do
    begin
      S2[c] := RdS16(q);
      Inc(q, 2);
    end;

    // the header holds the first two samples, oldest first
    for c := 0 to Channels - 1 do
      Output^[Written * UInt32(Channels) + UInt32(c)] := S2[c];
    Inc(Written);
    if Written < Frames then
    begin
      for c := 0 to Channels - 1 do
        Output^[Written * UInt32(Channels) + UInt32(c)] := S1[c];
      Inc(Written);
    end;

    // then one nibble per sample, high nibble first, channels interleaved
    BlockSamples := 2;
    c := 0;
    Frame := Written;
    i := 0;
    while (BlockSamples < SamplesPerBlock) and (Written < Frames) do
    begin
      if q >= BlockEnd then
        Break;
      if i = 0 then
        Nibble := q^ shr 4
      else
      begin
        Nibble := q^ and $F;
        Inc(q);
      end;
      i := i xor 1;

      Pred[c] := (S1[c] * C1[c] + S2[c] * C2[c]) div 256;
      if Nibble >= 8 then
        NewSample := Pred[c] + (Nibble - 16) * Delta[c]
      else
        NewSample := Pred[c] + Nibble * Delta[c];
      NewSample := Clamp16(NewSample);
      Delta[c] := (ADAPTATION[Nibble] * Delta[c]) div 256;
      if Delta[c] < 16 then
        Delta[c] := 16;
      S2[c] := S1[c];
      S1[c] := NewSample;
      Output^[Frame * UInt32(Channels) + UInt32(c)] := NewSample;

      Inc(c);
      if c = Channels then
      begin
        c := 0;
        Inc(Frame);
        Written := Frame;
        Inc(BlockSamples);
      end;
    end;
    Block := Block + BlockAlign;
  end;
  Result := Written;
end;

// IMA ADPCM (4 bits per sample), decoded like SDL_LoadWAV_RW does.
function DecodeIMAADPCM(Fmt: PByte; FmtSize: UInt32; Data: PByte; DataSize: UInt32;
  Channels: Integer; Frames: UInt32; Output: PSmallIntArray): UInt32;
const
  INDEX_TABLE: array[0..15] of LongInt = (-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8);
  STEP_TABLE: array[0..88] of LongInt = (
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
    12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767);
var
  BlockAlign, SamplesPerBlock: Integer;
  Sample, Index: array[0..7] of LongInt;
  Block, BlockEnd, q: PByte;
  c, n, k, Nibble, Step, Diff: Integer;
  Base, Written, Frame: UInt32;
begin
  Result := 0;
  BlockAlign := PUInt16(Fmt + 12)^;
  if (Channels < 1) or (Channels > 8) or (PUInt16(Fmt + 14)^ <> 4) or
    (BlockAlign < 4 * Channels) then
    Exit;
  SamplesPerBlock := (BlockAlign - 4 * Channels) * 2 div Channels + 1;

  Written := 0;
  Block := Data;
  while (Block + 4 * Channels <= Data + DataSize) and (Written < Frames) do
  begin
    BlockEnd := Block + BlockAlign;
    if BlockEnd > Data + DataSize then
      BlockEnd := Data + DataSize;
    q := Block;
    for c := 0 to Channels - 1 do
    begin
      Sample[c] := RdS16(q);
      Index[c] := q[2];
      if Index[c] > 88 then
        Index[c] := 88;
      Inc(q, 4);
      Output^[Written * UInt32(Channels) + UInt32(c)] := Sample[c];
    end;
    Base := Written + 1;
    Inc(Written);

    // groups of 4 bytes (8 samples) per channel, low nibble first
    n := 0;
    while (n + 8 <= SamplesPerBlock - 1) and (q + 4 * Channels <= BlockEnd) do
    begin
      for c := 0 to Channels - 1 do
      begin
        for k := 0 to 7 do
        begin
          if k and 1 = 0 then
            Nibble := q[k shr 1] and $F
          else
            Nibble := q[k shr 1] shr 4;
          Step := STEP_TABLE[Index[c]];
          Diff := Step shr 3;
          if Nibble and 4 <> 0 then Inc(Diff, Step);
          if Nibble and 2 <> 0 then Inc(Diff, Step shr 1);
          if Nibble and 1 <> 0 then Inc(Diff, Step shr 2);
          if Nibble and 8 <> 0 then
            Sample[c] := Clamp16(Sample[c] - Diff)
          else
            Sample[c] := Clamp16(Sample[c] + Diff);
          Index[c] := Index[c] + INDEX_TABLE[Nibble];
          if Index[c] < 0 then Index[c] := 0;
          if Index[c] > 88 then Index[c] := 88;
          Frame := Base + UInt32(n + k);
          if Frame < Frames then
            Output^[Frame * UInt32(Channels) + UInt32(c)] := Sample[c];
        end;
        Inc(q, 4);
      end;
      Inc(n, 8);
    end;
    Written := Base + UInt32(n);
    if Written > Frames then
      Written := Frames;
    Block := Block + BlockAlign;
  end;
  Result := Written;
end;

// RIFF/WAVE parser like SDL_LoadWAV_RW: PCM 8/16/24/32-bit, IEEE float, Microsoft
// and IMA ADPCM (decoded to 16-bit). Other encodings are rejected, as SDL does.
function SDL_LoadWAV_RW(src: PSDL_RWops; freesrc: SInt32; spec: PSDL_AudioSpec;
  audio_buf: PPUInt8; audio_len: PUInt32): PSDL_AudioSpec;
var
  p, EndP, Fmt: PByte;
  ChunkId: array[0..3] of AnsiChar;
  ChunkSize, FmtSize, FactFrames, Frames, i, Count: UInt32;
  FormatTag, Channels, Bits, BlockAlign: UInt16;
  Rate: UInt32;
  Out16: PSmallIntArray;
begin
  Result := nil;
  if (src = nil) or (src^.Size < 12) then
    Exit;
  p := src^.Data;
  EndP := p + src^.Size;
  if (PAnsiChar(p)[0] <> 'R') or (PAnsiChar(p)[1] <> 'I') or (PAnsiChar(p)[2] <> 'F') or
    (PAnsiChar(p)[8] <> 'W') then
  begin
    if freesrc <> 0 then SDL_RWclose(src);
    Exit;
  end;
  Inc(p, 12);
  Fmt := nil;
  FmtSize := 0;
  FactFrames := 0;
  FormatTag := WAVE_FORMAT_PCM; Channels := 1; Bits := 16; Rate := 22050; BlockAlign := 0;
  while p + 8 <= EndP do
  begin
    Move(p^, ChunkId, 4);
    ChunkSize := PUInt32(p + 4)^;
    Inc(p, 8);
    if (ChunkId = 'fmt ') and (ChunkSize >= 16) and (p + 16 <= EndP) then
    begin
      Fmt := p;
      FmtSize := ChunkSize;
      if p + FmtSize > EndP then
        FmtSize := EndP - p;
      FormatTag := PUInt16(p)^;
      Channels := PUInt16(p + 2)^;
      Rate := PUInt32(p + 4)^;
      BlockAlign := PUInt16(p + 12)^;
      Bits := PUInt16(p + 14)^;
      if (FormatTag = WAVE_FORMAT_EXTENSIBLE) and (FmtSize >= 26) then
        FormatTag := PUInt16(p + 24)^;
    end
    else if (ChunkId = 'fact') and (ChunkSize >= 4) and (p + 4 <= EndP) then
      FactFrames := PUInt32(p)^
    else if (ChunkId = 'data') and (Fmt <> nil) then
    begin
      if p + ChunkSize > EndP then
        ChunkSize := EndP - p;
      if (Channels = 0) or (Rate = 0) then
        Break;
      FillChar(spec^, SizeOf(spec^), 0);
      spec^.freq := Rate;
      spec^.channels := Channels;

      case FormatTag of
        WAVE_FORMAT_PCM, WAVE_FORMAT_IEEE_FLOAT:
          begin
            if (FormatTag = WAVE_FORMAT_IEEE_FLOAT) and (Bits <> 32) then
              Break;
            case Bits of
              8: spec^.format := AUDIO_U8;
              16: spec^.format := AUDIO_S16LSB;
              24: spec^.format := AUDIO_S16LSB;  // converted below
              32: if FormatTag = WAVE_FORMAT_IEEE_FLOAT then
                    spec^.format := AUDIO_F32LSB
                  else
                    spec^.format := AUDIO_S32LSB;
            else
              Break;
            end;
            if Bits = 24 then
            begin
              // keep the upper 16 bits of each sample
              Count := ChunkSize div 3;
              if Count = 0 then
                Break;
              GetMem(audio_buf^, Count * 2 + 1);
              Out16 := PSmallIntArray(audio_buf^);
              for i := 0 to Count - 1 do
                Out16^[i] := SmallInt(p[i * 3 + 1] or (p[i * 3 + 2] shl 8));
              audio_len^ := Count * 2;
            end
            else
            begin
              GetMem(audio_buf^, ChunkSize + 1);
              Move(p^, audio_buf^^, ChunkSize);
              audio_len^ := ChunkSize;
            end;
          end;
        WAVE_FORMAT_ADPCM, WAVE_FORMAT_IMA_ADPCM:
          begin
            if (Bits <> 4) or (BlockAlign = 0) then
              Break;
            // upper bound: two samples per byte plus the block headers' samples
            Frames := (ChunkSize div BlockAlign + 1) * (UInt32(BlockAlign) * 2 div Channels + 2);
            if (FactFrames > 0) and (FactFrames < Frames) then
              Frames := FactFrames;
            GetMem(audio_buf^, Frames * Channels * 2 + 1);
            Out16 := PSmallIntArray(audio_buf^);
            if FormatTag = WAVE_FORMAT_ADPCM then
              Frames := DecodeMSADPCM(Fmt, FmtSize, p, ChunkSize, Channels, Frames, Out16)
            else
              Frames := DecodeIMAADPCM(Fmt, FmtSize, p, ChunkSize, Channels, Frames, Out16);
            if Frames = 0 then
            begin
              FreeMem(audio_buf^);
              audio_buf^ := nil;
              Break;
            end;
            spec^.format := AUDIO_S16LSB;
            audio_len^ := Frames * Channels * 2;
          end;
      else
        Break;  // unsupported encoding: no sound rather than noise
      end;
      Result := spec;
      Break;
    end;
    Inc(p, ChunkSize + (ChunkSize and 1));
  end;
  if freesrc <> 0 then
    SDL_RWclose(src);
end;

procedure SDL_FreeWAV(audio_buf: PUInt8);
begin
  if audio_buf <> nil then
    FreeMem(audio_buf);
end;

function SDL_LoadBMP_RW(src: PSDL_RWops; freesrc: SInt32): PSDL_Surface;
begin
  Result := nil;
  if freesrc <> 0 then
    SDL_RWclose(src);
end;

procedure SDL_FreeSurface(surface: PSDL_Surface);
begin
end;

end.
