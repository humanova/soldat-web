unit NetworkClientConnection;

{ Connection handshake and server settings for the Soldat 1.7.1 protocol:
  RequestGame -> PlayersList (session key) -> PlayerInfo -> NewPlayer.
  After every map change the server rotates the session key, so the client
  requests the game again (as the original 1.7.1 client did). }

interface

uses
  // delphi and system units
  SysUtils, Classes,

  // helper units
  Vector, Util, Version,

  // soldat units
  LogFile, Steam, Net, NetCrypt, Sprites, Weapons, Constants, GameStrings,
  Cvar, PhysFS;

procedure ClientRequestGame;
procedure ClientSendPlayerInfo;
procedure ClientDisconnect;
procedure ClientPong(PingNum: Byte);
procedure ClientRequestServerVars;
procedure ClientRequestPlayer(Num: Byte);
procedure ClientRequestMap;
procedure ClientNetworkTick;
procedure ClientHandlePlayersList(NetMessage: PSteamNetworkingMessage_t);
procedure ClientHandleUnAccepted(NetMessage: PSteamNetworkingMessage_t);
procedure ClientHandleServerDisconnect(NetMessage: PSteamNetworkingMessage_t);
procedure ClientHandlePing(NetMessage: PSteamNetworkingMessage_t);
procedure ClientHandleServerVars(NetMessage: PSteamNetworkingMessage_t);
procedure ClientHandleStatusRequest(NetMessage: PSteamNetworkingMessage_t);
procedure ClientHandleGravity(NetMessage: PSteamNetworkingMessage_t);
function GetHardwareID: AnsiString;

var
  // set when the client re-requests the game while playing (after downloading the map
  // it joined on), so that it keeps its team
  MapRejoin: Boolean = False;
  RejoinTeam: Byte = 0;
  // the heartbeat reported another map than the loaded one: RequestMap was sent and
  // the (encrypted) MapChange answer is expected
  MapResyncRequested: Boolean = False;
  MapResyncTries: Integer = 0;
  LastServerName: AnsiString = '';

implementation

uses
  GameRendering, Client, Game, Demo, ClientGame, GameMenus, strutils,
  NetworkUtils, NetworkClientSprite, WebDownload, Anims, Sound, TraceLog;

function js_env_hwid(Buf: PAnsiChar): LongInt; cdecl; external 'env' name 'get_hwid';

const
  // the server firewalls addresses that send more than 18 join messages within ~16 s,
  // and every player behind the relay shares one address: retry gently
  REQUESTGAME_RETRY_TICKS = 3 * 60;
  REQUESTGAME_MAX_TRIES = 5;
  PLAYERINFO_RETRY_TICKS = 3 * 60;

var
  RequestGameTries: Integer = 0;
  CachedHWID: AnsiString = '';

// 11 characters: ten hex digits persisted per browser plus the checksum digit the
// 1.7.1 server validates (djb2 over the hex values, low nibble).
function GetHardwareID: AnsiString;
const
  HEXCHARS = '0123456789ABCDEF';
var
  Buf: array[0..15] of AnsiChar;
  s: AnsiString;
  h: LongWord;
  i: Integer;
begin
  if CachedHWID <> '' then
    Exit(CachedHWID);

  FillChar(Buf, SizeOf(Buf), 0);
  js_env_hwid(@Buf[0]);
  s := UpperCase(Copy(AnsiString(PAnsiChar(@Buf[0])), 1, 10));
  for i := 1 to Length(s) do
    if Pos(s[i], HEXCHARS) = 0 then
      s[i] := '0';
  while Length(s) < 10 do
    s := s + '0';

  h := 5381;
  for i := 1 to 10 do
    h := h * 33 + LongWord(Pos(s[i], HEXCHARS) - 1);

  CachedHWID := s + HEXCHARS[(h and $F) + 1];
  Result := CachedHWID;
end;

// REQUEST GAME FROM SERVER
procedure ClientRequestGame;
var
  RequestMsg: PMsg_RequestGame;
  Size: Integer;
  SendBuffer: array of Byte;
  Name, HW, Ver: AnsiString;
begin
  // never burst: the server firewalls addresses that request too often
  if RequestingGame and (RequestGameRetryTicks > REQUESTGAME_RETRY_TICKS - 30) then
    Exit;
  SendBuffer := nil;
  Size := SizeOf(TMsg_RequestGame) + Length(JoinPassword);
  SetLength(SendBuffer, Size);
  FillChar(SendBuffer[0], Size, 0);

  RequestMsg := PMsg_RequestGame(@SendBuffer[0]);
  RequestMsg.Header.ID := MsgID_RequestGame;
  Ver := AnsiString(SOLDAT_VERSION);
  Move(Ver[1], RequestMsg.Version, Length(RequestMsg.Version));

  if RedirectIP <> '' then
  begin
    RequestMsg.Forwarded := 1;
    RedirectIP := '';
    RedirectPort := 0;
    RedirectMsg := '';
  end;

  Name := AnsiString(Copy(cl_player_name.Value, 1, PLAYERNAME_CHARS - 1));
  if Name <> '' then
    Move(Name[1], RequestMsg.Name, Length(Name));

  HW := GetHardwareID;
  RequestMsg.HardwareID := HW;

  if JoinPassword <> '' then
    Move(JoinPassword[1], RequestMsg.Password, Length(JoinPassword));

  UDP.SendData(RequestMsg^, Size, k_nSteamNetworkingSend_Reliable);

  if not RequestingGame then
    RequestGameTries := 0;
  Inc(RequestGameTries);
  RequestingGame := True;
  RequestGameRetryTicks := REQUESTGAME_RETRY_TICKS;
  ReceivedUnAccepted := False;
end;

function BuildLook: Byte;
begin
  Result := 0;
  if cl_player_hairstyle.Value = 1 then
    Result := Result or B1;
  if cl_player_hairstyle.Value = 2 then
    Result := Result or B2;
  if cl_player_hairstyle.Value = 3 then
    Result := Result or B3;
  if cl_player_hairstyle.Value = 4 then
    Result := Result or B4;
  if cl_player_headstyle.Value = HEADSTYLE_HELMET then
    Result := Result or B5;
  if cl_player_headstyle.Value = HEADSTYLE_HAT then
    Result := Result or B6;
  if cl_player_chainstyle.Value = 1 then
    Result := Result or B7;
  if cl_player_chainstyle.Value = 2 then
    Result := Result or B8;
end;

// SEND INFO ABOUT NAME, COLOR, PASS etc. TO SERVER OR CHANGE TEAM
procedure ClientSendPlayerInfo;
var
  PlayerInfo: TMsg_PlayerInfo;
  ChangeMsg: TMsg_ChangeTeam;
  Name, HW: AnsiString;
begin
  if (Spectator = 1) and (SelTeam = 0) then
    SelTeam := TEAM_SPECTATOR;
  Spectator := 0;  // allow joining other teams after first join
  if (sv_gamemode.Value = GAMESTYLE_CTF) or (sv_gamemode.Value = GAMESTYLE_INF) or
     (sv_gamemode.Value = GAMESTYLE_HTF) then
    if (SelTeam < TEAM_ALPHA) or
       ((SelTeam > TEAM_BRAVO) and (SelTeam < TEAM_SPECTATOR)) then
    begin
      GameMenuShow(TeamMenu);
      Exit;
    end;
  if sv_gamemode.Value = GAMESTYLE_TEAMMATCH then
    if SelTeam < TEAM_ALPHA then
    begin
      GameMenuShow(TeamMenu);
      Exit;
    end;

  // send a team change request instead if we're already ingame
  if MySprite > 0 then
  begin
    ChangeMsg := Default(TMsg_ChangeTeam);
    ChangeMsg.Header.ID := MsgID_ChangeTeam;
    ChangeMsg.Team := SelTeam;
    UDP.Cipher.Reset;
    UDP.Cipher.Encrypt(ChangeMsg.Team, 1);
    UDP.Cipher.Reset;
    UDP.SendData(ChangeMsg, SizeOf(ChangeMsg), k_nSteamNetworkingSend_Reliable);
    RejoinTeam := SelTeam;
    Exit;
  end;

  PlayerInfo := Default(TMsg_PlayerInfo);
  PlayerInfo.Header.ID := MsgID_PlayerInfo;
  Name := AnsiString(Copy(cl_player_name.Value, 1, PLAYERNAME_CHARS - 1));
  if Name <> '' then
    Move(Name[1], PlayerInfo.Name, Length(Name));
  PlayerInfo.MapID := PLAYERSLIST_MAPID;
  PlayerInfo.ShirtColor := (255 shl 24) + (cl_player_shirt.Value and $00FFFFFF);
  PlayerInfo.PantsColor := (255 shl 24) + (cl_player_pants.Value and $00FFFFFF);
  PlayerInfo.SkinColor := (255 shl 24) + (cl_player_skin.Value and $00FFFFFF);
  PlayerInfo.HairColor := (255 shl 24) + (cl_player_hair.Value and $00FFFFFF);
  PlayerInfo.JetColor := (cl_player_jet.Value and $00FFFFFF) + COLOR_TRANSPARENCY_REGISTERED;
  PlayerInfo.Team := SelTeam;
  PlayerInfo.Look := BuildLook;
  HW := GetHardwareID;
  PlayerInfo.HardwareID := HW;

  // field order and sizes must match the server's decryption sequence
  UDP.Cipher.Reset;
  UDP.Cipher.Encrypt(PlayerInfo.ShirtColor, 4);
  UDP.Cipher.Encrypt(PlayerInfo.PantsColor, 4);
  UDP.Cipher.Encrypt(PlayerInfo.SkinColor, 4);
  UDP.Cipher.Encrypt(PlayerInfo.HairColor, 4);
  UDP.Cipher.Encrypt(PlayerInfo.JetColor, 4);
  UDP.Cipher.Encrypt(PlayerInfo.Team, 1);
  UDP.Cipher.Encrypt(PlayerInfo.Look, 1);
  UDP.Cipher.Encrypt(PlayerInfo.MapID, 4);
  UDP.Cipher.Encrypt(PlayerInfo.HardwareID, 12);
  UDP.Cipher.Reset;

  UDP.SendData(PlayerInfo, SizeOf(PlayerInfo), k_nSteamNetworkingSend_Reliable);
  ClientPlayerSent := True;
  ClientPlayerReceivedCounter := CLIENTPLAYERRECIEVED_TIME;
  RejoinTeam := SelTeam;
end;

procedure ClientDisconnect;
var
  PlayerMsg: TMsg_PlayerDisconnect;
begin
  Debug('[NET] ClientDisconnect');
  if MySprite > 0 then
  begin  // send disconnection info to server
    PlayerMsg := Default(TMsg_PlayerDisconnect);
    PlayerMsg.Header.ID := MsgID_PlayerDisconnect;
    PlayerMsg.Num := MySprite;
    PlayerMsg.Why := KICK_LEFTGAME;
    UDP.Cipher.Reset;
    UDP.Cipher.Encrypt(PlayerMsg.Num, 1);
    UDP.Cipher.Reset;

    UDP.SendData(PlayerMsg, SizeOf(PlayerMsg), k_nSteamNetworkingSend_Reliable);

    AddLineToLogFile(GameLog, 'Client Disconnect from ' + UDP.AddressString(True), ConsoleLogFileName);
    UDP.Disconnect(False);
  end else
  begin
    UDP.Disconnect(True);
    ExitToMenu;
  end;
  MapRejoin := False;
  MapResyncRequested := False;
  MapResyncTries := 0;
  RequestingGame := False;
  CancelMapDownload;
end;

procedure ClientPong(PingNum: Byte);
var
  PongMsg: TMsg_Pong;
begin
  PongMsg := Default(TMsg_Pong);
  PongMsg.Header.ID := MsgID_Pong;
  PongMsg.PingNum := PingNum;

  UDP.SendData(PongMsg, SizeOf(PongMsg), k_nSteamNetworkingSend_Reliable);
end;

procedure ClientRequestServerVars;
var
  Msg: TMsg_RequestServerVars;
begin
  if MySprite = 0 then
    Exit;
  Msg := Default(TMsg_RequestServerVars);
  Msg.Header.ID := MsgID_RequestServerVars;
  Msg.Num := MySprite;
  UDP.Cipher.Reset;
  UDP.Cipher.Encrypt(Msg.Num, 1);
  UDP.Cipher.Reset;
  UDP.SendData(Msg, SizeOf(Msg), k_nSteamNetworkingSend_Reliable);
end;

procedure ClientRequestPlayer(Num: Byte);
var
  Msg: TMsg_RequestPlayer;
begin
  Msg := Default(TMsg_RequestPlayer);
  Msg.Header.ID := MsgID_RequestPlayer;
  Msg.Num := Num;
  UDP.Cipher.Reset;
  UDP.Cipher.Encrypt(Msg.Num, 1);
  UDP.Cipher.Reset;
  UDP.SendData(Msg, SizeOf(Msg), k_nSteamNetworkingSend_Reliable);
end;

procedure ClientRequestMap;
var
  Msg: TMsg_RequestMap;
begin
  Msg := Default(TMsg_RequestMap);
  Msg.Header.ID := MsgID_RequestMap;
  UDP.SendData(Msg, SizeOf(Msg), k_nSteamNetworkingSend_Reliable);
end;

// Called once per game tick: retransmits the handshake messages (plain UDP) and
// drives map downloads.
procedure ClientNetworkTick;
begin
  if (UDP = nil) or not UDP.Active then
    Exit;

  UpdateMapDownload;
  if MapDownloadActive then
    Exit;

  if RequestingGame then
  begin
    Dec(RequestGameRetryTicks);
    if RequestGameRetryTicks <= 0 then
    begin
      if RequestGameTries >= REQUESTGAME_MAX_TRIES then
      begin
        RequestingGame := False;
        RenderGameInfo(_('Connection timed out.'));
        ClientDisconnect;
        Exit;
      end;
      ClientRequestGame;
    end;
  end
  else if ClientPlayerSent and not ClientPlayerReceived and (MySprite = 0) then
  begin
    // PlayerInfo travels over UDP; resend if the server did not create our sprite yet
    Dec(ClientPlayerReceivedCounter);
    if (ClientPlayerReceivedCounter > 0) and
      (ClientPlayerReceivedCounter mod PLAYERINFO_RETRY_TICKS = 0) then
    begin
      SelTeam := RejoinTeam;
      ClientSendPlayerInfo;
      ClientPlayerReceivedCounter := ClientPlayerReceivedCounter - 1;
    end;
  end;
end;

function FixedString(const A: array of Char): AnsiString;
var
  i: Integer;
begin
  Result := '';
  for i := 0 to High(A) do
  begin
    if A[i] = #0 then
      Break;
    Result := Result + A[i];
  end;
end;

procedure ClientHandlePlayersList(NetMessage: PSteamNetworkingMessage_t);
var
  PlayersListMsg: TMsg_PlayersList;
  i: Integer;
  Pos, Vel, b: TVector2;
  NewPlayer: TPlayer;
  MapName, PlayerName: AnsiString;
  MapStatus: TMapInfo;
  GameStyle: Byte;
  MapID: LongWord;
  Gravity: Single;
  Flags: Byte;
  WasRejoin: Boolean;
begin
  if not VerifyPacket(SizeOf(TMsg_PlayersList), NetMessage^.m_cbSize, MsgID_PlayersList) then
    Exit;

  if not (RequestingGame or DemoPlayer.Active) then
    Exit;

  RequestingGame := False;
  WasRejoin := MapRejoin;
  MapRejoin := False;
  MapResyncRequested := False;
  MapResyncTries := 0;
  ExitReason := '';

  PlayersListMsg := PMsg_PlayersList(NetMessage^.m_pData)^;

  // new session key (rotated on every map change)
  SessionID := PlayersListMsg.SessionID;
  UDP.Cipher.InitStr(SessionKey(SessionID));

  MapID := PlayersListMsg.MapID;
  GameStyle := PlayersListMsg.GameStyle;
  Gravity := PlayersListMsg.Gravity;
  UDP.Cipher.Reset;
  UDP.Cipher.Decrypt(MapID, 4);
  UDP.Cipher.Decrypt(GameStyle, 1);
  UDP.Cipher.Decrypt(Gravity, 4);
  UDP.Cipher.Reset;

  if not WasRejoin then
    MainConsole.Console(_('Connection accepted to') + ' ' + WideString(UDP.AddressString(True)),
      CLIENT_MESSAGE_COLOR);

  // server settings
  Flags := PlayersListMsg.Flags;
  if GameStyle <= GAMESTYLE_HTF then
    sv_gamemode.SetValue(GameStyle);
  sv_killlimit.SetValue(PlayersListMsg.KillLimit);
  sv_survivalmode.SetValue(Flags and B1 <> 0);
  sv_realisticmode.SetValue(Flags and B2 <> 0);
  if Flags and B3 <> 0 then
    Connection := INTERNET
  else
    Connection := LAN;
  sv_guns_collide.SetValue(Flags and B3 = 0);
  sv_kits_collide.SetValue(Flags and B3 = 0);
  sv_balanceteams.SetValue(Flags and B4 <> 0);
  sv_bullettime.SetValue(Flags and B5 <> 0);
  sv_sniperline.SetValue(Flags and B6 = 0);
  sv_advancemode.SetValue(Flags and B7 <> 0);
  sv_survivalmode_antispy.SetValue(Flags and B8 <> 0);
  sv_hostname.SetValue(FixedString(PlayersListMsg.ServerName));
  sv_info.SetValue(FixedString(PlayersListMsg.ServerInfo));
  sv_timelimit.SetValue(PlayersListMsg.TimeLimit);
  sv_maxgrenades.SetValue(PlayersListMsg.MaxGrenades);
  sv_survivalmode_clearweapons.SetValue(PlayersListMsg.SurvivalClearWeapons <> 0);
  if (Gravity > 0.0) and (Gravity < 10.0) then
    sv_gravity.SetValue(Gravity);
  LastServerName := sv_hostname.Value;

  MapName := AnsiReplaceStr(Trim(FixedString(PlayersListMsg.MapName)), '..', '');
  MapName := AnsiReplaceStr(MapName, '/', '');
  MapName := AnsiReplaceStr(MapName, '\', '');

  // Initialize Map
  if GetMapInfo(MapName, UserDirectory, MapStatus) then
  begin
    // textures and scenery are fetched on demand; the game is requested again afterwards
    if not EnsureMapAssets(UDP.Host, UDP.Port, MapName) then
      Exit;
    if not Map.LoadMap(MapStatus, r_forcebg.Value, r_forcebg_color1.Value, r_forcebg_color2.Value) then
    begin
      RenderGameInfo(_('Could not load map: ') + WideString(MapName));
      ClientDisconnect;
      Exit;
    end;
  end
  else
  begin
    // not available locally - fetch it from the server's file server and rejoin afterwards
    StartMapDownload(UDP.Host, UDP.Port, MapName);
    Exit;
  end;

  // Sync
  PlayersNum := PlayersListMsg.Players;
  TimeLimitCounter := PlayersListMsg.CurrentTime;

  b.x := 0;
  b.y := 0;
  for i := 1 to MAX_SPRITES do
  begin
    if Sprite[i].Active then
      Sprite[i].Kill;
    PlayerName := FixedString(PlayersListMsg.Name[i]);
    if (PlayerName <> '') and (PlayerName <> '0 ') then
    begin
      NewPlayer := Sprite[i].Player; // reuse object
      NewPlayer.Name := ReturnFixedPlayerName(PlayerName);
      NewPlayer.ShirtColor := PlayersListMsg.ShirtColor[i] or $FF000000;
      NewPlayer.PantsColor := PlayersListMsg.PantsColor[i] or $FF000000;
      NewPlayer.SkinColor := PlayersListMsg.SkinColor[i] or $FF000000;
      NewPlayer.HairColor := PlayersListMsg.HairColor[i] or $FF000000;
      NewPlayer.JetColor := PlayersListMsg.JetColor[i];
      NewPlayer.Team := PlayersListMsg.Team[i];
      NewPlayer.ControlMethod := HUMAN;

      NewPlayer.SecWep := 0;
      Pos := PlayersListMsg.Pos[i];
      Vel := PlayersListMsg.Vel[i];

      NewPlayer.HairStyle := 0;
      if PlayersListMsg.Look[i] and B1 = B1 then NewPlayer.HairStyle := 1;
      if PlayersListMsg.Look[i] and B2 = B2 then NewPlayer.HairStyle := 2;
      if PlayersListMsg.Look[i] and B3 = B3 then NewPlayer.HairStyle := 3;
      if PlayersListMsg.Look[i] and B4 = B4 then NewPlayer.HairStyle := 4;

      NewPlayer.HeadCap := 0;
      if PlayersListMsg.Look[i] and B5 = B5 then NewPlayer.HeadCap := GFX_GOSTEK_HELM;
      if PlayersListMsg.Look[i] and B6 = B6 then NewPlayer.HeadCap := GFX_GOSTEK_KAP;

      NewPlayer.Chain := 0;
      if PlayersListMsg.Look[i] and B7 = B7 then NewPlayer.Chain := 1;
      if PlayersListMsg.Look[i] and B8 = B8 then NewPlayer.Chain := 2;

      CreateSprite(Pos, b, 1, i, NewPlayer, False);

      SpriteParts.Velocity[Sprite[i].Num] := Vel;

      Sprite[i].CeaseFireCounter := 0;
      if (PlayersListMsg.PredDuration[i] > 0) then
      begin
        Sprite[i].Alpha := PREDATORALPHA;
        Sprite[i].BonusTime := PlayersListMsg.PredDuration[i] * 60;
        Sprite[i].BonusStyle := BONUS_PREDATOR;
      end;
    end;
  end;
  SortPlayers;

  if not DemoPlayer.Active then
    RenderGameInfo(_('Waiting to join game...'));

  MySprite := 0;
  CameraFollowSprite := 0;
  GameThingTarget := 0;
  MenuTimer := 0;
  SurvivalEndRound := False;
  CameraX := 0;
  CameraY := 0;

  if not DemoPlayer.Active then
  begin
    GoalTicks := DEFAULT_GOALTICKS;
    NoTexts := 0;
  end;

  ClientVarsRecieved := False;
  MainTickCounter := 0;
  ClientTickCount := PlayersListMsg.ServerTicks;
  NoHeartbeatTime := 0;
  MapChangeCounter := -60;
  GameMenuShow(EscMenu, False);
  LimboLock := False;

  if VoteActive then
    StopVote;

  ResetWeaponStats;

  ClientPlayerReceived := False;
  ClientPlayerSent := False;
  ClientPlayerReceivedCounter := CLIENTPLAYERRECIEVED_TIME;

  // Begin rendering so that the team menu selection is visible
  if not (DemoPlayer.Active and (DemoPlayer.SkipTo = -1)) then
    ShouldRenderFrames := True;

  if WasRejoin and (RejoinTeam > 0) then
  begin
    // map change: keep playing in the same team
    SelTeam := RejoinTeam;
    ClientSendPlayerInfo;
  end
  else
  begin
    SelTeam := 0;
    if cl_player_team.Value > 0 then
    begin
      // Bypass Team Select Menu if team cvar is set
      SelTeam := cl_player_team.Value;
      ClientSendPlayerInfo;
    end
    else if Spectator = 1 then
      ClientSendPlayerInfo
    else
    begin
      if (sv_gamemode.Value = GAMESTYLE_DEATHMATCH) or
         (sv_gamemode.Value = GAMESTYLE_POINTMATCH) or
         (sv_gamemode.Value = GAMESTYLE_RAMBO) then
        ClientSendPlayerInfo;

      if sv_gamemode.Value = GAMESTYLE_TEAMMATCH then
        GameMenuShow(TeamMenu);

      if (sv_gamemode.Value = GAMESTYLE_CTF) or (sv_gamemode.Value = GAMESTYLE_INF) or
         (sv_gamemode.Value = GAMESTYLE_HTF) then
      begin
        GameMenuShow(TeamMenu);
        if sv_balanceteams.Value then
        begin
          SelTeam := 0;
          if PlayersTeamNum[1] < PlayersTeamNum[2] then
            SelTeam := 1;
          if PlayersTeamNum[2] < PlayersTeamNum[1] then
            SelTeam := 2;
          if SelTeam > 0 then
            ClientSendPlayerInfo;
        end;
      end;
    end;
  end;

  StartHealth := DEFAULT_HEALTH;
  if sv_realisticmode.Value then
    StartHealth := REALISTIC_HEALTH;

  mx := GameWidthHalf;
  my := GameHeightHalf;
  MousePrev.x := mx;
  MousePrev.y := my;
  WindowReady := True;

  if WasRejoin then
    Exit;

  if ui_sniperline.Value and not sv_sniperline.Value then
    MainConsole.Console(_('Sniper Line disabled on this server'), WARNING_MESSAGE_COLOR);

  if sv_realisticmode.Value then
    MainConsole.Console(_('Realistic Mode ON'), MODE_MESSAGE_COLOR);
  if sv_survivalmode.Value then
    MainConsole.Console(_('Survival Mode ON'), MODE_MESSAGE_COLOR);
  if sv_advancemode.Value then
    MainConsole.Console(_('Advance Mode ON'), MODE_MESSAGE_COLOR);

  if sv_info.Value <> '' then
    MainConsole.Console(WideString(sv_info.Value), SERVER_MESSAGE_COLOR);
end;

procedure ClientHandleUnAccepted(NetMessage: PSteamNetworkingMessage_t);
var
  Data: PAnsiChar;
  State: Byte;
  Text, ServerVersion: AnsiString;
  i: Integer;
begin
  if not VerifyPacketLargerOrEqual(4, NetMessage^.m_cbSize, MsgID_UnAccepted) then
    Exit;

  Data := NetMessage^.m_pData;
  State := Byte(Data[3]);

  Text := '';
  i := 4;
  while (i < NetMessage^.m_cbSize) and (Data[i] <> #0) do
  begin
    Text := Text + Data[i];
    Inc(i);
  end;

  ServerVersion := '';
  if (Text = '') and (NetMessage^.m_cbSize >= 10) then
    SetString(ServerVersion, @Data[5], 5);

  AddLineToLogFile(GameLog, '*UA ' + IntToStr(State), ConsoleLogFileName);

  case State of
    WRONG_VERSION:
      RenderGameInfo(_('Wrong game versions. Your version:') + ' ' + SOLDAT_VERSION +
        ' ' + _('Server Version:') + ' ' + WideString(ServerVersion));

    WRONG_PASSWORD:
      RenderGameInfo(_('Wrong server password'));

    BANNED_IP:
      RenderGameInfo(_('You have been banned on this server. Reason:') + ' ' + WideString(Text));

    SERVER_FULL:
      RenderGameInfo(_('Server is full'));

    INVALID_HWID:
      RenderGameInfo(_('Rejected by server (invalid hardware id)'));

    INVALID_HANDSHAKE:
      RenderGameInfo(_('Unspecified internal protocol error'));

    WRONG_CHECKSUM:
      RenderGameInfo(_('This server requires a different smod file.'));

    ANTICHEAT_REQUIRED, ANTICHEAT_REJECTED:
      RenderGameInfo(_('Rejected by Anti-Cheat:') + ' ' + WideString(Text));
  else
    RenderGameInfo(_('Connection refused by server') + ' (' + WideString(IntToStr(State)) + ') ' +
      WideString(Text));
  end;

  ReceivedUnAccepted := True;
  RequestingGame := False;
  ClientDisconnect;
end;

procedure ClientHandleServerDisconnect(NetMessage: PSteamNetworkingMessage_t);
begin
  if not VerifyPacket(SizeOf(TMsg_ServerDisconnect), NetMessage^.m_cbSize, MsgID_ServerDisconnect) then
    Exit;

  ShowMapChangeScoreboard();

  if not DemoPlayer.Active then
  begin
    MainConsole.Console(_('Server disconnected'), SERVER_MESSAGE_COLOR);
    ExitReason := _('Server disconnected');
  end
  else
    DemoPlayer.StopDemo;
end;

procedure ClientHandlePing(NetMessage: PSteamNetworkingMessage_t);
begin
  if not VerifyPacket(SizeOf(TMsg_Ping), NetMessage^.m_cbSize, MsgID_Ping) then
    Exit;

  if DemoPlayer.Active then
    Exit;

  if MySprite <> 0 then
  begin
    Sprite[MySprite].Player.PingTicks := PMsg_Ping(NetMessage^.m_pData)^.PingTicks;
    Sprite[MySprite].Player.PingTime :=
      Sprite[MySprite].Player.PingTicks * 1000 div 60;
  end;

  ClientPong(PMsg_Ping(NetMessage^.m_pData)^.PingNum);

  ClientStopMovingCounter := CLIENTSTOPMOVE_RETRYS;
  NoHeartbeatTime := 0;
end;

procedure ClientHandleServerVars(NetMessage: PSteamNetworkingMessage_t);
var
  VarsMsg: TMsg_ServerVars;
  i: Integer;
  Gun: ^TGun;
  WeaponIndex: Integer;
begin
  if not VerifyPacket(SizeOf(TMsg_ServerVars), NetMessage^.m_cbSize, MsgID_ServerVars) then
    Exit;

  VarsMsg := PMsg_ServerVars(NetMessage^.m_pData)^;

  ClientVarsRecieved := True;

  sv_friendlyfire.SetValue(VarsMsg.FriendlyFire <> 0);
  if VarsMsg.AdvanceAmount > 0 then
    sv_advancemode_amount.SetValue(VarsMsg.AdvanceAmount);
  sv_timelimit.SetValue(VarsMsg.TimeLimit);
  sv_minimap.SetValue(VarsMsg.DisableMinimap = 0);
  sv_advancedspectator.SetValue(VarsMsg.AdvancedSpectate <> 0);
  sv_radio.SetValue(VarsMsg.Radio <> 0);

  WeaponsInGame := 0;

  for i := 1 to MAIN_WEAPONS do
  begin
    WeaponActive[i] := VarsMsg.WeaponActive[i];
    LimboMenu.Button[i - 1].Active := Boolean(WeaponActive[i]);
    if WeaponActive[i] = 1 then
      Inc(WeaponsInGame);
  end;

  if MySprite > 0 then
  begin
    SelectDefaultWeapons(MySprite);
    NewPlayerWeapon;
  end;

  CreateDefaultWeapons(sv_realisticmode.Value);
  DefaultWMChecksum := CreateWMChecksum();

  for WeaponIndex := 1 to ORIGINAL_WEAPONS do
  begin
    Gun := @Guns[WeaponIndex];
    Gun.HitMultiply       := VarsMsg.Damage[WeaponIndex];
    Gun.Ammo              := VarsMsg.Ammo[WeaponIndex];
    Gun.ReloadTime        := VarsMsg.ReloadTime[WeaponIndex];
    Gun.Speed             := VarsMsg.Speed[WeaponIndex];
    Gun.BulletStyle       := VarsMsg.BulletStyle[WeaponIndex];
    Gun.StartUpTime       := VarsMsg.StartUpTime[WeaponIndex];
    Gun.Bink              := VarsMsg.Bink[WeaponIndex];
    Gun.FireInterval      := VarsMsg.FireInterval[WeaponIndex];
    Gun.MovementAcc       := VarsMsg.MovementAcc[WeaponIndex];
    Gun.BulletSpread      := VarsMsg.BulletSpread[WeaponIndex];
    Gun.Recoil            := VarsMsg.Recoil[WeaponIndex];
    Gun.Push              := VarsMsg.Push[WeaponIndex];
    Gun.InheritedVelocity := VarsMsg.InheritedVelocity[WeaponIndex];
    Gun.ModifierHead      := VarsMsg.ModifierHead[WeaponIndex];
    Gun.ModifierChest     := VarsMsg.ModifierChest[WeaponIndex];
    Gun.ModifierLegs      := VarsMsg.ModifierLegs[WeaponIndex];
  end;

  BuildWeapons();

  if MySprite > 0 then
  begin
    Sprite[MySprite].ApplyWeaponByNum(Sprite[MySprite].Weapon.Num, 1);
    Sprite[MySprite].ApplyWeaponByNum(Sprite[MySprite].SecondaryWeapon.Num, 2);
    if not Sprite[MySprite].DeadMeat then
      ClientSpriteSnapshot;
  end;

  LoadedWMChecksum := CreateWMChecksum();

  if LoadedWMChecksum <> DefaultWMChecksum then
    if not DemoPlayer.Active then
      MainConsole.Console(_('Server uses weapon mod (checksum') + ' ' +
        WideString(IntToStr(LoadedWMChecksum)) + ')', SERVER_MESSAGE_COLOR)
end;

// The server periodically asks for the client's view of two game settings (realistic
// mode flag and jet capacity) and drops clients that never answer.
procedure ClientHandleStatusRequest(NetMessage: PSteamNetworkingMessage_t);
var
  Reply: TMsg_StatusReply;
begin
  if not VerifyPacket(3, NetMessage^.m_cbSize, MsgID_StatusRequest) then
    Exit;

  Reply := Default(TMsg_StatusReply);
  Reply.Header.ID := MsgID_StatusReply;
  Reply.RealisticMode := Byte(sv_realisticmode.Value);
  Reply.JetCount := Map.StartJet;
  if (MySprite > 0) and Sprite[MySprite].Active and (Sprite[MySprite].JetsCount < Reply.JetCount) then
    Reply.JetCount := Sprite[MySprite].JetsCount;
  Reply.Reserved := 0;

  UDP.Cipher.Reset;
  UDP.Cipher.Encrypt(Reply.RealisticMode, 1);
  UDP.Cipher.Encrypt(Reply.JetCount, 4);
  UDP.Cipher.Encrypt(Reply.Reserved, 1);
  UDP.Cipher.Reset;

  UDP.SendData(Reply, SizeOf(Reply), k_nSteamNetworkingSend_Reliable);
end;

procedure ClientHandleGravity(NetMessage: PSteamNetworkingMessage_t);
var
  Grav: Single;
begin
  if not VerifyPacket(SizeOf(TMsg_Gravity), NetMessage^.m_cbSize, MsgID_Gravity) then
    Exit;
  Grav := PMsg_Gravity(NetMessage^.m_pData)^.Grav;
  if (Grav > -10.0) and (Grav < 10.0) then
    sv_gravity.SetValue(Grav);
end;

end.
