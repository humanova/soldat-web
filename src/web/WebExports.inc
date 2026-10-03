{
  Entry points shared by the game (soldatweb.lpr) and the spectator
  (soldatspectate.lpr). The wasm target only exports routines declared in the
  library file itself, hence these thin wrappers around WebMain, included there.
}

procedure soldat_start; cdecl;
begin
  WebStart;
end;

function soldat_join(Host: PAnsiChar; Port: LongInt; Password: PAnsiChar): LongInt; cdecl;
begin
  Result := WebJoin(Host, Port, Password);
end;

function soldat_frame: LongInt; cdecl;
begin
  Result := WebFrame;
end;

procedure soldat_leave; cdecl;
begin
  WebLeave;
end;

procedure soldat_command(Cmd: PAnsiChar); cdecl;
begin
  WebCommand(Cmd);
end;

function soldat_malloc(Size: LongInt): Pointer; cdecl;
begin
  Result := WebMalloc(Size);
end;

procedure soldat_free(P: Pointer); cdecl;
begin
  WebFree(P);
end;

exports
  soldat_start,
  soldat_join,
  soldat_frame,
  soldat_leave,
  soldat_command,
  soldat_malloc,
  soldat_free;
