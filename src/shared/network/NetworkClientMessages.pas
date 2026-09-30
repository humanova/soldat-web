unit NetworkClientMessages;

interface

uses

  // delphi and system units
  SysUtils, Classes,

  // helper units
  Vector, Util,

  // soldat units
  Steam, Net, Sprites, Constants, GameStrings;

procedure ClientSendStringMessage(Text: WideString; MsgType: Byte);
procedure ClientHandleChatMessage(NetMessage: PSteamNetworkingMessage_t);
procedure ClientHandleSpecialMessage(NetMessage: PSteamNetworkingMessage_t);

implementation

uses
  Client, Game, InterfaceGraphics, NetworkUtils;

// Soldat 1.7.1 chat wire format: the text carries its type. The first character is a prompt
// character the server ignores, followed by '^' for team chat or '*NN' for radio
// messages (NN = radio code); commands start with '/'. ASCII text uses message 6,
// anything else is sent as UTF-16 with message 66.
procedure ClientSendStringMessage(Text: WideString; MsgType: Byte);
var
  Wire: WideString;
  IsAscii: Boolean;
  Buf: array of Byte;
  Size, i: Integer;
  Msg: PMsg_StringMessage;
begin
  if Length(Text) = 0 then
    Exit;

  case MsgType of
    MSGTYPE_CMD:
      Wire := '/' + Text;
    MSGTYPE_TEAM:
      Wire := ' ^' + Text;
    MSGTYPE_RADIO:
      if (Length(Text) > 0) and (Text[1] = '*') then
        Wire := ' ' + Text
      else
        Wire := ' *' + Text;
  else
    Wire := ' ' + Text;
  end;

  IsAscii := True;
  for i := 1 to Length(Wire) do
    if Ord(Wire[i]) > 126 then
      IsAscii := False;

  Buf := nil;
  if IsAscii then
  begin
    Size := SizeOf(TMsgHeader) + 1 + Length(Wire) + 1;
    SetLength(Buf, Size);
    FillChar(Buf[0], Size, 0);
    Msg := PMsg_StringMessage(@Buf[0]);
    Msg.Header.ID := MsgID_ChatMessage;
    for i := 1 to Length(Wire) do
      Buf[SizeOf(TMsgHeader) + 1 + i - 1] := Ord(Wire[i]);
  end
  else
  begin
    Size := SizeOf(TMsgHeader) + 1 + 2 * Length(Wire) + 2;
    SetLength(Buf, Size);
    FillChar(Buf[0], Size, 0);
    Msg := PMsg_StringMessage(@Buf[0]);
    Msg.Header.ID := MsgID_UnicodeChatMessage;
    Move(Wire[1], Buf[SizeOf(TMsgHeader) + 1], 2 * Length(Wire));
  end;

  Msg.Num := MySprite;
  UDP.Cipher.Reset;
  UDP.Cipher.Encrypt(Msg.Num, 1);
  UDP.Cipher.Reset;

  UDP.SendData(Buf[0], Size, k_nSteamNetworkingSend_Reliable);
end;

procedure ClientHandleChatMessage(NetMessage: PSteamNetworkingMessage_t);
var
  Data: PByte;
  cs: WideString = '';
  prefix: WideString = '';
  RadioCommand: WideString;
  i, d, p: Integer;
  MsgType: Byte;
  col: Cardinal;
begin
  if not VerifyPacketLargerOrEqual(SizeOf(TMsgHeader) + 1, NetMessage^.m_cbSize, MsgID_ChatMessage) then
    Exit;

  Data := NetMessage^.m_pData;
  i := Data[3];

  // decode the text (ANSI/Latin-1 for message 6, UTF-16 for message 66)
  p := 4;
  if Data[0] = MsgID_UnicodeChatMessage then
  begin
    while (p + 1 < NetMessage^.m_cbSize) and ((Data[p] <> 0) or (Data[p + 1] <> 0)) do
    begin
      cs := cs + WideChar(Data[p] or (Word(Data[p + 1]) shl 8));
      Inc(p, 2);
    end;
  end
  else
  begin
    while (p < NetMessage^.m_cbSize) and (Data[p] <> 0) do
    begin
      cs := cs + WideChar(Data[p]);
      Inc(p);
    end;
  end;

  // chat from server
  if i = 255 then
  begin
    if Copy(cs, 1, 5) = '/say ' then
      Delete(cs, 1, 5);
    MainConsole.Console(_('*SERVER*: ') + cs, SERVER_MESSAGE_COLOR);
    Exit;
  end;

  if (i < 1) or (i > MAX_PLAYERS) then
    Exit;
  if not Sprite[i].Active then
    Exit;

  if (Length(cs) > 0) and (cs[1] = '/') then
    Exit;  // commands are not meant to be displayed

  MsgType := MSGTYPE_PUB;
  RadioCommand := '';
  if Length(cs) > 0 then
    Delete(cs, 1, 1);  // prompt character
  if (Length(cs) > 0) and (cs[1] = '^') then
  begin
    MsgType := MSGTYPE_TEAM;
    Delete(cs, 1, 1);
  end
  else if (Length(cs) > 0) and (cs[1] = '*') then
  begin
    MsgType := MSGTYPE_RADIO;
    RadioCommand := Copy(cs, 2, 2);
    Delete(cs, 1, 3);
  end;

  if (Sprite[i].Muted = True) or MuteAll then
    Exit;

  ChatMessage[i] := cs;
  ChatTeam[i] := (MsgType = MSGTYPE_TEAM);
  d := String(cs).CountChar(' ');

  if d = 0 then
    ChatDelay[i] := Length(cs) * CHARDELAY
  else
    ChatDelay[i] := d * SPACECHARDELAY;

  if ChatDelay[i] > MAX_CHATDELAY then
    ChatDelay[i] := MAX_CHATDELAY;

  col := CHAT_MESSAGE_COLOR;

  if Sprite[i].Player.Team = TEAM_SPECTATOR then
    col := SPECTATOR_C_MESSAGE_COLOR;
  if (MsgType = MSGTYPE_TEAM) or (MsgType = MSGTYPE_RADIO) then
  begin
    col := TEAMCHAT_MESSAGE_COLOR;
    prefix := iif(MsgType = MSGTYPE_RADIO, '(RADIO)', _('(TEAM)')) + ' ';
  end;

  if Length(cs) < MORECHATTEXT then
    MainConsole.Console(prefix + '[' + WideString(Sprite[i].Player.Name) + '] ' + cs, col)
  else
  begin
    MainConsole.Console(prefix + '[' + WideString(Sprite[i].Player.Name) + '] ', col);
    MainConsole.Console(' ' + cs, col);
  end;

  if (MsgType = MSGTYPE_RADIO) and (MySprite > 0) and Sprite[i].IsInSameTeam(Sprite[MySprite]) then
    PlayRadioSound(StrToIntDef(String(RadioCommand), -1));
end;

procedure ClientHandleSpecialMessage(NetMessage: PSteamNetworkingMessage_t);
var
  SpecialMessage: TMsg_ServerSpecialMessage;
  cs: WideString;
begin
  if not VerifyPacketLargerOrEqual(SizeOf(TMsg_ServerSpecialMessage), NetMessage^.m_cbSize, MsgID_SpecialMessage) then
    Exit;
  SpecialMessage := PMsg_ServerSpecialMessage(NetMessage^.m_pData)^;
  PAnsiChar(NetMessage^.m_pData)[NetMessage^.m_cbSize - 1] := #0;
  cs := WideString(PAnsiChar(@PMsg_ServerSpecialMessage(NetMessage^.m_pData)^.Text));
  if SpecialMessage.LayerId > MAX_BIG_MESSAGES then
    SpecialMessage.LayerId := MAX_BIG_MESSAGES;

  if (SpecialMessage.MsgType = 0) then // console
  begin
    MainConsole.Console(cs, SpecialMessage.Color);
  end
  else if (SpecialMessage.MsgType = 1) then // big text
  begin
    BigText[SpecialMessage.LayerId] := cs;
    BigDelay[SpecialMessage.LayerId] := SpecialMessage.Delay;
    BigScale[SpecialMessage.LayerId] := SpecialMessage.Scale;
    BigColor[SpecialMessage.LayerId] := SpecialMessage.Color;
    BigPosX[SpecialMessage.LayerId] := SpecialMessage.X * _RScala.x;
    BigPosY[SpecialMessage.LayerId] := SpecialMessage.Y * _RScala.y;
    BigX[SpecialMessage.LayerId] := 100;
  end
  else // world text
  begin
    WorldText[SpecialMessage.LayerId] := cs;
    WorldDelay[SpecialMessage.LayerId] := SpecialMessage.Delay;
    WorldScale[SpecialMessage.LayerId] := SpecialMessage.Scale;
    WorldColor[SpecialMessage.LayerId] := SpecialMessage.Color;
    WorldPosX[SpecialMessage.LayerId] := SpecialMessage.X * _RScala.x;
    WorldPosY[SpecialMessage.LayerId] := SpecialMessage.Y * _RScala.y;
    WorldX[SpecialMessage.LayerId] := 100;
  end;
end;

end.
