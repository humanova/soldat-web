{
  Spectator build (-dSPECTATOR, soldatspectate.lpr): watches a match that the
  spectator hub (relay/spectator.mjs) streams to the page. The page never talks
  to the game server itself; this unit holds the spectator-only behaviour that
  shared code reaches through small SPECTATOR conditional hooks.
}
unit Spectator;

{$mode delphi}

interface

procedure SpectatorInit;

implementation

procedure SpectatorInit;
begin
end;

end.
