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

exports
  soldat_spectator_follow;

begin
  DefaultSystemCodePage := CP_UTF8;
  SpectatorInit;
end.
