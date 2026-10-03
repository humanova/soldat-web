{
  Spectator build (-dSPECTATOR, soldatspectate.lpr): watches a match that the
  spectator hub (relay/spectator.mjs) streams to the page. The page never talks
  to the game server itself; this unit holds the spectator-only behaviour that
  shared code reaches through small SPECTATOR conditional hooks, and the
  routines the page calls.
}
unit Spectator;

{$mode delphi}

interface

procedure SpectatorInit;
// the hub's director picked a player for everybody to watch
procedure SpectatorFollow(Slot: LongInt);

implementation

uses
  Client, Game, Sprites;

procedure SpectatorInit;
begin
end;

procedure SpectatorFollow(Slot: LongInt);
begin
  if (Slot >= 1) and (Slot <= MAX_SPRITES) and Sprite[Slot].Active and
    Sprite[Slot].IsNotSpectator() then
    CameraFollowSprite := Slot;
end;

end.
