{*******************************************************}
{                                                       }
{       SOLDAT spectator (WebAssembly)                  }
{                                                       }
{       Copyright (c) 2001 Michal Marcinkowski          }
{                                                       }
{*******************************************************}

library soldatspectate;

uses
  WebWideString,  // WideString/UnicodeString conversions (no libc iconv in wasm)
  WebCodePage,
  CHeap,
  CLibs,
  SysUtils,
  Client in 'client/Client.pas',
  WebMain,
  Spectator in 'spectator/Spectator.pas';

{$I WebExports.inc}

procedure soldat_spectator_follow(Slot: LongInt); cdecl;
begin
  SpectatorFollow(Slot);
end;

procedure soldat_spectator_zoom(Z, FX, FY: Single); cdecl;
begin
  SpectatorZoom(Z, FX, FY);
end;

procedure soldat_spectator_pan(DX, DY: Single); cdecl;
begin
  SpectatorPan(DX, DY);
end;

function soldat_spectator_overview: Single; cdecl;
begin
  Result := SpectatorOverview;
end;

function soldat_spectator_frame(A, B: LongInt; Mix: Single): Single; cdecl;
begin
  Result := SpectatorFrame(A, B, Mix);
end;

procedure soldat_spectator_set(Name, Value: PAnsiChar); cdecl;
begin
  SpectatorSet(Name, Value);
end;

function soldat_spectator_state(Buf: PAnsiChar; Size: LongInt): LongInt; cdecl;
begin
  Result := SpectatorState(Buf, Size);
end;

function soldat_spectator_events(Buf: PAnsiChar; Size: LongInt): LongInt; cdecl;
begin
  Result := SpectatorEvents(Buf, Size);
end;

procedure soldat_spectator_speed(Speed: Single); cdecl;
begin
  SpectatorSpeed(Speed);
end;

procedure soldat_spectator_rewind; cdecl;
begin
  SpectatorRewind;
end;

procedure soldat_spectator_mouse(DX, DY: Single; Held: LongInt); cdecl;
begin
  SpectatorMouse(DX, DY, Held);
end;

exports
  soldat_spectator_speed,
  soldat_spectator_rewind,
  soldat_spectator_events,
  soldat_spectator_follow,
  soldat_spectator_zoom,
  soldat_spectator_pan,
  soldat_spectator_overview,
  soldat_spectator_frame,
  soldat_spectator_state,
  soldat_spectator_set,
  soldat_spectator_mouse;

begin
  DefaultSystemCodePage := CP_UTF8;
  SpectatorInit;
end.
