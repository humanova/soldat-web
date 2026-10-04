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

// What happened since the page last asked: chat, flag and vote events. The game does not show
// these itself in this build (no console, no chat bubbles, no big flag messages); the
// page does. Shared code calls these through SPECTATOR hooks.
const
  CHAT_PUBLIC = 0;
  CHAT_TEAM = 1;
  CHAT_RADIO = 2;
  CHAT_SERVER = 3;
  FLAG_TAKEN = 'take';
  FLAG_DROPPED = 'drop';
  FLAG_RETURNED = 'return';
  FLAG_SCORED = 'score';
// Slot 0 for the server
procedure SpectatorChat(Slot, Kind: Integer; const Text: WideString);
// Team: the flag's team (1 red, 2 blue, 3 yellow); for FLAG_SCORED the team that scored
procedure SpectatorFlag(const Kind: AnsiString; Team, Slot: Integer);
// a player was voted off the server (before the client forgets them)
procedure SpectatorVoteKicked(Slot: Integer);
// the server announced the next map (a map vote passed, or the map ended)
procedure SpectatorNextMap(const Name: string);
// moves the queued events into Buf (UTF-8 lines, see SpectatorEvents in the .pas) and
// returns their length; keeps them when they do not fit
function SpectatorEvents(Buf: PAnsiChar; Size: LongInt): LongInt;

const
  MIN_ZOOM = -0.9;
  MAX_ZOOM = 1.6;

implementation

uses
  SysUtils, Math, Client, ClientGame, Game, Sprites, Things, Constants, Cvar, Net;

var
  Events: AnsiString = '';
  LastEvent: AnsiString = '';
  LastEventTick: Integer = 0;

procedure SpectatorInit;
begin
end;

function CleanW(const S: WideString): AnsiString;
var
  i: Integer;
begin
  Result := UTF8Encode(S);
  for i := 1 to Length(Result) do
    if Result[i] < ' ' then
      Result[i] := ' ';
end;

procedure QueueEvent(const Line: AnsiString);
begin
  // the same event can reach the client twice (its own flag code and the server's)
  if (Line = LastEvent) and (MainTickCounter - LastEventTick < 120) then
    Exit;
  LastEvent := Line;
  LastEventTick := MainTickCounter;
  // the page drains this four times a second; never let it grow without bound
  if Length(Events) > 32768 then
    Events := '';
  Events := Events + Line + #10;
end;

function SlotName(Slot: Integer): WideString;
begin
  if (Slot >= 1) and (Slot <= MAX_SPRITES) then
    Result := WideString(Sprite[Slot].Player.Name)
  else
    Result := '';
end;

function SlotTeam(Slot: Integer): Integer;
begin
  if (Slot >= 1) and (Slot <= MAX_SPRITES) then
    Result := Sprite[Slot].Player.Team
  else
    Result := 0;
end;

// C  slot  team  kind (CHAT_*)  name  text
procedure SpectatorChat(Slot, Kind: Integer; const Text: WideString);
begin
  QueueEvent(Format('C'#9'%d'#9'%d'#9'%d'#9'%s'#9'%s',
    [Slot, SlotTeam(Slot), Kind, CleanW(SlotName(Slot)), CleanW(Text)]));
end;

// F  kind (FLAG_*)  team  slot  player team  name
procedure SpectatorFlag(const Kind: AnsiString; Team, Slot: Integer);
begin
  QueueEvent(Format('F'#9'%s'#9'%d'#9'%d'#9'%d'#9'%s',
    [Kind, Team, Slot, SlotTeam(Slot), CleanW(SlotName(Slot))]));
end;

// K  slot  team  name
procedure SpectatorVoteKicked(Slot: Integer);
begin
  QueueEvent(Format('K'#9'%d'#9'%d'#9'%s', [Slot, SlotTeam(Slot), CleanW(SlotName(Slot))]));
end;

// N  map
procedure SpectatorNextMap(const Name: string);
begin
  QueueEvent('N'#9 + Name);
end;

function SpectatorEvents(Buf: PAnsiChar; Size: LongInt): LongInt;
begin
  Result := Length(Events);
  if (Result = 0) or (Result + 1 > Size) then
    Exit(0);
  Move(Events[1], Buf^, Result);
  Buf[Result] := #0;
  Events := '';
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
//   P  slot  team  kills  deaths  caps  dead  carries a flag  health %  shirt (hex)  weapon number
//      weapon  name
//   S  slot  name   (the other spectators; the hub's own one is the page)
//   G  flag (1 red, 2 blue, 3 yellow)  state (0 in base, 1 carried, 2 dropped)  carrier slot
//   V  type (0 map, 1 kick)  seconds left  target slot (kick)  target team  target (player or
//      map)  started by  reason   (a vote is on; the game's own vote box is not drawn)
function SpectatorState(Buf: PAnsiChar; Size: LongInt): LongInt;
var
  S, Target: AnsiString;
  i, Flag, State, Slot: Integer;
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
        S := S + Format('P'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%d'#9'%.6x'#9'%d'#9'%s'#9'%s'#10,
          [i, Player.Team, Player.Kills, Player.Deaths, Player.Flags, Integer(DeadMeat), Flag,
           EnsureRange(Round(100 * Health / StartHealth), 0, 100), Player.ShirtColor and $FFFFFF,
           Weapon.Num, Clean(Weapon.Name), Clean(Player.Name)]);
      end
      else if Active and (i <> MySprite) then
        S := S + Format('S'#9'%d'#9'%s'#10, [i, Clean(Player.Name)]);
  for i := 1 to 2 do
    if (TeamFlag[i] > 0) and (TeamFlag[i] <= MAX_THINGS) then
      with Thing[TeamFlag[i]] do
        if Active and (Style in [OBJECT_ALPHA_FLAG, OBJECT_BRAVO_FLAG, OBJECT_POINTMATCH_FLAG]) then
        begin
          if HoldingSprite > 0 then
            State := 1
          else if InBase then
            State := 0
          else
            State := 2;
          S := S + Format('G'#9'%d'#9'%d'#9'%d'#10, [Style, State, HoldingSprite]);
        end;
  if VoteActive then
  begin
    Slot := 0;
    Target := VoteTarget;
    if VoteType = VOTE_KICK then
    begin
      Slot := StrToIntDef(VoteTarget, 0);
      if (Slot < 1) or (Slot > MAX_SPRITES) then
        Slot := 0
      else
        Target := Sprite[Slot].Player.Name;
    end;
    S := S + Format('V'#9'%d'#9'%d'#9'%d'#9'%d'#9'%s'#9'%s'#9'%s'#10,
      [VoteType, Max(0, (VoteTimeRemaining + 59) div 60), Slot, SlotTeam(Slot), Clean(Target),
       Clean(VoteStarter), Clean(VoteReason)]);
  end;
  Result := Length(S);
  if Result + 1 > Size then
    Exit(0);
  Move(S[1], Buf^, Result);
  Buf[Result] := #0;
end;

end.
