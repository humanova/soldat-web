{
  Entry points called by the JavaScript runtime (web/js/soldat.js).

  The browser owns the main loop: WebFrame runs one iteration of the
  original game loop (network, input, simulation ticks, rendering) per
  animation frame and reports when the player went back to the launcher.
}
unit WebMain;

{$mode delphi}

interface

procedure WebStart; cdecl;
function WebJoin(Host: PAnsiChar; Port: LongInt; Password: PAnsiChar): LongInt; cdecl;
function WebFrame: LongInt; cdecl;
procedure WebLeave; cdecl;
procedure WebCommand(Cmd: PAnsiChar); cdecl;
function WebMalloc(Size: LongInt): Pointer; cdecl;
procedure WebFree(P: Pointer); cdecl;

implementation

uses
  SysUtils, Client, ClientGame, ControlGame, GameRendering, Net, Command, TraceLog;

var
  Started: Boolean = False;

procedure WebStart; cdecl;
begin
  if Started then
    Exit;
  Started := True;
  StartGame;
end;

function WebJoin(Host: PAnsiChar; Port: LongInt; Password: PAnsiChar): LongInt; cdecl;
begin
  Result := 0;
  if not Started then
    Exit;
  JoinIP := AnsiString(Host);
  JoinPort := IntToStr(Port);
  JoinPassword := AnsiString(Password);
  JoinServer;
  if GameLoopRun then
    Result := 1;
end;

// 0 = keep calling, 1 = the game is over (back to the launcher)
function WebFrame: LongInt; cdecl;
begin
  if not GameLoopRun then
    Exit(1);
  try
    if Assigned(UDP) then
      UDP.ProcessLoop;
    if GameLoopRun then
      GameInput();
    if GameLoopRun then
      GameLoop();
    // disconnected while the screen still shows the game (kicked, server gone,
    // "Exit" commands): go back to the server list
    if GameLoopRun and Assigned(UDP) and (not UDP.Active) and (not ShouldRenderFrames) and
      (not GameInfoShown) then
      GameLoopRun := False;
  except
    on E: Exception do
      WriteLn('[WEB] Exception in frame: ' + E.ClassName + ': ' + E.Message);
  end;
  if GameLoopRun then
    Result := 0
  else
    Result := 1;
end;

procedure WebLeave; cdecl;
begin
  LeaveToLauncher;
end;

procedure WebCommand(Cmd: PAnsiChar); cdecl;
begin
  ParseInput(AnsiString(Cmd));
end;

function WebMalloc(Size: LongInt): Pointer; cdecl;
begin
  Result := GetMem(Size);
end;

procedure WebFree(P: Pointer); cdecl;
begin
  FreeMem(P);
end;

end.
