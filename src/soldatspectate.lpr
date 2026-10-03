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

procedure soldat_spectator_set(Name, Value: PAnsiChar); cdecl;
begin
  SpectatorSet(Name, Value);
end;

function soldat_spectator_state(Buf: PAnsiChar; Size: LongInt): LongInt; cdecl;
begin
  Result := SpectatorState(Buf, Size);
end;

exports
  soldat_spectator_follow,
  soldat_spectator_zoom,
  soldat_spectator_pan,
  soldat_spectator_overview,
  soldat_spectator_state,
  soldat_spectator_set;

begin
  DefaultSystemCodePage := CP_UTF8;
  SpectatorInit;
end.
