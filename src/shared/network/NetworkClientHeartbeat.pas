unit NetworkClientHeartbeat;

interface

uses
  // delphi and system units
  SysUtils, Classes,

  // soldat units
  LogFile, Steam, Net, Sprites, Sound, Constants, GameStrings;

procedure ClientHandleHeartBeat(NetMessage: PSteamNetworkingMessage_t);

implementation

uses
  Client, NetworkUtils, NetworkClientConnection, Game, Demo, WebDownload, TraceLog;

// Soldat 1.7.1 sends the scoreboard in three sizes (message 36/35/2 for up to
// 8/16/32 active players). Entries are packed in slot order of active players:
//   MapID: LongWord; Active[N]; Kills[N]: Word; Caps[N]; Team[N]; Deaths[N]: Word;
//   TeamScore[1..4]: Word; Ping[N]; Flags[N]
procedure ClientHandleHeartBeat(NetMessage: PSteamNetworkingMessage_t);
var
  Data: PByte;
  N, c, i: Integer;
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

  c := 0;
  for i := 1 to MAX_PLAYERS do
    if Sprite[i].Active and (not Sprite[i].Player.DemoPlayer) then
    begin
      if c >= N then
        Break;
      Sprite[i].Active := Data[OfsActive + c] <> 0;
      Sprite[i].Player.Kills := RdWord(OfsKills + 2 * c);
      Sprite[i].Player.Flags := Data[OfsCaps + c];
      Sprite[i].Player.Team := Data[OfsTeam + c];
      Sprite[i].Player.Deaths := RdWord(OfsDeaths + 2 * c);
      Sprite[i].Player.Flags := Data[OfsFlags + c];
      Sprite[i].Player.PingTicks := Data[OfsPing + c];
      Sprite[i].Player.PingTime := Sprite[i].Player.PingTicks * 1000 div 60;
      Sprite[i].Player.RealPing := Sprite[i].Player.PingTime;
      Sprite[i].Player.ConnectionQuality := 100;
      Inc(c);
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
    MainConsole.Console(_('Wrong map version detected'), SERVER_MESSAGE_COLOR);
    Debug('[NET] map id mismatch: server ' + IntToHex(MapID, 8) + ' local ' + IntToHex(Map.MapID, 8));
    BadMapIDCount := 2;
    MapChangeCounter := -60;
    if RedownloadMap(UDP.Host, UDP.Port, Map.Name) then
      Exit;
    ClientDisconnect;
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
