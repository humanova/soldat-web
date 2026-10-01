unit NetworkClientHeartbeat;

interface

uses
  // delphi and system units
  SysUtils, Classes,

  // soldat units
  LogFile, Steam, Net, Sprites, Sound, Constants, GameStrings;

procedure ClientHandleHeartBeat(NetMessage: PSteamNetworkingMessage_t);
procedure NoteSpriteHeard(Num: Byte);

implementation

uses
  Client, NetworkUtils, NetworkClientConnection, Game, Demo, GameRendering, WebDownload, TraceLog;

var
  // heartbeats received so far, and the heartbeat count when the server last sent
  // something about each player
  HeartbeatSeq: Integer = 0;
  SpriteHeardSeq: array[1..MAX_SPRITES] of Integer;
  ListMismatches: Integer = 0;

procedure NoteSpriteHeard(Num: Byte);
begin
  if (Num >= 1) and (Num <= MAX_SPRITES) then
    SpriteHeardSeq[Num] := HeartbeatSeq;
end;

// The heartbeat does not name its players, so a lost PlayerDisconnect leaves the
// client with a player the server no longer has, and every later heartbeat would
// mismatch. Such a player gets no snapshots: drop the ones the server has not
// mentioned for several heartbeats (spectators get no snapshots at all; keep them).
procedure DropSilentPlayers;
var
  i: Integer;
begin
  for i := 1 to MAX_PLAYERS do
    if Sprite[i].Active and (i <> MySprite) and (not Sprite[i].Player.DemoPlayer) and
      (not Sprite[i].IsSpectator) and (HeartbeatSeq - SpriteHeardSeq[i] >= 4) then
    begin
      Debug('[NET] dropping player ' + IntToStr(i) + ' the server no longer has');
      Sprite[i].Kill;
    end;
end;

// Soldat 1.7.1 sends the scoreboard in three sizes (message 36/35/2 for up to
// 8/16/32 active players). Entries are packed in slot order of active players:
//   MapID: LongWord; Active[N]; Kills[N]: Word; Caps[N]; Team[N]; Deaths[N]: Word;
//   TeamScore[1..4]: Word; Ping[N]; Flags[N]
procedure ClientHandleHeartBeat(NetMessage: PSteamNetworkingMessage_t);
var
  Data: PByte;
  N, c, i, ServerCount, LocalCount: Integer;
  MapID: LongWord;
  OfsActive, OfsKills, OfsCaps, OfsTeam, OfsDeaths, OfsScore, OfsPing, OfsFlags: Integer;
  NewScore: array[TEAM_ALPHA..TEAM_DELTA] of Word;

  function RdWord(Ofs: Integer): Word;
  begin
    Result := Data[Ofs] or (Word(Data[Ofs + 1]) shl 8);
  end;

begin
  Data := NetMessage^.m_pData;
  case Data[0] of
    MsgID_HeartBeat8: N := 8;
    MsgID_HeartBeat16: N := 16;
  else
    N := 32;
  end;
  if NetMessage^.m_cbSize < 15 + 9 * N then
    Exit;

  MapID := PLongWord(@Data[3])^;
  OfsActive := 7;
  OfsKills := OfsActive + N;
  OfsCaps := OfsKills + 2 * N;
  OfsTeam := OfsCaps + N;
  OfsDeaths := OfsTeam + N;
  OfsScore := OfsDeaths + 2 * N;
  OfsPing := OfsScore + 8;
  OfsFlags := OfsPing + N;

  Inc(HeartbeatSeq);

  // The entries belong to the server's players in slot order, so they only line up
  // with ours while both lists agree; otherwise they would move kills and teams to
  // other players. A player the client misses comes back with its next snapshot
  // (see RequestUnknownPlayer).
  ServerCount := 0;
  while (ServerCount < N) and (Data[OfsActive + ServerCount] <> 0) do
    Inc(ServerCount);
  LocalCount := 0;
  for i := 1 to MAX_PLAYERS do
    if Sprite[i].Active and (not Sprite[i].Player.DemoPlayer) then
      Inc(LocalCount);

  if LocalCount <> ServerCount then
  begin
    Inc(ListMismatches);
    Debug('[NET] heartbeat lists ' + IntToStr(ServerCount) + ' players, the client has ' +
      IntToStr(LocalCount));
    if (LocalCount > ServerCount) and (ListMismatches >= 3) then
      DropSilentPlayers;
  end
  else
    ListMismatches := 0;

  if LocalCount = ServerCount then
  begin
    c := 0;
    for i := 1 to MAX_PLAYERS do
      if Sprite[i].Active and (not Sprite[i].Player.DemoPlayer) then
      begin
        Sprite[i].Player.Kills := RdWord(OfsKills + 2 * c);
        Sprite[i].Player.Flags := Data[OfsCaps + c];
        if Sprite[i].Player.Team <> Data[OfsTeam + c] then
        begin
          Sprite[i].Player.Team := Data[OfsTeam + c];
          Sprite[i].Player.ApplyShirtColorFromTeam;
        end;
        Sprite[i].Player.Deaths := RdWord(OfsDeaths + 2 * c);
        Sprite[i].Player.Flags := Data[OfsFlags + c];
        Sprite[i].Player.PingTicks := Data[OfsPing + c];
        Sprite[i].Player.PingTime := Sprite[i].Player.PingTicks * 1000 div 60;
        Sprite[i].Player.RealPing := Sprite[i].Player.PingTime;
        Sprite[i].Player.ConnectionQuality := 100;
        Inc(c);
      end;
  end;

  for i := TEAM_ALPHA to TEAM_DELTA do
    NewScore[i] := RdWord(OfsScore + 2 * (i - TEAM_ALPHA));

  // play bding sound
  if sv_gamemode.Value = GAMESTYLE_INF then
    if NewScore[TEAM_BRAVO] > TeamScore[TEAM_BRAVO] then
      if NewScore[TEAM_BRAVO] mod 5 = 0 then
        PlaySound(SFX_INFILT_POINT);

  if sv_gamemode.Value = GAMESTYLE_HTF then
  begin
    if NewScore[TEAM_ALPHA] > TeamScore[TEAM_ALPHA] then
      if NewScore[TEAM_ALPHA] mod 5 = 0 then
        PlaySound(SFX_INFILT_POINT);
    if NewScore[TEAM_BRAVO] > TeamScore[TEAM_BRAVO] then
      if NewScore[TEAM_BRAVO] mod 5 = 0 then
        PlaySound(SFX_INFILT_POINT);
  end;

  for i := TEAM_ALPHA to TEAM_DELTA do
    TeamScore[i] := NewScore[i];

  // MapID differs, map not changed
  if MapDownloadActive or RequestingGame then
    BadMapIDCount := 2  // the map or the session is being changed
  else if (MapChangeCounter < 0) and (MapID <> 0) and
    (MapID <> Map.MapID) and (not DemoPlayer.Active) then
  begin
    Dec(BadMapIDCount);
  end
  else
    BadMapIDCount := 2;

  if BadMapIDCount < 1 then
  begin
    Debug('[NET] map id mismatch: server ' + IntToHex(MapID, 8) + ' local ' + IntToHex(Map.MapID, 8));
    BadMapIDCount := 2;
    // The server runs another map (its change was announced before this client
    // joined) or another version of this one. Ask which map it runs, like the
    // original client: the answer is a MapChange to it (see ClientHandleMapChange).
    if MapResyncTries < 3 then
    begin
      Inc(MapResyncTries);
      MapResyncRequested := True;
      ClientRequestMap;
      Exit;
    end;
    MainConsole.Console(_('Wrong map version detected'), SERVER_MESSAGE_COLOR);
    ExitToMenu;
    RenderGameInfo(_('Wrong map version detected'));
    Exit;
  end;

  if Connection = Internet then
    if (MainTickCounter - HeartBeatTime) > 350 then
    begin
      Inc(HeartbeatTimeWarnings);
    end
    else if HeartbeatTimeWarnings > 0 then
      Dec(HeartbeatTimeWarnings);

  HeartBeatTime := MainTickCounter;

  SortPlayers;
end;

end.
