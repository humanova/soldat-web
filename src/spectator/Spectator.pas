{
  Spectator build (-dSPECTATOR, soldatspectate.lpr): watches a match that the
  spectator hub (relay/spectator.mjs) streams to the page. The page never talks
  to the game server itself; this unit holds the spectator-only behaviour that
  shared code reaches through small SPECTATOR conditional hooks, and the
  routines the page calls. The game's own keys and mouse are ignored in this
  build (ControlGame.GameInput): the page drives the camera through these.
}
unit Spectator;

{$mode delphi}

interface

procedure SpectatorInit;
// follow a player (slot 1..32); 0 switches to the free camera
procedure SpectatorFollow(Slot: LongInt);
// view scale exp(Z) of the normal view (below 0 zooms in, above 0 out). In the free
// camera the point at (FX, FY) (fractions of the screen) stays where it is.
procedure SpectatorZoom(Z, FX, FY: Single);
// moves the free camera by fractions of the screen (switches to the free camera)
procedure SpectatorPan(DX, DY: Single);
// centers the free camera on the map; returns the zoom that shows all of it
function SpectatorOverview: Single;
// sets a client setting without the console's "is now set to" line
procedure SpectatorSet(Name, Value: PAnsiChar);
// writes a text snapshot of the match into Buf (see SpectatorState in the .pas), returns
// its length (0 when it does not fit)
function SpectatorState(Buf: PAnsiChar; Size: LongInt): LongInt;

const
  MIN_ZOOM = -0.9;
  MAX_ZOOM = 1.6;

implementation

uses
  SysUtils, Math, Client, ClientGame, Game, Sprites, Things, Constants, Cvar;

procedure SpectatorInit;
begin
end;

procedure CenterMouse;
begin
  // the camera adds the mouse's offset from the screen center; keep it there
  mx := GameWidthHalf;
  my := GameHeightHalf;
end;

procedure SpectatorFollow(Slot: LongInt);
begin
  CenterMouse;
  if Slot = 0 then
    CameraFollowSprite := 0
  else if (Slot >= 1) and (Slot <= MAX_SPRITES) and Sprite[Slot].Active and
    Sprite[Slot].IsNotSpectator() then
    CameraFollowSprite := Slot;
end;

procedure SpectatorZoom(Z, FX, FY: Single);
var
  Old: Single;
begin
  CenterMouse;
  Z := EnsureRange(Z, MIN_ZOOM, MAX_ZOOM);
  Old := r_zoom.Value;
  r_zoom.SetValue(Z);
  if CameraFollowSprite = 0 then
  begin
    CameraX := CameraX + (FX - 0.5) * (exp(Old) - exp(Z)) * GameWidth;
    CameraY := CameraY + (FY - 0.5) * (exp(Old) - exp(Z)) * GameHeight;
  end;
end;

procedure SpectatorPan(DX, DY: Single);
begin
  CenterMouse;
  CameraFollowSprite := 0;
  CameraX := CameraX + DX * exp(r_zoom.Value) * GameWidth;
  CameraY := CameraY + DY * exp(r_zoom.Value) * GameHeight;
end;

function SpectatorOverview: Single;
var
  i, j: Integer;
  MinX, MinY, MaxX, MaxY: Single;
begin
  Result := 0;
  if Map.PolyCount = 0 then
    Exit;
  MinX := MaxSingle; MinY := MaxSingle; MaxX := -MaxSingle; MaxY := -MaxSingle;
  for i := 1 to Map.PolyCount do
    for j := 1 to 3 do
      with Map.Polys[i].Vertices[j] do
      begin
        MinX := Min(MinX, x); MaxX := Max(MaxX, x);
        MinY := Min(MinY, y); MaxY := Max(MaxY, y);
      end;
  CenterMouse;
  CameraFollowSprite := 0;
  CameraX := (MinX + MaxX) / 2;
  CameraY := (MinY + MaxY) / 2;
  Result := EnsureRange(Ln(Max(1, Max((MaxX - MinX) * 1.05 / GameWidth,
    (MaxY - MinY) * 1.05 / GameHeight))), MIN_ZOOM, MAX_ZOOM);
end;

procedure SpectatorSet(Name, Value: PAnsiChar);
var
  C: TCvarBase;
begin
  C := TCvarBase.Find(AnsiString(Name));
  if (C <> nil) and (CVAR_CLIENT in C.Flags) then
    C.ParseAndSetValue(AnsiString(Value));
end;

function Clean(const S: string): string;
var
  i: Integer;
begin
  Result := S;
  for i := 1 to Length(Result) do
    if Result[i] < ' ' then
      Result[i] := ' ';
end;

// One line per item, fields separated by tabs:
//   M  gamestyle  map  seconds left  alpha  bravo  charlie  delta  followed slot  zoom
//   P  slot  team  kills  deaths  caps  dead  carries a flag  health %  shirt (hex)  weapon  name
function SpectatorState(Buf: PAnsiChar; Size: LongInt): LongInt;
var
  S: AnsiString;
  i, Flag: Integer;
begin
  S := Format('M'#9'%d'#9'%s'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%.3f'#10,
    [sv_gamemode.Value, Clean(Map.Name), TimeLimitCounter div 60, TeamScore[1], TeamScore[2],
     TeamScore[3], TeamScore[4], CameraFollowSprite, r_zoom.Value], DefaultFormatSettings);
  for i := 1 to MAX_SPRITES do
    with Sprite[i] do
      if Active and IsNotSpectator() then
      begin
        Flag := 0;
        if (HoldedThing > 0) and (HoldedThing <= MAX_THINGS) and
          (Thing[HoldedThing].Style in [OBJECT_ALPHA_FLAG, OBJECT_BRAVO_FLAG, OBJECT_POINTMATCH_FLAG]) then
          Flag := Thing[HoldedThing].Style;
        S := S + Format('P'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%.6x'#9'%s'#9'%s'#10,
          [i, Player.Team, Player.Kills, Player.Deaths, Player.Flags, Integer(DeadMeat), Flag,
           EnsureRange(Round(100 * Health / StartHealth), 0, 100), Player.ShirtColor and $FFFFFF,
           Clean(Weapon.Name), Clean(Player.Name)]);
      end;
  Result := Length(S);
  if Result + 1 > Size then
    Exit(0);
  Move(S[1], Buf^, Result);
  Buf[Result] := #0;
end;

end.
