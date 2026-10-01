{*************************************************************}
{                                                             }
{       Net Unit for SOLDAT (WebAssembly client, 1.7.1 wire)  }
{                                                             }
{       Copyright (c) 2002-2003 Michal Marcinkowski           }
{                                                             }
{   Speaks the Soldat 1.7.1 UDP protocol (reverse engineered  }
{   from the 2.8.2 dedicated server). Datagrams travel over a }
{   WebSocket to a relay that forwards them to the server.    }
{                                                             }
{*************************************************************}

unit Net;

interface

uses
  // System units
  Classes,
  fgl,
  SysUtils,

  // Library units
  Steam,

  // Helper units
  Vector,

  // Project units
  Constants,
  NetCrypt,
  GameRendering,
  Weapons;


const
  // Binary ops
  B1  =     1;
  B2  =     2;
  B3  =     4;
  B4  =     8;
  B5  =    16;
  B6  =    32;
  B7  =    64;
  B8  =   128;
  B9  =   256;
  B10 =   512;
  B11 =  1024;
  B12 =  2048;
  B13 =  4096;
  B14 =  8192;
  B15 = 16384;
  B16 = 32768;

  // MESSAGE IDs (Soldat 1.7.1)
  MsgID_HeartBeat                  =   2; // 32 player slots
  MsgID_ServerSpriteSnapshot       =   3;
  MsgID_ClientSpriteSnapshot       =   4;
  MsgID_BulletSnapshot             =   5;
  MsgID_ChatMessage                =   6;
  MsgID_ServerSkeletonSnapshot     =   7;
  MsgID_MapChange                  =   8;
  MsgID_ServerThingSnapshot        =   9;
  MsgID_ThingTaken                 =  12;
  MsgID_SpriteDeath                =  13;
  MsgID_RequestGame                =  14;
  MsgID_PlayerInfo                 =  15;
  MsgID_PlayersList                =  16;
  MsgID_NewPlayer                  =  17;
  MsgID_ServerDisconnect           =  18;
  MsgID_PlayerDisconnect           =  19;
  MsgID_Delta_Movement             =  21;
  MsgID_Delta_Weapons              =  25;
  MsgID_Delta_Helmet               =  26;
  MsgID_Delta_MouseAim             =  29;
  MsgID_Ping                       =  30;
  MsgID_Pong                       =  31;
  MsgID_FlagInfo                   =  32;
  MsgID_ServerThingMustSnapshot    =  33;
  MsgID_RequestPlayer              =  34;
  MsgID_HeartBeat16                =  35; // 16 player slots
  MsgID_HeartBeat8                 =  36; // 8 player slots
  MsgID_IdleAnimation              =  37;
  MsgID_StatusRequest              =  40; // server -> client
  MsgID_StatusReply                =  40; // client -> server
  MsgID_ServerSpriteSnapshot_Major =  41;
  MsgID_ClientSpriteSnapshot_Mov   =  42;
  MsgID_ClientSpriteSnapshot_Dead  =  43;
  MsgID_UnAccepted                 =  44;
  MsgID_VoteOn                     =  45;
  MsgID_VoteMap                    =  46;
  MsgID_VoteKick                   =  47;
  MsgID_RequestMap                 =  49;
  MsgID_RequestThing               =  51;
  MsgID_ServerVars                 =  52;
  MsgID_RequestServerVars          =  53;
  MsgID_ServerSyncMsg              =  54;
  MsgID_ClientFreeCam              =  55;
  MsgID_VoteOff                    =  56;
  MsgID_ForcePosition              =  60;
  MsgID_ForceVelocity              =  61;
  MsgID_ForceWeapon                =  62;
  MsgID_ChangeTeam                 =  63;
  MsgID_SpecialMessage             =  64;
  MsgID_WeaponActiveMessage        =  65;
  MsgID_UnicodeChatMessage         =  66;
  MsgID_Gravity                    =  69;
  MsgID_PlaySound                  =  70;
  MsgID_Compressed                 = 255;

  MAX_PLAYERS = 32;

  // ControlMethod
  HUMAN = 1;
  BOT   = 2;

  // Request Reply States
  OK                 =  1;
  WRONG_VERSION      =  2;
  WRONG_PASSWORD     =  3;
  BANNED_IP          =  4;
  SERVER_FULL        =  5;
  INVALID_HWID       =  7;
  INVALID_HANDSHAKE  =  8;
  WRONG_CHECKSUM     =  9;
  ANTICHEAT_REQUIRED = 10;
  ANTICHEAT_REJECTED = 11;
  STEAM_ONLY         = 12;

  LAN      = 1;
  INTERNET = 0;

  // FLAG INFO
  RETURNRED   = 1;
  RETURNBLUE  = 2;
  CAPTURERED  = 3;
  CAPTUREBLUE = 4;

  // Kick/Ban Why's
  KICK_UNKNOWN         =  0;
  KICK_NORESPONSE      =  1;
  KICK_NOCHEATRESPONSE =  2;
  KICK_CHANGETEAM      =  3;
  KICK_PING            =  4;
  KICK_FLOODING        =  5;
  KICK_CONSOLE         =  6;
  KICK_CONNECTCHEAT    =  7;
  KICK_CHEAT           =  8;
  KICK_LEFTGAME        =  9;
  KICK_VOTED           = 10;
  KICK_AC              = 11;
  KICK_SILENT          = 12;
  KICK_STEAMTICKET     = 13;
  _KICK_END            = 14;

  // Join types
  JOIN_NORMAL = 0;
  JOIN_SILENT = 1;

  // RECORD
  NETW = 0;
  REC  = 1;

  CLIENTPLAYERRECIEVED_TIME = 3 * 60;

  FLOODIP_MAX  = 18;
  MAX_FLOODIPS = 1000;
  MAX_BANIPS   = 1000;

  PLAYERNAME_CHARS = 24;
  PLAYERHWID_CHARS = 11;
  MAPNAME_CHARS    = 64;
  NET_MAPNAME_CHARS = 16;  // map names are limited to 16 characters on the 1.7.1 wire
  REASON_CHARS     = 26;

  ACTYPE_NONE = 0;
  ACTYPE_FAE  = 1;

  MSGTYPE_CMD   = 0;
  MSGTYPE_PUB   = 1;
  MSGTYPE_TEAM  = 2;
  MSGTYPE_RADIO = 3;

  // MapID the 1.7.1 server expects in PlayerInfo and sends in PlayersList
  PLAYERSLIST_MAPID = $25B400;

  // Connection states reported by the JavaScript transport
  NETSTATE_CONNECTING = 0;
  NETSTATE_OPEN       = 1;
  NETSTATE_CLOSED     = 2;

type
  // Network Player Class (client side)
  TPlayer = class
  public
    Name: string;
    ShirtColor, PantsColor, SkinColor, HairColor, JetColor: LongWord;
    Kills, Deaths: Integer;
    Flags: Byte;
    PingTicks, PingTicksB, PingTime, Ping: Integer;
    RealPing: Word;
    ConnectionQuality: Byte;
    Team: Byte;
    ControlMethod: Byte;
    Chain, HeadCap, HairStyle: Byte;
    SecWep: Byte;
    Camera: Byte;
    Muted: Byte;
    SpriteNum: Byte; // 0 if no sprite exists yet
    DemoPlayer: Boolean;
    procedure ApplyShirtColorFromTeam;
    function Clone: TPlayer;
  end;

  TPlayers = TFPGObjectList<TPlayer>;

  TStatsString = array[0..2048] of Char;

  PMsgHeader = ^TMsgHeader;
  TMsgHeader = packed record
    ID: Byte;
    Hash: Word;
  end;

  { ---------------------------------------------------------------------- }
  { Client -> Server                                                        }
  { ---------------------------------------------------------------------- }

  PMsg_RequestGame = ^TMsg_RequestGame;
  TMsg_RequestGame = packed record
    Header: TMsgHeader;
    Forwarded: Byte;
    Version: array[0..4] of Char;
    Name: array[0..PLAYERNAME_CHARS - 1] of Char;
    HardwareID: string[PLAYERHWID_CHARS];
    Password: array[0..0] of Char;  // null terminated, variable length
  end;

  PMsg_PlayerInfo = ^TMsg_PlayerInfo;
  TMsg_PlayerInfo = packed record
    Header: TMsgHeader;
    Name: array[0..PLAYERNAME_CHARS - 1] of Char;
    MapID: LongWord;
    Look: Byte;
    Team: Byte;
    ShirtColor, PantsColor, SkinColor, HairColor, JetColor: LongWord;
    HardwareID: string[PLAYERHWID_CHARS];
  end;

  PMsg_ClientSpriteSnapshot = ^TMsg_ClientSpriteSnapshot;
  TMsg_ClientSpriteSnapshot = packed record
    Header: TMsgHeader;
    AmmoCount, SecondaryAmmoCount: Byte;
    WeaponNum, SecondaryWeaponNum: Byte;
    Position: Byte;
  end;

  PMsg_ClientSpriteSnapshot_Mov = ^TMsg_ClientSpriteSnapshot_Mov;
  TMsg_ClientSpriteSnapshot_Mov = packed record
    Header: TMsgHeader;
    Pos, Velocity: TVector2;
    Keys16: Word;
    MouseAimX, MouseAimY: SmallInt;
  end;

  PMsg_ClientSpriteSnapshot_Dead = ^TMsg_ClientSpriteSnapshot_Dead;
  TMsg_ClientSpriteSnapshot_Dead = packed record
    Header: TMsgHeader;
    CameraFocus: Byte;
  end;

  PMsg_ClientBulletSnapshot = ^TMsg_ClientBulletSnapshot;
  TMsg_ClientBulletSnapshot = packed record
    Header: TMsgHeader;
    WeaponNum: Byte;
    Pos, Velocity: TVector2;
    Seed: Word;
    ClientTicks: LongInt;
  end;

  PMsg_Pong = ^TMsg_Pong;
  TMsg_Pong = packed record
    Header: TMsgHeader;
    PingNum: Byte;
  end;

  PMsg_RequestPlayer = ^TMsg_RequestPlayer;
  TMsg_RequestPlayer = packed record
    Header: TMsgHeader;
    Num: Byte;
  end;

  PMsg_StatusReply = ^TMsg_StatusReply;
  TMsg_StatusReply = packed record
    Header: TMsgHeader;
    RealisticMode: Byte;
    JetCount: LongInt;
    Reserved: Byte;
  end;

  PMsg_VoteMap = ^TMsg_VoteMap;
  TMsg_VoteMap = packed record
    Header: TMsgHeader;
    MapName: array[0..NET_MAPNAME_CHARS - 1] of Char;
    Reason: array[0..REASON_CHARS - 1] of Char;
  end;

  PMsg_VoteKick = ^TMsg_VoteKick;
  TMsg_VoteKick = packed record
    Header: TMsgHeader;
    Ban: Byte;
    Num: Byte;
    Reason: array[0..REASON_CHARS - 1] of Char;
  end;

  PMsg_RequestMap = ^TMsg_RequestMap;
  TMsg_RequestMap = packed record
    Header: TMsgHeader;
  end;

  PMsg_RequestThing = ^TMsg_RequestThing;
  TMsg_RequestThing = packed record
    Header: TMsgHeader;
    ThingID: Byte;
  end;

  PMsg_RequestServerVars = ^TMsg_RequestServerVars;
  TMsg_RequestServerVars = packed record
    Header: TMsgHeader;
    Num: Byte;
  end;

  PMsg_ClientFreeCam = ^TMsg_ClientFreeCam;
  TMsg_ClientFreeCam = packed record
    Header: TMsgHeader;
    FreeCamOn: Byte;
    TargetPos: TVector2;
  end;

  PMsg_ChangeTeam = ^TMsg_ChangeTeam;
  TMsg_ChangeTeam = packed record
    Header: TMsgHeader;
    Team: Byte;
  end;

  // Chat message, both directions. ID 6 carries an ANSI text, ID 66 a UTF-16 text.
  PMsg_StringMessage = ^TMsg_StringMessage;
  TMsg_StringMessage = packed record
    Header: TMsgHeader;
    Num: Byte;
    Text: array[0..0] of Char;
  end;

  PMsg_PlayerDisconnect = ^TMsg_PlayerDisconnect;
  TMsg_PlayerDisconnect = packed record
    Header: TMsgHeader;
    Num: Byte;
    Why: Byte;
  end;

  { ---------------------------------------------------------------------- }
  { Server -> Client                                                        }
  { ---------------------------------------------------------------------- }

  PMsg_Ping = ^TMsg_Ping;
  TMsg_Ping = packed record
    Header: TMsgHeader;
    PingTicks: Byte;
    PingNum: Byte;
  end;

  PMsg_ServerSpriteSnapshot = ^TMsg_ServerSpriteSnapshot;
  TMsg_ServerSpriteSnapshot = packed record
    Header: TMsgHeader;
    Num: Byte;
    Pos, Velocity: TVector2;
    AimAngle: Byte;
    Position: Byte;
    Keys16: Word;
    Look: Byte;
    Vest: Single;
    Health: Single;
    AmmoCount, GrenadeCount: Byte;
    WeaponNum, SecondaryWeaponNum: Byte;
    ServerTicks: LongInt;
  end;

  PMsg_ServerSpriteSnapshot_Major = ^TMsg_ServerSpriteSnapshot_Major;
  TMsg_ServerSpriteSnapshot_Major = packed record
    Header: TMsgHeader;
    Num: Byte;
    Pos, Velocity: TVector2;
    Health: Single;
    AimAngle: Byte;
    Position: Byte;
    Keys16: Word;
    ServerTicks: LongInt;
  end;

  PMsg_BulletSnapshot = ^TMsg_BulletSnapshot;
  TMsg_BulletSnapshot = packed record
    Header: TMsgHeader;
    Owner, WeaponNum: Byte;
    Pos, Velocity: TVector2;
    Seed: Word;
    Forced: Boolean;
  end;

  PMsg_ServerSkeletonSnapshot = ^TMsg_ServerSkeletonSnapshot;
  TMsg_ServerSkeletonSnapshot = packed record
    Header: TMsgHeader;
    Num: Byte;
    RespawnCounter: SmallInt;
  end;

  PMsg_MapChange = ^TMsg_MapChange;
  TMsg_MapChange = packed record
    Header: TMsgHeader;
    Counter: SmallInt;
    MapName: string[NET_MAPNAME_CHARS];
  end;

  PMsg_ServerThingSnapshot = ^TMsg_ServerThingSnapshot;
  TMsg_ServerThingSnapshot = packed record
    Header: TMsgHeader;
    Num, Owner, Style, HoldingSprite: Byte;
    Pos, OldPos: array[1..4] of TVector2;
  end;

  PMsg_ServerThingMustSnapshot = ^TMsg_ServerThingMustSnapshot;
  TMsg_ServerThingMustSnapshot = packed record
    Header: TMsgHeader;
    Num, Owner, Style, HoldingSprite: Byte;
    Pos, OldPos: array[1..4] of TVector2;
    Timeout: SmallInt;
  end;

  PMsg_ServerThingTaken = ^TMsg_ServerThingTaken;
  TMsg_ServerThingTaken = packed record
    Header: TMsgHeader;
    Num, Who: Byte;
    Style, AmmoCount: Byte;
  end;

  PMsg_SpriteDeath = ^TMsg_SpriteDeath;
  TMsg_SpriteDeath = packed record
    Header: TMsgHeader;
    Num, Killer, KillBullet, Where: Byte;
    Constraints: Byte;
    Pos, OldPos: array[1..16] of TVector2;
    Health: Single;
    OnFire: Byte;
    RespawnCounter: SmallInt;
    ShotDistance, ShotLife: Single;
    ShotRicochet: Byte;
  end;

  PMsg_PlayersList = ^TMsg_PlayersList;
  TMsg_PlayersList = packed record
    Header: TMsgHeader;
    MapName: array[0..NET_MAPNAME_CHARS - 1] of Char;
    GameStyle: Byte;          // encrypted (2nd)
    Players: Byte;
    KillLimit: Word;
    Flags: Byte;
    ServerName: array[0..23] of Char;
    ServerInfo: array[0..59] of Char;
    Name: array[1..MAX_PLAYERS] of array[0..PLAYERNAME_CHARS - 1] of Char;
    ShirtColor, PantsColor, SkinColor, HairColor, JetColor: array[1..MAX_PLAYERS] of LongWord;
    Team: array[1..MAX_PLAYERS] of Byte;
    PredDuration: array[1..MAX_PLAYERS] of Byte;
    MapID: LongWord;          // encrypted (1st)
    Gravity: Single;          // encrypted (3rd)
    Look: array[1..MAX_PLAYERS] of Byte;
    Pos: array[1..MAX_PLAYERS] of TVector2;
    Vel: array[1..MAX_PLAYERS] of TVector2;
    Reserved: Word;
    SessionID: Word;
    TimeLimit: LongInt;
    CurrentTime: LongInt;
    MaxGrenades: Byte;
    ServerTicks: LongInt;
    SurvivalClearWeapons: Byte;
  end;

  // UnAccepted: State at 3, Text (null terminated) at 4, Version at 5..9 (only
  // meaningful when Text is empty - the server writes the text over it).
  PMsg_UnAccepted = ^TMsg_UnAccepted;
  TMsg_UnAccepted = packed record
    Header: TMsgHeader;
    State: Byte;
    Text: Char;
    Version: array[0..4] of Char;
  end;

  PMsg_NewPlayer = ^TMsg_NewPlayer;
  TMsg_NewPlayer = packed record
    Header: TMsgHeader;
    Num: Byte;
    Reserved: Word;
    JoinType: Byte;
    Name: array[0..PLAYERNAME_CHARS - 1] of Char;
    ShirtColor, PantsColor, SkinColor, HairColor, JetColor: LongWord;
    Team: Byte;
    Look: Byte;
    Pos: TVector2;
  end;

  PMsg_ServerDisconnect = ^TMsg_ServerDisconnect;
  TMsg_ServerDisconnect = packed record
    Header: TMsgHeader;
  end;

  PMsg_IdleAnimation = ^TMsg_IdleAnimation;
  TMsg_IdleAnimation = packed record
    Header: TMsgHeader;
    Num: Byte;
    IdleRandom: SmallInt;
  end;

  // DELTAS
  PMsg_ServerSpriteDelta_Movement = ^TMsg_ServerSpriteDelta_Movement;
  TMsg_ServerSpriteDelta_Movement = packed record
    Header: TMsgHeader;
    Num: Byte;
    Pos, Velocity: TVector2;
    Keys16: Word;
    AimAngle: Byte;
    ServerTick: LongInt;
  end;

  PMsg_ServerSpriteDelta_MouseAim = ^TMsg_ServerSpriteDelta_MouseAim;
  TMsg_ServerSpriteDelta_MouseAim = packed record
    Header: TMsgHeader;
    Num: Byte;
    AimAngle: Byte;
    AimDistance: Byte;  // distance div 100
  end;

  PMsg_ServerSpriteDelta_Weapons = ^TMsg_ServerSpriteDelta_Weapons;
  TMsg_ServerSpriteDelta_Weapons = packed record
    Header: TMsgHeader;
    Num: Byte;
    WeaponNum, SecondaryWeaponNum: Byte;
    AmmoCount: Byte;
  end;

  PMsg_ServerSpriteDelta_Helmet = ^TMsg_ServerSpriteDelta_Helmet;
  TMsg_ServerSpriteDelta_Helmet = packed record
    Header: TMsgHeader;
    Num: Byte;
    WearHelmet: Byte;
  end;

  PMsg_ServerFlagInfo = ^TMsg_ServerFlagInfo;
  TMsg_ServerFlagInfo = packed record
    Header: TMsgHeader;
    Style, Who: Byte;
  end;

  PMsg_ServerSyncMsg = ^TMsg_ServerSyncMsg;
  TMsg_ServerSyncMsg = packed record
    Header: TMsgHeader;
    Time: LongInt;
    Pause: Byte;
  end;

  PMsg_VoteOn = ^TMsg_VoteOn;
  TMsg_VoteOn = packed record
    Header: TMsgHeader;
    VoteType: Byte;
    Timer: Word;
    Who: Byte;
    TargetName: array[0..NET_MAPNAME_CHARS - 1] of Char;
    Reason: array[0..REASON_CHARS - 1] of Char;
  end;

  PMsg_VoteOff = ^TMsg_VoteOff;
  TMsg_VoteOff = packed record
    Header: TMsgHeader;
  end;

  PMsg_ServerVars = ^TMsg_ServerVars;
  TMsg_ServerVars = packed record
    Header: TMsgHeader;
    FriendlyFire: Byte;
    AdvanceAmount: Byte;
    TimeLimit: LongInt;
    DisableMinimap: Byte;
    AdvancedSpectate: Byte;
    Radio: Byte;
    Damage:            array[1..ORIGINAL_WEAPONS] of Single;
    Ammo:              array[1..ORIGINAL_WEAPONS] of Byte;
    ReloadTime:        array[1..ORIGINAL_WEAPONS] of Word;
    Speed:             array[1..ORIGINAL_WEAPONS] of Single;
    BulletStyle:       array[1..ORIGINAL_WEAPONS] of Byte;
    StartUpTime:       array[1..ORIGINAL_WEAPONS] of Word;
    Bink:              array[1..ORIGINAL_WEAPONS] of SmallInt;
    FireInterval:      array[1..ORIGINAL_WEAPONS] of Word;
    MovementAcc:       array[1..ORIGINAL_WEAPONS] of Single;
    BulletSpread:      array[1..ORIGINAL_WEAPONS] of Single;
    Recoil:            array[1..ORIGINAL_WEAPONS] of Word;
    Push:              array[1..ORIGINAL_WEAPONS] of Single;
    InheritedVelocity: array[1..ORIGINAL_WEAPONS] of Single;
    ModifierHead:      array[1..ORIGINAL_WEAPONS] of Single;
    ModifierChest:     array[1..ORIGINAL_WEAPONS] of Single;
    ModifierLegs:      array[1..ORIGINAL_WEAPONS] of Single;
    WeaponActive:      array[1..MAIN_WEAPONS] of Byte;
  end;

  PMsg_ForcePosition = ^TMsg_ForcePosition;
  TMsg_ForcePosition = packed record
    Header: TMsgHeader;
    Pos: TVector2;
    PlayerID: Byte;
  end;

  PMsg_ForceVelocity = ^TMsg_ForceVelocity;
  TMsg_ForceVelocity = packed record
    Header: TMsgHeader;
    Vel: TVector2;
    PlayerID: Byte;
  end;

  PMsg_ForceWeapon = ^TMsg_ForceWeapon;
  TMsg_ForceWeapon = packed record
    Header: TMsgHeader;
    WeaponNum, SecondaryWeaponNum: Byte;
    AmmoCount, SecAmmoCount: Byte;
  end;

  PMsg_ServerSpecialMessage = ^TMsg_ServerSpecialMessage;
  TMsg_ServerSpecialMessage = packed record
    Header: TMsgHeader;
    MsgType: Byte;  // 0 - console, 1 - big text, 2 - world text
    LayerId: Byte;
    Delay: Integer;
    Scale: Single;
    Color: UInt32;
    X, Y: Single;
    Text: array[0..0] of Char;
  end;

  PMsg_WeaponActiveMessage = ^TMsg_WeaponActiveMessage;
  TMsg_WeaponActiveMessage = packed record
    Header: TMsgHeader;
    Active, Weapon: Byte;
  end;

  PMsg_Gravity = ^TMsg_Gravity;
  TMsg_Gravity = packed record
    Header: TMsgHeader;
    Grav: Single;
  end;

  PMsg_PlaySound = ^TMsg_PlaySound;
  TMsg_PlaySound = packed record
    Header: TMsgHeader;
    Name: array[0..26] of Char;
    Emitter: TVector2;
  end;

  TClientNetwork = class
  private
    FActive: Boolean;
    FHost: AnsiString;
    FPort: Word;
    FRecvBuf: array[0..65535] of Byte;
    FUnpackBuf: array[0..65535] of Byte;
    FStartTime: Int64;
    // traffic statistics, sampled once per second
    FRateTick: Integer;
    FRateBase: array[0..3] of Int64;
    FRates: array[0..3] of Single;
  public
    Cipher: TNetCipher;
    BytesSent, BytesReceived: Int64;
    PacketsSent, PacketsReceived: Int64;
    LastReceiveTick: Integer;
    constructor Create();
    destructor Destroy(); override;
    function Connect(Host: String; Port: Word): Boolean;
    function Disconnect(Now: Boolean): Boolean;
    function State: Integer;
    procedure FlushMsg();
    procedure ProcessLoop;
    procedure HandleDatagram(Data: PByte; Size: Integer);
    procedure HandleMessages(IncomingMsg: PSteamNetworkingMessage_t);
    function SendData(var Data; Size: Integer; Flags: Integer): Boolean;
    function AddressString(WithPort: Boolean): AnsiString;
    function GetDetailedConnectionStatus: String;
    function GetConnectionRealTimeStatus: SteamNetConnectionRealTimeStatus_t;
    property Active: Boolean read FActive write FActive;
    property Host: AnsiString read FHost;
    property Port: Word read FPort;
  end;

function MessageSize(ID: Byte): Integer;
function AimFromAngle(const Origin: TVector2; Angle: Byte; Distance: Single): TVector2;

var
  MainTickCounter: Integer;
  // Stores all network-generated TPlayer objects
  Players: TPlayers;

  ClientTickCount, LastHeartBeatCounter: LongInt;
  ClientPlayerReceivedCounter: Integer;
  ClientPlayerReceived, ClientPlayerSent: Boolean;
  ClientVarsRecieved: Boolean;
  RequestingGame: Boolean;
  RequestGameRetryTicks: Integer = 0;
  NoHeartbeatTime: Integer = 0;
  ReceivedUnAccepted: Boolean;
  VoteMapName: String;
  VoteMapCount: Word;
  SessionID: Word = 0;

  PlayersNum, BotsNum, SpectatorsNum: Integer;
  PlayersTeamNum: array[1..4] of Integer;

  PingTicksAdd: Integer = 2;

implementation

uses
  Client, Game, TraceLog, Demo, paszlib,
  NetworkClientSprite, NetworkClientConnection, NetworkClientThing,
  NetworkClientGame, NetworkClientFunctions, NetworkClientHeartbeat,
  NetworkClientMessages, NetworkClientBullet;

function js_net_connect(Host: PAnsiChar; Port: LongInt): LongInt; cdecl; external 'net' name 'connect';
function js_net_state: LongInt; cdecl; external 'net' name 'state';
function js_net_send(Data: Pointer; Size: LongInt): LongInt; cdecl; external 'net' name 'send';
function js_net_recv(Buf: Pointer; MaxSize: LongInt): LongInt; cdecl; external 'net' name 'recv';
procedure js_net_close; cdecl; external 'net' name 'close';
function js_net_ping: LongInt; cdecl; external 'net' name 'ping';

// Size of fixed-size server messages; -1 for variable length (consumes the rest of the
// datagram). Several fixed-size messages may be concatenated in one datagram.
function MessageSize(ID: Byte): Integer;
begin
  case ID of
    MsgID_HeartBeat:                  Result := 303;
    MsgID_ServerSpriteSnapshot:       Result := SizeOf(TMsg_ServerSpriteSnapshot);
    MsgID_BulletSnapshot:             Result := SizeOf(TMsg_BulletSnapshot);
    MsgID_ServerSkeletonSnapshot:     Result := SizeOf(TMsg_ServerSkeletonSnapshot);
    MsgID_MapChange:                  Result := SizeOf(TMsg_MapChange);
    MsgID_ServerThingSnapshot:        Result := SizeOf(TMsg_ServerThingSnapshot);
    MsgID_ThingTaken:                 Result := SizeOf(TMsg_ServerThingTaken);
    MsgID_SpriteDeath:                Result := SizeOf(TMsg_SpriteDeath);
    MsgID_PlayersList:                Result := SizeOf(TMsg_PlayersList);
    MsgID_NewPlayer:                  Result := SizeOf(TMsg_NewPlayer);
    MsgID_ServerDisconnect:           Result := SizeOf(TMsg_ServerDisconnect);
    MsgID_PlayerDisconnect:           Result := SizeOf(TMsg_PlayerDisconnect);
    MsgID_Delta_Movement:             Result := SizeOf(TMsg_ServerSpriteDelta_Movement);
    MsgID_Delta_Weapons:              Result := SizeOf(TMsg_ServerSpriteDelta_Weapons);
    MsgID_Delta_Helmet:               Result := SizeOf(TMsg_ServerSpriteDelta_Helmet);
    MsgID_Delta_MouseAim:             Result := SizeOf(TMsg_ServerSpriteDelta_MouseAim);
    MsgID_Ping:                       Result := SizeOf(TMsg_Ping);
    MsgID_FlagInfo:                   Result := SizeOf(TMsg_ServerFlagInfo);
    MsgID_ServerThingMustSnapshot:    Result := SizeOf(TMsg_ServerThingMustSnapshot);
    MsgID_HeartBeat16:                Result := 159;
    MsgID_HeartBeat8:                 Result := 87;
    MsgID_IdleAnimation:              Result := SizeOf(TMsg_IdleAnimation);
    MsgID_StatusRequest:              Result := 3;
    MsgID_ServerSpriteSnapshot_Major: Result := SizeOf(TMsg_ServerSpriteSnapshot_Major);
    MsgID_VoteOn:                     Result := SizeOf(TMsg_VoteOn);
    MsgID_ServerVars:                 Result := SizeOf(TMsg_ServerVars);
    MsgID_ServerSyncMsg:              Result := SizeOf(TMsg_ServerSyncMsg);
    MsgID_VoteOff:                    Result := SizeOf(TMsg_VoteOff);
    MsgID_ForcePosition:              Result := SizeOf(TMsg_ForcePosition);
    MsgID_ForceVelocity:              Result := SizeOf(TMsg_ForceVelocity);
    MsgID_ForceWeapon:                Result := SizeOf(TMsg_ForceWeapon);
    MsgID_WeaponActiveMessage:        Result := SizeOf(TMsg_WeaponActiveMessage);
    MsgID_Gravity:                    Result := SizeOf(TMsg_Gravity);
    MsgID_PlaySound:                  Result := SizeOf(TMsg_PlaySound);
    127:                              Result := 3;
  else
    Result := -1;
  end;
end;

// The server encodes aim as Round(127.5/Pi * Angle2Points(MouseAim, Skeleton.Pos[15]))
// truncated to a byte, i.e. the direction from the aim point towards the gostek.
function AimFromAngle(const Origin: TVector2; Angle: Byte; Distance: Single): TVector2;
var
  a: Single;
begin
  a := Angle * Pi / 127.5;
  Result.X := Origin.X - Cos(a) * Distance;
  Result.Y := Origin.Y - Sin(a) * Distance;
end;

constructor TClientNetwork.Create();
begin
  Cipher := TNetCipher.Create;
end;

destructor TClientNetwork.Destroy();
begin
  Disconnect(True);
  Cipher.Free;
  inherited Destroy();
end;

function TClientNetwork.Connect(Host: String; Port: Word): Boolean;
begin
  FHost := Host;
  FPort := Port;
  BytesSent := 0;
  BytesReceived := 0;
  PacketsSent := 0;
  PacketsReceived := 0;
  SessionID := 0;
  Debug('[NET] Connecting to: ' + Host + ':' + IntToStr(Port));
  Result := js_net_connect(PAnsiChar(AnsiString(Host)), Port) = 0;
  FActive := Result;
end;

function TClientNetwork.Disconnect(Now: Boolean): Boolean;
begin
  Result := FActive;
  if FActive then
    js_net_close;
  FActive := False;
end;

function TClientNetwork.State: Integer;
begin
  Result := js_net_state;
end;

procedure TClientNetwork.FlushMsg();
begin
end;

function TClientNetwork.AddressString(WithPort: Boolean): AnsiString;
begin
  if WithPort then
    Result := FHost + ':' + IntToStr(FPort)
  else
    Result := FHost;
end;

function TClientNetwork.GetDetailedConnectionStatus: String;
begin
  Result := 'Server ' + AddressString(True) + ' (Soldat 1.7.1 protocol via WebSocket relay)' + #10 +
    'Packets sent: ' + IntToStr(PacketsSent) + ', received: ' + IntToStr(PacketsReceived) + #10 +
    'Bytes sent: ' + IntToStr(BytesSent) + ', received: ' + IntToStr(BytesReceived);
end;

function TClientNetwork.GetConnectionRealTimeStatus: SteamNetConnectionRealTimeStatus_t;
var
  Now: array[0..3] of Int64;
  i: Integer;
begin
  Now[0] := PacketsSent;
  Now[1] := BytesSent;
  Now[2] := PacketsReceived;
  Now[3] := BytesReceived;
  if (MainTickCounter - FRateTick >= 60) or (MainTickCounter < FRateTick) then
  begin
    for i := 0 to 3 do
    begin
      if MainTickCounter > FRateTick then
        FRates[i] := (Now[i] - FRateBase[i]) * 60 / (MainTickCounter - FRateTick);
      FRateBase[i] := Now[i];
    end;
    FRateTick := MainTickCounter;
  end;

  Result := Default(SteamNetConnectionRealTimeStatus_t);
  Result.m_nPing := js_net_ping;
  Result.m_flConnectionQualityLocal := 1;
  Result.m_flConnectionQualityRemote := 1;
  Result.m_flOutPacketsPerSec := FRates[0];
  Result.m_flOutBytesPerSec := FRates[1];
  Result.m_flInPacketsPerSec := FRates[2];
  Result.m_flInBytesPerSec := FRates[3];
end;

procedure TClientNetwork.ProcessLoop;
var
  Size: Integer;
begin
  if not FActive then
    Exit;
  repeat
    Size := js_net_recv(@FRecvBuf[0], SizeOf(FRecvBuf));
    if Size > 0 then
    begin
      Inc(PacketsReceived);
      Inc(BytesReceived, Size);
      HandleDatagram(@FRecvBuf[0], Size);
      if not FActive then
        Break;
    end;
  until Size <= 0;
end;

procedure TClientNetwork.HandleDatagram(Data: PByte; Size: Integer);
var
  Pos, Len, Remaining: Integer;
  DestLen: Cardinal;
  Msg: SteamNetworkingMessage_t;
begin
  if Size < 1 then
    Exit;

  if Data[0] = MsgID_Compressed then
  begin
    DestLen := SizeOf(FUnpackBuf);
    if uncompress(PChar(@FUnpackBuf[0]), DestLen, PChar(@Data[1]), Size - 1) <> Z_OK then
    begin
      Debug('[NET] Failed to decompress packet');
      Exit;
    end;
    Data := @FUnpackBuf[0];
    Size := DestLen;
  end;

  Pos := 0;
  while Pos < Size do
  begin
    Remaining := Size - Pos;
    Len := MessageSize(Data[Pos]);
    if (Len <= 0) or (Len > Remaining) then
      Len := Remaining;
    if (Len >= SizeOf(TMsgHeader)) and CheckPacketHash(@Data[Pos], Len) then
    begin
      Msg.m_pData := @Data[Pos];
      Msg.m_cbSize := Len;
      HandleMessages(@Msg);
      if not FActive then
        Exit;
    end
    else
      Debug('[NET] Dropped message ' + IntToStr(Data[Pos]) + ' (bad hash or size ' +
        IntToStr(Len) + ')');
    Inc(Pos, Len);
  end;
end;

procedure TClientNetwork.HandleMessages(IncomingMsg: PSteamNetworkingMessage_t);
var
  PacketHeader: PMsgHeader;
begin
  if IncomingMsg^.m_cbSize < SizeOf(TMsgHeader) then
    Exit; // truncated packet

  PacketHeader := PMsgHeader(IncomingMsg^.m_pData);
  LastReceiveTick := MainTickCounter;

  // players the server still sends news about (byte 3: player slot)
  if IncomingMsg^.m_cbSize > 3 then
    case PacketHeader.ID of
      MsgID_NewPlayer, MsgID_ServerSpriteSnapshot, MsgID_ServerSpriteSnapshot_Major,
      MsgID_ServerSkeletonSnapshot, MsgID_SpriteDeath, MsgID_Delta_Movement,
      MsgID_Delta_MouseAim, MsgID_Delta_Weapons, MsgID_Delta_Helmet, MsgID_IdleAnimation:
        NoteSpriteHeard(PByte(IncomingMsg^.m_pData)[3]);
    end;

  case PacketHeader.ID of
    MsgID_PlayersList:
      ClientHandlePlayersList(IncomingMsg);

    MsgID_UnAccepted:
      ClientHandleUnAccepted(IncomingMsg);

    MsgID_NewPlayer:
      ClientHandleNewPlayer(IncomingMsg);

    // PLAYING GAME MESSAGES

    MsgID_ServerSpriteSnapshot:
      ClientHandleServerSpriteSnapshot(IncomingMsg);

    MsgID_ServerSpriteSnapshot_Major:
      ClientHandleServerSpriteSnapshot_Major(IncomingMsg);

    MsgID_ServerSkeletonSnapshot:
      ClientHandleServerSkeletonSnapshot(IncomingMsg);

    MsgID_BulletSnapshot:
      ClientHandleBulletSnapshot(IncomingMsg);

    MsgID_HeartBeat, MsgID_HeartBeat16, MsgID_HeartBeat8:
      ClientHandleHeartBeat(IncomingMsg);

    MsgID_ServerThingSnapshot:
      ClientHandleServerThingSnapshot(IncomingMsg);

    MsgID_ServerThingMustSnapshot:
      ClientHandleServerThingMustSnapshot(IncomingMsg);

    MsgID_ThingTaken:
      ClientHandleThingTaken(IncomingMsg);

    MsgID_SpriteDeath:
      ClientHandleSpriteDeath(IncomingMsg);

    MsgID_ServerDisconnect:
      ClientHandleServerDisconnect(IncomingMsg);

    MsgID_PlayerDisconnect:
      ClientHandlePlayerDisconnect(IncomingMsg);

    MsgID_Delta_Movement:
      ClientHandleDelta_Movement(IncomingMsg);

    MsgID_Delta_MouseAim:
      ClientHandleDelta_MouseAim(IncomingMsg);

    MsgID_Delta_Weapons:
      ClientHandleDelta_Weapons(IncomingMsg);

    MsgID_Delta_Helmet:
      ClientHandleDelta_Helmet(IncomingMsg);

    MsgID_ChatMessage, MsgID_UnicodeChatMessage:
      ClientHandleChatMessage(IncomingMsg);

    MsgID_Ping:
      ClientHandlePing(IncomingMsg);

    MsgID_MapChange:
      ClientHandleMapChange(IncomingMsg);

    MsgID_FlagInfo:
      ClientHandleFlagInfo(IncomingMsg);

    MsgID_IdleAnimation:
      ClientHandleIdleAnimation(IncomingMsg);

    MsgID_VoteOn:
      ClientHandleVoteOn(IncomingMsg);

    MsgID_StatusRequest:
      ClientHandleStatusRequest(IncomingMsg);

    MsgID_ServerVars:
      ClientHandleServerVars(IncomingMsg);

    MsgID_ServerSyncMsg:
      ClientHandleServerSyncMsg(IncomingMsg);

    MsgID_ForcePosition:
      ClientHandleForcePosition(IncomingMsg);

    MsgID_ForceVelocity:
      ClientHandleForceVelocity(IncomingMsg);

    MsgID_ForceWeapon:
      ClientHandleForceWeapon(IncomingMsg);

    MsgID_SpecialMessage:
      ClientHandleSpecialMessage(IncomingMsg);

    MsgID_WeaponActiveMessage:
      ClientHandleWeaponActiveMessage(IncomingMsg);

    MsgID_VoteOff:
      ClientHandleVoteOff;

    MsgID_Gravity:
      ClientHandleGravity(IncomingMsg);

    MsgID_PlaySound:
      ClientHandlePlaySound(IncomingMsg);
  end;
end;

function TClientNetwork.SendData(var Data; Size: Integer; Flags: Integer): Boolean;
begin
  Result := False;

  if Size < SizeOf(TMsgHeader) then
    Exit; // truncated packet

  if not FActive then
    Exit; // not connected

  SetPacketHash(@Data, Size);
  Result := js_net_send(@Data, Size) = 0;
  if Result then
  begin
    Inc(PacketsSent);
    Inc(BytesSent, Size);
  end;
end;

{ TPlayer }

function TPlayer.Clone: TPlayer;
begin
  Result := TPlayer.Create;

  Result.Name := Self.Name;
  Result.ShirtColor := Self.ShirtColor;
  Result.PantsColor := Self.PantsColor;
  Result.SkinColor := Self.SkinColor;
  Result.HairColor := Self.HairColor;
  Result.JetColor := Self.JetColor;
  Result.Kills := Self.Kills;
  Result.Deaths := Self.Deaths;
  Result.Flags := Self.Flags;
  Result.PingTicks := Self.PingTicks;
  Result.PingTicksB := Self.PingTicksB;
  Result.PingTime := Self.PingTime;
  Result.RealPing := Self.RealPing;
  Result.ConnectionQuality := Self.ConnectionQuality;
  Result.Ping := Self.Ping;
  Result.Team := Self.Team;
  Result.ControlMethod := Self.ControlMethod;
  Result.Chain := Self.Chain;
  Result.HeadCap := Self.HeadCap;
  Result.HairStyle := Self.HairStyle;
  Result.SecWep := Self.SecWep;
  Result.Camera := Self.Camera;
  Result.Muted := Self.Muted;
  Result.SpriteNum := Self.SpriteNum;
  Result.DemoPlayer := Self.DemoPlayer;
end;

// Players in team games wear their team's shirt (the colours the 1.7.1 server uses
// outside clan matches). The team decides, not the colour in the server's messages:
// when a server script moves a joining player to another team ("team is full"),
// NewPlayer still carries the shirt of the team the player asked for.
procedure TPlayer.ApplyShirtColorFromTeam;
begin
  if IsTeamGame() then
    case Self.Team of
      TEAM_ALPHA: Self.ShirtColor := $FFD20F05;
      TEAM_BRAVO: Self.ShirtColor := $FF050FD2;
      TEAM_CHARLIE: Self.ShirtColor := $FFD2D205;
      TEAM_DELTA: Self.ShirtColor := $FF05D205;
    end;
end;

end.
