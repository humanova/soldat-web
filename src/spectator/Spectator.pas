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
// follow a player (slot 1..32); 0 switches to the free camera; below 0 lets the game pick
// (a new match). The page's choice holds: the game's own camera changes (joining, a jump
// in a replay) are undone each tick, and a player who cannot be followed for a moment
// (gone from the server) leaves the camera where it is until they are back.
procedure SpectatorFollow(Slot: LongInt);
// view scale exp(Z) of the normal view (below 0 zooms in, above 0 out). In the free
// camera the point at (FX, FY) (fractions of the screen) stays where it is.
procedure SpectatorZoom(Z, FX, FY: Single);
// moves the free camera by fractions of the screen (switches to the free camera)
procedure SpectatorPan(DX, DY: Single);
// centers the free camera on the map; returns the zoom that shows all of it
function SpectatorOverview: Single;
// a shot from afar: while the camera follows player A, it aims Mix of the way from A to
// player B (0 at A, 0.5 between them). Returns the zoom that shows both from between them,
// or below MIN_ZOOM when one of them cannot be followed. A = 0 aims at the followed player
// again, as do the page's other camera moves.
function SpectatorFrame(A, B: LongInt; Mix: Single): Single;
// where the camera aims while it follows Slot, whose sprite is at X, Y (Update_Frame)
procedure SpectatorAim(Slot: Integer; var X, Y: Single);
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

// Replays (js/spectate/replay.js plays a recorded match in place of the hub): the game
// clock's speed (1 normal, 0 holds the match), and a jump in time: the client forgets
// the world and takes the next PlayersList the page hands it, as on joining.
procedure SpectatorSpeed(Speed: Single);
procedure SpectatorRewind;
// a tick of a paused replay: the camera follows its player (ClientGame.GameLoop)
procedure SpectatorCameraTick;
// each tick, before the game's update, and before each picture: the camera the page chose
// (ClientGame.GameLoop)
procedure SpectatorKeepCamera;

const
  MIN_ZOOM = -0.9;
  MAX_ZOOM = 1.6;

// The game's free camera, steered by the mouse: while the page holds the mouse (pointer
// lock), its movement moves the game's cursor as in the game (ControlGame's
// SDL_MOUSEMOTION) and the camera flows towards it (Update_Frame). Held 0 lets go: the
// cursor back in the middle, the camera still. Moving by 0, 0 puts the cursor back where it
// was after the other calls centered it.
procedure SpectatorMouse(DX, DY: Single; Held: LongInt);

// The auto camera (the page's Auto). The hub's director picks whom to follow; this frames
// them and the enemies they fight, zooms to show them, leads where they run, eases its moves
// and cuts (a quick fade through black) to a pick far from the picture. On: Bias is the
// viewer's own zoom, on top of the camera's (SpectatorZoom changes it). Off: the zoom stays
// where the camera had it. Returns the zoom.
function SpectatorAuto(On: LongInt; Bias: Single): Single;
// whether the auto camera moves the camera this tick (Update_Frame: in place of following)
function SpectatorOperating: Boolean;
procedure SpectatorOperate;
// each frame: the auto camera's zoom eases on, Dt seconds after the last
procedure SpectatorFrameZoom(Dt: Single);
// how dark a cut has the picture (0 to 1)
function SpectatorFade: Single;

implementation

uses
  SysUtils, Math, Client, ClientGame, Game, Sprites, Things, Bullets, Sparks, Constants, Cvar, Net,
  Vector, InterfaceGraphics, SpectatorGraphics;

var
  Events: AnsiString = '';
  LastEvent: AnsiString = '';
  LastEventTick: Integer = 0;
  Wanted: Integer = -1;        // the page's camera: a slot, 0 the free camera, -1 the game's
  KeepPlace: Boolean = False;  // a replay jumped: the camera stays where it was while rejoining
  KeptX, KeptY, KeptZoom: Single;
  KeptJoined: Integer;         // calls since the PlayersList, without the own player yet
  FrameA: Integer = 0;         // SpectatorFrame
  FrameB: Integer = 0;
  FrameMix: Single = 0;
  // the auto camera
  AutoOn: Boolean = False;
  AutoBias: Single = 0;      // the viewer's zoom on top
  AutoSlot: Integer = 0;     // whom it framed last tick (0: no one yet, a new start)
  AutoZoom: Single = 0;      // its own zoom, eased each frame towards GoalZ
  GoalX, GoalY, GoalZ: Single;  // where the springs pull; the dead zones hold them still
  VelX, VelY, VelZ: Single;  // the springs' speeds
  LeadX, LeadY: Single;      // the followed player's velocity, smoothed
  CutTicks: Integer = 0;     // a cut: down through the fade, the jump when it is black
  Shown: array[1..MAX_SPRITES] of Boolean;  // the enemies in the picture with the followed player
  ZoomInWait: Integer = 0;   // ticks the picture could have been closer

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

procedure SpectatorSpeed(Speed: Single);
begin
  ReplayHeld := Speed <= 0;
  if ReplayHeld then
    GOALTICKS := DEFAULT_GOALTICKS
  else
    GOALTICKS := EnsureRange(Round(DEFAULT_GOALTICKS * Speed), 1, DEFAULT_GOALTICKS * 32);
end;

procedure CenterMouse;
begin
  // the camera adds the mouse's offset from the screen center; keep it there
  mx := GameWidthHalf;
  my := GameHeightHalf;
end;

function Followable(Slot: Integer): Boolean;
begin
  Result := (Slot >= 1) and (Slot <= MAX_SPRITES) and Sprite[Slot].Active and
    Sprite[Slot].IsNotSpectator();
end;

// while a jump rejoins: the camera and zoom to keep (also where the page moved them meanwhile)
procedure KeepHere;
begin
  if KeepPlace then
  begin
    KeptX := CameraX;
    KeptY := CameraY;
    KeptZoom := r_zoom.Value;
  end;
end;

procedure SpectatorKeepCamera;
begin
  if KeepPlace then
  begin
    // joining puts the camera at the map's origin, and the own player's arrival (a new one
    // to the client: the PlayersList forgot it) resets the zoom
    CameraX := KeptX;
    CameraY := KeptY;
    CameraPrev.X := KeptX;
    CameraPrev.Y := KeptY;
    if (MySprite > 0) and not SameValue(r_zoom.Value, KeptZoom) then
      r_zoom.SetValue(KeptZoom);
    // joined: the PlayersList taken and the own player back (a demo without it: soon after)
    if (MySprite > 0) and not RequestingGame then
    begin
      Inc(KeptJoined);
      if ClientPlayerReceived or (KeptJoined > 60) then
        KeepPlace := False;
    end;
  end;
  if Wanted = 0 then
    CameraFollowSprite := 0
  else if Wanted > 0 then
  begin
    if Followable(Wanted) then
    begin
      if CameraFollowSprite <> Wanted then
        CenterMouse;
      CameraFollowSprite := Wanted;
    end
    else
      CameraFollowSprite := 0;
  end;
end;

procedure SpectatorCameraTick;
var
  X, Y: Single;
begin
  SpectatorKeepCamera;
  CameraPrev.X := CameraX;
  CameraPrev.Y := CameraY;
  if SpectatorOperating then
  begin
    SpectatorOperate;
    Exit;
  end;
  // as Update_Frame, with the mouse in the middle
  if (CameraFollowSprite > 0) and (CameraFollowSprite <= MAX_SPRITES) and
    Sprite[CameraFollowSprite].Active then
  begin
    X := SpriteParts.Pos[CameraFollowSprite].X;
    Y := SpriteParts.Pos[CameraFollowSprite].Y;
    SpectatorAim(CameraFollowSprite, X, Y);
    CameraX := CameraX + (X - CameraX) * CAMSPEED;
    CameraY := CameraY + (Y - CameraY) * CAMSPEED;
  end;
end;

procedure SpectatorRewind;
var
  i: Integer;
begin
  // the PlayersList replaces the players; what else is in the air goes now
  for i := 1 to MAX_BULLETS do
    Bullet[i].Kill;
  for i := 1 to MAX_SPARKS do
    Spark[i].Kill;
  for i := 1 to MAX_THINGS do
    Thing[i].Kill;
  for i := 0 to MAX_BIG_MESSAGES do
  begin
    BigText[i] := '';
    BigDelay[i] := 0;
    WorldText[i] := '';
    WorldDelay[i] := 0;
  end;
  for i := 1 to MAX_SPRITES do
  begin
    ChatDelay[i] := 0;
    ChatMessage[i] := '';
  end;
  KillConsole.Count := 0;
  MainConsole.Count := 0;
  BigConsole.Count := 0;
  if VoteActive then
    StopVote;
  Events := '';
  LastEvent := '';
  SpectatorGraphicsClear;
  // a jump while the last one still rejoins keeps the place from before that one (the
  // camera may be at the map's origin until the next tick)
  if not KeepPlace then
  begin
    KeepPlace := True;
    KeepHere;
  end;
  KeptJoined := 0;
  RequestingGame := True;
  RequestGameRetryTicks := 3 * 60;
end;

procedure SpectatorFollow(Slot: LongInt);
begin
  CenterMouse;
  FrameA := 0;
  if Slot < 0 then
  begin
    Wanted := -1;
    KeepPlace := False;
  end
  else if Slot = 0 then
  begin
    Wanted := 0;
    CameraFollowSprite := 0;
  end
  else if Slot <= MAX_SPRITES then
  begin
    Wanted := Slot;
    if Followable(Slot) then
      CameraFollowSprite := Slot;
  end;
end;

procedure SpectatorZoom(Z, FX, FY: Single);
var
  Old: Single;
begin
  CenterMouse;
  Z := EnsureRange(Z, MIN_ZOOM, MAX_ZOOM);
  if AutoOn then
  begin
    AutoBias := Z;
    Exit;
  end;
  Old := r_zoom.Value;
  r_zoom.SetValue(Z);
  if CameraFollowSprite = 0 then
  begin
    CameraX := CameraX + (FX - 0.5) * (exp(Old) - exp(Z)) * GameWidth;
    CameraY := CameraY + (FY - 0.5) * (exp(Old) - exp(Z)) * GameHeight;
  end;
  KeepHere;
end;

procedure SpectatorPan(DX, DY: Single);
begin
  CenterMouse;
  FrameA := 0;
  Wanted := 0;
  AutoOn := False;
  CameraFollowSprite := 0;
  CameraX := CameraX + DX * exp(r_zoom.Value) * GameWidth;
  CameraY := CameraY + DY * exp(r_zoom.Value) * GameHeight;
  KeepHere;
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
  FrameA := 0;
  Wanted := 0;
  AutoOn := False;
  CameraFollowSprite := 0;
  CameraX := (MinX + MaxX) / 2;
  CameraY := (MinY + MaxY) / 2;
  KeepHere;
  Result := EnsureRange(Ln(Max(1, Max((MaxX - MinX) * 1.05 / GameWidth,
    (MaxY - MinY) * 1.05 / GameHeight))), MIN_ZOOM, MAX_ZOOM);
end;

function SpectatorFrame(A, B: LongInt; Mix: Single): Single;
const
  // around each of them: their bodies, and room to see where they are
  MARGIN_X = 90;
  MARGIN_Y = 80;
begin
  Result := MIN_ZOOM - 1;
  FrameA := 0;
  if (A = B) or not Followable(A) or not Followable(B) then
    Exit;
  FrameA := A;
  FrameB := B;
  FrameMix := EnsureRange(Mix, 0, 1);
  Result := Ln(Max(
    (Abs(SpriteParts.Pos[B].X - SpriteParts.Pos[A].X) + 2 * MARGIN_X) / GameWidth,
    (Abs(SpriteParts.Pos[B].Y - SpriteParts.Pos[A].Y) + 2 * MARGIN_Y) / GameHeight));
end;

procedure SpectatorAim(Slot: Integer; var X, Y: Single);
begin
  if (FrameA = 0) or (Slot <> FrameA) or not Followable(FrameB) then
    Exit;
  X := X + (SpriteParts.Pos[FrameB].X - X) * FrameMix;
  Y := Y + (SpriteParts.Pos[FrameB].Y - Y) * FrameMix;
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

var
  MouseHeld: Boolean = False;
  HeldX, HeldY: Single;

procedure SpectatorMouse(DX, DY: Single; Held: LongInt);
begin
  if Held = 0 then
  begin
    MouseHeld := False;
    mx := GameWidthHalf;
    my := GameHeightHalf;
    Exit;
  end;
  if not MouseHeld then
  begin
    MouseHeld := True;
    HeldX := GameWidthHalf;
    HeldY := GameHeightHalf;
  end;
  HeldX := Max(0, Min(GameWidth, HeldX + DX * cl_sensitivity.Value));
  HeldY := Max(0, Min(GameHeight, HeldY + DY * cl_sensitivity.Value));
  mx := HeldX;
  my := HeldY;
end;

// ---------------------------------------------------------------- the auto camera

const
  AUTO_MARGIN_X = 150;       // room around each player in the picture
  AUTO_MARGIN_Y = 130;
  AUTO_FOCUS = 0.35;         // the middle of the picture is this much nearer the followed player
  AUTO_ENGAGE_X = 750;       // enemies this close to the followed player are shown too
  AUTO_ENGAGE_Y = 420;
  AUTO_ENGAGE_OUT = 1.25;    // ...and stay in it until this much farther
  AUTO_ZOOM_IN_WAIT = 90;    // ticks the picture could be closer before it gets closer
  AUTO_NEAR = 0.15;          // the zoom for one player standing
  AUTO_RUN = 0.3;            // ... running or flying at RUN_SPEED and faster
  AUTO_RUN_SPEED = 6;
  // the widest: about the area around the followed player that the server tells in detail
  AUTO_FAR = 0.7;
  AUTO_LEAD = 30;            // the picture is this many ticks ahead of where they run
  AUTO_LEAD_MAX = 0.22;      // at the most, of the picture
  AUTO_DEAD_ZONE = 0.05;     // of the picture: a move this small leaves the camera still
  AUTO_ZOOM_DEAD = 0.05;
  AUTO_PAN_TIME = 0.35;      // seconds, about, for the camera to get there
  AUTO_PAN_SPEED = 2.5;      // pictures a second at the most
  AUTO_ZOOM_IN_TIME = 1.8;   // slow in, quicker out: a fight that starts is in the picture
  AUTO_ZOOM_OUT_TIME = 0.55;
  AUTO_ZOOM_SPEED = 1.5;     // per second at the most
  AUTO_CUT_AT = 1.0;         // a pick farther than this (pictures) from the picture: a cut
  CUT_OUT = 7;               // ticks of the fade to black, then from black
  CUT_IN = 12;

function SpectatorAuto(On: LongInt; Bias: Single): Single;
begin
  Result := r_zoom.Value;
  AutoOn := On <> 0;
  AutoBias := EnsureRange(Bias, MIN_ZOOM, MAX_ZOOM);
  AutoSlot := 0;
  CutTicks := 0;
  if AutoOn then
  begin
    CenterMouse;
    FrameA := 0;
    AutoZoom := r_zoom.Value - AutoBias;
    GoalZ := AutoZoom;
    VelX := 0;
    VelY := 0;
    VelZ := 0;
  end;
end;

function SpectatorOperating: Boolean;
begin
  Result := AutoOn and not KeepPlace and (Wanted > 0) and (CameraFollowSprite = Wanted) and
    Followable(Wanted);
end;

// a critically damped spring: Cur gets to Goal in about Time seconds, at most MaxSpeed a
// second, its speed kept in Vel
function Spring(Cur, Goal: Single; var Vel: Single; Time, MaxSpeed, Dt: Single): Single;
var
  Omega, X, E, Change, Limit, Temp: Single;
begin
  Omega := 2 / Time;
  X := Omega * Dt;
  E := 1 / (1 + X + 0.48 * X * X + 0.235 * X * X * X);
  Limit := MaxSpeed * Time;
  Change := EnsureRange(Cur - Goal, -Limit, Limit);
  Temp := (Vel + Omega * Change) * Dt;
  Vel := (Vel - Omega * Temp) * E;
  Result := Cur - Change + (Change + Temp) * E;
  // no overshoot
  if (Goal - Cur > 0) = (Result > Goal) then
  begin
    Result := Goal;
    Vel := 0;
  end;
end;

function Enemies(i, j: Integer): Boolean;
begin
  Result := (Sprite[i].Player.Team = TEAM_NONE) or (Sprite[i].Player.Team <> Sprite[j].Player.Team);
end;

// the picture for Slot: its middle and zoom. The enemies close to them are in it too, the
// followed player nearer the middle than the rest.
procedure AutoFrame(Slot: Integer; out CX, CY, Z: Single);
var
  j, Others: Integer;
  P: TVector2;
  MinX, MinY, MaxX, MaxY, Dx, Dy, Speed, LX, LY, HX, HY: Single;
begin
  P := SpriteParts.Pos[Slot];
  MinX := P.X;
  MaxX := P.X;
  MinY := P.Y;
  MaxY := P.Y;
  Others := 0;
  for j := 1 to MAX_SPRITES do
    if (j <> Slot) and Followable(j) and not Sprite[j].DeadMeat and Enemies(Slot, j) then
    begin
      Dx := SpriteParts.Pos[j].X - P.X;
      Dy := SpriteParts.Pos[j].Y - P.Y;
      // in when this close, out only when a good deal farther
      Shown[j] := (Abs(Dx) < AUTO_ENGAGE_X * IfThen(Shown[j], AUTO_ENGAGE_OUT, 1)) and
        (Abs(Dy) < AUTO_ENGAGE_Y * IfThen(Shown[j], AUTO_ENGAGE_OUT, 1));
      if Shown[j] then
      begin
        MinX := Min(MinX, SpriteParts.Pos[j].X);
        MaxX := Max(MaxX, SpriteParts.Pos[j].X);
        MinY := Min(MinY, SpriteParts.Pos[j].Y);
        MaxY := Max(MaxY, SpriteParts.Pos[j].Y);
        Inc(Others);
      end;
    end;
  // the room ahead of where they run (less of it when others are in the picture too)
  LX := EnsureRange(LeadX * AUTO_LEAD, -AUTO_LEAD_MAX * GameWidth, AUTO_LEAD_MAX * GameWidth);
  LY := EnsureRange(LeadY * AUTO_LEAD, -AUTO_LEAD_MAX * GameHeight, AUTO_LEAD_MAX * GameHeight);
  if Others > 0 then
  begin
    LX := LX / 2;
    LY := LY / 2;
  end;
  CX := (MinX + MaxX) / 2 * (1 - AUTO_FOCUS) + P.X * AUTO_FOCUS + LX;
  CY := (MinY + MaxY) / 2 * (1 - AUTO_FOCUS) + P.Y * AUTO_FOCUS + LY;
  // as far out as it takes for all of them to fit around that middle
  HX := Max(MaxX - CX, CX - MinX) + AUTO_MARGIN_X;
  HY := Max(MaxY - CY, CY - MinY) + AUTO_MARGIN_Y;
  Speed := Sqrt(Sqr(LeadX) + Sqr(LeadY));
  Z := Ln(Max(2 * HX / GameWidth, 2 * HY / GameHeight));
  Z := Min(AUTO_FAR, Max(Z, AUTO_NEAR + (AUTO_RUN - AUTO_NEAR) * Min(1, Speed / AUTO_RUN_SPEED)));
  // too far apart for all: the followed player stays in the picture
  CX := EnsureRange(CX, P.X - exp(Z) * GameWidth * 0.38, P.X + exp(Z) * GameWidth * 0.38);
  CY := EnsureRange(CY, P.Y - exp(Z) * GameHeight * 0.36, P.Y + exp(Z) * GameHeight * 0.36);
end;

procedure SpectatorOperate;
const
  DT = 1 / DEFAULT_GOALTICKS;
var
  Slot: Integer;
  CX, CY, Z, W, H: Single;
  V: TVector2;
begin
  Slot := CameraFollowSprite;
  V := SpriteParts.Velocity[Slot];
  if Slot <> AutoSlot then
  begin
    LeadX := V.X;
    LeadY := V.Y;
    FillChar(Shown, SizeOf(Shown), 0);
  end
  else
  begin
    LeadX := LeadX + (V.X - LeadX) * 0.08;
    LeadY := LeadY + (V.Y - LeadY) * 0.08;
  end;
  AutoFrame(Slot, CX, CY, Z);
  W := exp(r_zoom.Value) * GameWidth;
  H := exp(r_zoom.Value) * GameHeight;

  // someone else: far from the picture a cut, else the camera goes over
  if Slot <> AutoSlot then
  begin
    if AutoSlot = 0 then
    begin
      GoalX := CameraX;
      GoalY := CameraY;
    end;
    if (Max(Abs(CX - CameraX) / W, Abs(CY - CameraY) / H) > AUTO_CUT_AT) and (CutTicks <= CUT_IN) then
      CutTicks := CUT_OUT + CUT_IN;
    AutoSlot := Slot;
  end;
  if CutTicks > 0 then
  begin
    Dec(CutTicks);
    // to black: the camera holds
    if CutTicks > CUT_IN then
      Exit;
    // black: the jump
    if CutTicks = CUT_IN then
    begin
      CameraX := CX;
      CameraY := CY;
      CameraPrev.X := CX;
      CameraPrev.Y := CY;
      GoalX := CX;
      GoalY := CY;
      GoalZ := Z;
      AutoZoom := Z;
      VelX := 0;
      VelY := 0;
      VelZ := 0;
      Exit;
    end;
  end;

  // the dead zones: small moves leave the goals where they are
  if CX > GoalX + AUTO_DEAD_ZONE * W then
    GoalX := CX - AUTO_DEAD_ZONE * W
  else if CX < GoalX - AUTO_DEAD_ZONE * W then
    GoalX := CX + AUTO_DEAD_ZONE * W;
  if CY > GoalY + AUTO_DEAD_ZONE * H then
    GoalY := CY - AUTO_DEAD_ZONE * H
  else if CY < GoalY - AUTO_DEAD_ZONE * H then
    GoalY := CY + AUTO_DEAD_ZONE * H;
  // out at once (a fight begins), in after a while (it may go on)
  if Z > GoalZ + AUTO_ZOOM_DEAD then
  begin
    GoalZ := Z - AUTO_ZOOM_DEAD;
    ZoomInWait := 0;
  end
  else if (Z < GoalZ - AUTO_ZOOM_DEAD) and not Sprite[Slot].DeadMeat then
  begin
    Inc(ZoomInWait);
    if ZoomInWait > AUTO_ZOOM_IN_WAIT then
      GoalZ := Z + AUTO_ZOOM_DEAD;
  end
  else
    ZoomInWait := 0;

  CameraX := Spring(CameraX, GoalX, VelX, AUTO_PAN_TIME, AUTO_PAN_SPEED * W, DT);
  CameraY := Spring(CameraY, GoalY, VelY, AUTO_PAN_TIME, AUTO_PAN_SPEED * H, DT);
end;

procedure SpectatorFrameZoom(Dt: Single);
begin
  if not AutoOn or (AutoSlot = 0) or KeepPlace then
    Exit;
  if (CutTicks = 0) or (CutTicks < CUT_IN) then
    AutoZoom := Spring(AutoZoom, GoalZ, VelZ, IfThen(GoalZ > AutoZoom, AUTO_ZOOM_OUT_TIME,
      AUTO_ZOOM_IN_TIME), AUTO_ZOOM_SPEED, EnsureRange(Dt, 0.001, 0.1));
  if not SameValue(r_zoom.Value, EnsureRange(AutoZoom + AutoBias, MIN_ZOOM, MAX_ZOOM)) then
    r_zoom.SetValue(EnsureRange(AutoZoom + AutoBias, MIN_ZOOM, MAX_ZOOM));
end;

function SpectatorFade: Single;
begin
  if CutTicks > CUT_IN then
    Result := (CUT_OUT + CUT_IN - CutTicks) / CUT_OUT
  else
    Result := CutTicks / CUT_IN;
end;

end.
