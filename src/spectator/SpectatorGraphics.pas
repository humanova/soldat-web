{
  The spectator's overlays in the match's world (Soldat TV): players behind scenery as
  silhouettes, bullet tracers, where players died, and the path of a flag carrier. The
  names and health bars are drawn with the other markers (InterfaceGraphics). Each one is a
  spec_* setting the page can turn off (Client.pas).
}
unit SpectatorGraphics;

{$mode delphi}

interface

uses
  Gfx;

const
  DEATH_TICKS = 5 * 60;  // how long a death stays marked

type
  TDeathMark = record
    X, Y: Single;
    Tick: Integer;
    Color: Cardinal;
  end;

var
  SpecTick: Integer = 0;  // the match's ticks seen here (a replay's jump starts again)
  DeathMarks: array[0..31] of TDeathMark;

// the team colours of the spectator page (spectate.css), and lighter ones for text
function SpectatorTeamColor(i: Integer; Light: Boolean): Cardinal;
function SpectatorFlagColor(Style: Integer): Cardinal;
function CarriesFlag(i: Integer): Integer;  // the style of the flag the player holds, or 0

procedure SpectatorGraphicsTick;   // a tick of the match: the deaths and the flag paths
procedure SpectatorGraphicsClear;  // a replay's jump: the match starts again here

// drawing helpers (any transform): a bar from A to B, coloured from CA to CB
procedure DrawSegment(ax, ay, bx, by, Width: Single; CA, CB: TGfxColor);
procedure DrawRect(x0, y0, x1, y1: Single; Color: TGfxColor);
procedure DrawCross(x, y, Size, Width: Single; Color: TGfxColor);
// an arrowhead (notched at the back) with its tip at (x, y), pointing along (dx, dy) (a unit
// vector), Len long and 2 Half wide
procedure DrawArrow(x, y, dx, dy, Len, Half: Single; Color: TGfxColor);

// in the world's transform, in a batch (GfxBegin)
procedure RenderFlagTrails;     // before the players
procedure RenderTracer(i: Integer);  // a bullet, before it is drawn
// after the front scenery, out of a batch: the parts of players that it hides
procedure RenderSilhouettes;

implementation

uses
  Math, Vector, Constants, Weapons, Util, Game, Sprites, Things, Bullets, Client, ClientGame,
  GameRendering, MapGraphics, GostekGraphics;

const
  TRAIL_TICKS = 4 * 60;  // how long the path of a carrier stays
  TRAIL_EVERY = 2;       // ticks between its points
  TRAIL_POINTS = TRAIL_TICKS div TRAIL_EVERY + 2;
  TRAIL_GAP = 60;        // a jump this far (a respawn, a teleport): a new line

  TRACER_TICKS = 5;      // a tracer is as long as a bullet flies in these
  TRACER_MAX = 220;

type
  TTrailPoint = record
    X, Y: Single;
    Tick: Integer;
    Start: Boolean;  // the first of a line
  end;

  TTrail = record
    Points: array[0..TRAIL_POINTS - 1] of TTrailPoint;
    Count: Integer;
    Style: Integer;  // the flag's, for its colour
    Carrier: Integer;
  end;

var
  Trails: array[1..2] of TTrail;
  WasDead: array[1..MAX_SPRITES] of Boolean;
  Primed: Boolean = False;  // WasDead holds the players as they were a tick ago
  NextMark: Integer = 0;

function SpectatorTeamColor(i: Integer; Light: Boolean): Cardinal;
begin
  Result := Sprite[i].Player.ShirtColor and $FFFFFF;
  if IsTeamGame then
    case Sprite[i].Player.Team of
      TEAM_ALPHA:   Result := iif(Light, $FF8A7E, $E8463A);
      TEAM_BRAVO:   Result := iif(Light, $8AB0FF, $4A80F0);
      TEAM_CHARLIE: Result := iif(Light, $F4E27A, $E0CC40);
      TEAM_DELTA:   Result := iif(Light, $8EE09E, $46C060);
    end
  else if Light then
    Result := $F0F0F0;
end;

function SpectatorFlagColor(Style: Integer): Cardinal;
begin
  case Style of
    OBJECT_ALPHA_FLAG: Result := $FF4A3C;
    OBJECT_BRAVO_FLAG: Result := $4A84FF;
  else
    Result := $FFDC3C;
  end;
end;

function CarriesFlag(i: Integer): Integer;
begin
  Result := 0;
  with Sprite[i] do
    if (HoldedThing > 0) and (HoldedThing <= MAX_THINGS) and
      (Thing[HoldedThing].Style in [OBJECT_ALPHA_FLAG, OBJECT_BRAVO_FLAG, OBJECT_POINTMATCH_FLAG]) then
      Result := Thing[HoldedThing].Style;
end;

// screen units (a 480 high view) to the world's at the current zoom
function WorldUnits(Units: Single): Single;
begin
  Result := Units * exp(r_zoom.Value);
end;

{ the match's ticks }

procedure TickDeaths;
var
  i: Integer;
  Dead: Boolean;
begin
  for i := 1 to MAX_SPRITES do
  begin
    Dead := not Sprite[i].Active or Sprite[i].IsSpectator or Sprite[i].DeadMeat;
    if Primed and Dead and not WasDead[i] and Sprite[i].Active then
    begin
      DeathMarks[NextMark].X := Sprite[i].Skeleton.Pos[7].X;
      DeathMarks[NextMark].Y := Sprite[i].Skeleton.Pos[7].Y;
      DeathMarks[NextMark].Tick := SpecTick;
      DeathMarks[NextMark].Color := SpectatorTeamColor(i, True);
      NextMark := (NextMark + 1) mod Length(DeathMarks);
    end;
    WasDead[i] := Dead;
  end;
  Primed := True;
end;

procedure TickTrail(var T: TTrail; Carrier, Style: Integer);
var
  n: Integer;
  X, Y: Single;
begin
  // what is too old goes
  n := 0;
  while (n < T.Count) and (SpecTick - T.Points[n].Tick > TRAIL_TICKS) do
    Inc(n);
  if n > 0 then
  begin
    Dec(T.Count, n);
    if T.Count > 0 then
      Move(T.Points[n], T.Points[0], T.Count * SizeOf(TTrailPoint));
    if T.Count > 0 then
      T.Points[0].Start := True;
  end;

  if (Carrier = 0) or (SpecTick mod TRAIL_EVERY <> 0) then
    Exit;
  T.Style := Style;

  X := Sprite[Carrier].Skeleton.Pos[7].X;
  Y := Sprite[Carrier].Skeleton.Pos[7].Y;
  if T.Count = TRAIL_POINTS then
  begin
    Move(T.Points[1], T.Points[0], (T.Count - 1) * SizeOf(TTrailPoint));
    Dec(T.Count);
    T.Points[0].Start := True;
  end;
  // (no "with" for the point: its X and Y would take the place of these)
  T.Points[T.Count].Start := (T.Count = 0) or (Carrier <> T.Carrier) or
    (SpecTick - T.Points[T.Count - 1].Tick > 2 * TRAIL_EVERY) or
    (Abs(X - T.Points[T.Count - 1].X) + Abs(Y - T.Points[T.Count - 1].Y) > TRAIL_GAP);
  T.Points[T.Count].X := X;
  T.Points[T.Count].Y := Y;
  T.Points[T.Count].Tick := SpecTick;
  T.Carrier := Carrier;
  Inc(T.Count);
end;

procedure SpectatorGraphicsTick;
var
  i, k, Flag: Integer;
  Carrier, Style: array[1..2] of Integer;
begin
  Inc(SpecTick);
  TickDeaths;
  // the carriers: a trail for each team's flag (the one of pointmatch is the first)
  for k := 1 to 2 do
  begin
    Carrier[k] := 0;
    Style[k] := 0;
  end;
  for i := 1 to MAX_SPRITES do
    if Sprite[i].Active and not Sprite[i].DeadMeat then
    begin
      Flag := CarriesFlag(i);
      if Flag = 0 then
        Continue;
      k := iif(Flag = OBJECT_BRAVO_FLAG, 2, 1);
      Carrier[k] := i;
      Style[k] := Flag;
    end;
  for k := 1 to 2 do
    TickTrail(Trails[k], Carrier[k], Style[k]);
end;

procedure SpectatorGraphicsClear;
var
  k: Integer;
begin
  SpecTick := 0;
  Primed := False;
  for k := Low(DeathMarks) to High(DeathMarks) do
    DeathMarks[k].Tick := -DEATH_TICKS - 1;
  for k := 1 to 2 do
    Trails[k].Count := 0;
end;

{ drawing }

procedure DrawSegment(ax, ay, bx, by, Width: Single; CA, CB: TGfxColor);
var
  l, nx, ny: Single;
begin
  l := Sqrt(Sqr(bx - ax) + Sqr(by - ay));
  if l < 0.001 then
    Exit;
  nx := -(by - ay) / l * Width / 2;
  ny := (bx - ax) / l * Width / 2;
  GfxDrawQuad(nil,
    GfxVertex(ax + nx, ay + ny, 0, 0, CA),
    GfxVertex(bx + nx, by + ny, 0, 0, CB),
    GfxVertex(bx - nx, by - ny, 0, 0, CB),
    GfxVertex(ax - nx, ay - ny, 0, 0, CA));
end;

procedure DrawRect(x0, y0, x1, y1: Single; Color: TGfxColor);
begin
  GfxDrawQuad(nil,
    GfxVertex(x0, y0, 0, 0, Color),
    GfxVertex(x1, y0, 0, 0, Color),
    GfxVertex(x1, y1, 0, 0, Color),
    GfxVertex(x0, y1, 0, 0, Color));
end;

procedure DrawCross(x, y, Size, Width: Single; Color: TGfxColor);
begin
  DrawSegment(x - Size, y - Size, x + Size, y + Size, Width, Color, Color);
  DrawSegment(x - Size, y + Size, x + Size, y - Size, Width, Color, Color);
end;

procedure DrawArrow(x, y, dx, dy, Len, Half: Single; Color: TGfxColor);
var
  bx, by: Single;
begin
  bx := x - dx * Len;
  by := y - dy * Len;
  // the tip, a back corner, the notch, the other back corner
  GfxDrawQuad(nil,
    GfxVertex(x, y, 0, 0, Color),
    GfxVertex(bx - dy * Half, by + dx * Half, 0, 0, Color),
    GfxVertex(x - dx * 0.7 * Len, y - dy * 0.7 * Len, 0, 0, Color),
    GfxVertex(bx + dy * Half, by - dx * Half, 0, 0, Color));
end;

procedure RenderTrail(const T: TTrail);
var
  i, j, k: Integer;
  w, dx, dy, l, nx, ny, f: Single;
  P: array[0..TRAIL_POINTS] of TVector2;
  N: array[0..TRAIL_POINTS] of TVector2;
  C: array[0..TRAIL_POINTS] of TGfxColor;
  Color: Cardinal;
  Head: Boolean;
begin
  if T.Count = 0 then
    Exit;
  w := WorldUnits(2.5);
  Color := SpectatorFlagColor(T.Style);
  // the carrier still running: the line reaches them (where they are drawn, between ticks)
  Head := (T.Carrier >= 1) and (T.Carrier <= MAX_SPRITES) and Sprite[T.Carrier].Active and
    (CarriesFlag(T.Carrier) > 0) and (SpecTick - T.Points[T.Count - 1].Tick <= TRAIL_EVERY);

  i := 0;
  while i < T.Count do
  begin
    // one line: the points from a start to the next one
    j := 0;
    repeat
      P[j] := Vector2(T.Points[i].X, T.Points[i].Y);
      f := 1 - (SpecTick - T.Points[i].Tick) / TRAIL_TICKS;
      C[j] := RGBA(Color, Round(170 * EnsureRange(f, 0, 1)));
      Inc(j);
      Inc(i);
    until (i >= T.Count) or T.Points[i].Start;
    if Head and (i = T.Count) then
    begin
      P[j] := Vector2(Sprite[T.Carrier].Skeleton.Pos[7].X, Sprite[T.Carrier].Skeleton.Pos[7].Y);
      C[j] := RGBA(Color, 170);
      Inc(j);
    end;
    if j < 2 then
      Continue;

    // each point's side: across the line before and after it (the joints meet)
    for k := 0 to j - 1 do
    begin
      dx := P[Min(k + 1, j - 1)].X - P[Max(k - 1, 0)].X;
      dy := P[Min(k + 1, j - 1)].Y - P[Max(k - 1, 0)].Y;
      l := Sqrt(dx * dx + dy * dy);
      if l < 0.001 then
      begin
        nx := 0;
        ny := w / 2;
      end
      else
      begin
        nx := -dy / l * w / 2;
        ny := dx / l * w / 2;
      end;
      N[k] := Vector2(nx, ny);
    end;
    for k := 1 to j - 1 do
      GfxDrawQuad(nil,
        GfxVertex(P[k - 1].X + N[k - 1].X, P[k - 1].Y + N[k - 1].Y, 0, 0, C[k - 1]),
        GfxVertex(P[k].X + N[k].X, P[k].Y + N[k].Y, 0, 0, C[k]),
        GfxVertex(P[k].X - N[k].X, P[k].Y - N[k].Y, 0, 0, C[k]),
        GfxVertex(P[k - 1].X - N[k - 1].X, P[k - 1].Y - N[k - 1].Y, 0, 0, C[k - 1]));
  end;
end;

procedure RenderFlagTrails;
var
  k: Integer;
begin
  if not spec_trails.Value then
    Exit;
  for k := 1 to 2 do
    RenderTrail(Trails[k]);
end;

procedure RenderTracer(i: Integer);
var
  Head, Vel: TVector2;
  Speed, Len, Travelled: Single;
  Color: Cardinal;
  Alpha: Byte;
begin
  if not spec_tracers.Value then
    Exit;
  with Bullet[i] do
  begin
    if not Active or not (Style in [BULLET_STYLE_PLAIN, BULLET_STYLE_SHOTGUN, BULLET_STYLE_M2]) or
      (Owner < 1) or (Owner > MAX_SPRITES) then
      Exit;
    if sv_realisticmode.Value and (Sprite[Owner].Visible = 0) then
      Exit;
    Vel := BulletParts.Velocity[Num];
    // where the bullet is drawn (TBullet.Render)
    Head.X := BulletParts.Pos[Num].X + Vel.X;
    Head.Y := BulletParts.Pos[Num].Y + Vel.Y;
    Travelled := Sqrt(Sqr(Head.X - Initial.X) + Sqr(Head.Y - Initial.Y));
    Alpha := iif(Style = BULLET_STYLE_SHOTGUN, 90, 150);
    Color := SpectatorTeamColor(Owner, True);
  end;
  Speed := Sqrt(Vel.X * Vel.X + Vel.Y * Vel.Y);
  if Speed < 1 then
    Exit;
  Len := Min(Min(Speed * TRACER_TICKS, TRACER_MAX), Travelled);
  if Len < 2 then
    Exit;
  DrawSegment(Head.X - Vel.X / Speed * Len, Head.Y - Vel.Y / Speed * Len, Head.X, Head.Y,
    WorldUnits(1.2), RGBA(Color, 0), RGBA(Color, Alpha));
end;

// a player's box (the head, the feet and room for the arms and the gun) meets one of the
// boxes around the cover (MapGfx.CoverBoxes)
function AtCover(i: Integer): Boolean;
var
  k: Integer;
  x0, x1, y0, y1: Single;
begin
  Result := False;
  with Sprite[i].Skeleton do
  begin
    x0 := Min(Pos[12].X, Min(Pos[1].X, Pos[2].X)) - 16;
    x1 := Max(Pos[12].X, Max(Pos[1].X, Pos[2].X)) + 16;
    y0 := Min(Pos[12].Y, Min(Pos[1].Y, Pos[2].Y)) - 12;
    y1 := Max(Pos[12].Y, Max(Pos[1].Y, Pos[2].Y)) + 6;
  end;
  for k := 0 to High(MapGfx.CoverBoxes) do
    with MapGfx.CoverBoxes[k] do
      if (x1 > Left) and (x0 < Right) and (y1 > Top) and (y0 < Bottom) then
        Exit(True);
end;

procedure RenderSilhouettes;
var
  i, n: Integer;
  Hidden: array[1..MAX_SPRITES] of Boolean;
begin
  if not spec_silhouettes.Value or (MapGfx.VertexBuffer = nil) or (Length(MapGfx.CoverBoxes) = 0) then
    Exit;
  // only the players at some cover (most frames: none, and nothing is done)
  n := 0;
  for i := 1 to MAX_SPRITES do
  begin
    Hidden[i] := Sprite[i].Active and not Sprite[i].DeadMeat and Sprite[i].IsNotSpectator and
      not (sv_realisticmode.Value and (Sprite[i].Visible = 0)) and AtCover(i);
    if Hidden[i] then
      Inc(n);
  end;
  if (n = 0) or not GfxStencilClear then
    Exit;

  // where the front scenery covers: only its solid parts, and nothing is drawn
  GfxStencil(GFX_STENCIL_MARK);
  GfxFlat(1, RGBA(0, 0), 0.5);
  if Length(MapGfx.Cover) > 0 then
    GfxDraw(MapGfx.VertexBuffer, @MapGfx.Cover[0], Length(MapGfx.Cover));
  RenderProps(1);
  RenderProps(2);

  // those players there, flat in their team's colour
  GfxStencil(GFX_STENCIL_INSIDE);
  for i := 1 to MAX_SPRITES do
    if Hidden[i] then
    begin
      GfxFlat(1, RGBA(SpectatorTeamColor(i, True), iif(i = CameraFollowSprite, 170, 120)), 0.3);
      GfxBegin;
      RenderGostek(Sprite[i]);
      GfxEnd;
    end;

  GfxStencil(GFX_STENCIL_OFF);
  GfxFlat(0, RGBA(0, 0), -1);
end;

initialization
  SpectatorGraphicsClear;

end.
