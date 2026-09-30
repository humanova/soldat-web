# Soldat 1.7.1 network protocol (reverse engineered from soldatserver 2.8.2)

Status legend: [V] verified live against real 1.7.1 server, [D] decoded from disassembly.

## Transport [V]
* Plain UDP, default game port 23073. File server (map download) on TCP port+10.
* Every message: `ID: Byte; Hash: Word (LE); payload...` (packed, 3-byte header).
* Hash = djb2 variant, 16-bit wrap: `h := Data[0] + $B5A5; for i := 3 to Size-1 do h := h*33 + Data[i]`.
  (Header bytes 1..2 excluded.) Server drops messages with bad hash, except IDs 100 and 105.
* A datagram whose first byte is `$FF` is zlib-compressed: `zlib.decompress(dgram[1:])`.
* A datagram (compressed or not) may contain several *fixed-size* messages concatenated
  (e.g. N x ThingMustSnapshot, N x ServerSpriteSnapshot). Each keeps its own ID+hash.
* Server accepts client messages only with ID > 3.

## Session cipher [V]
* DCPcrypt `TDCP_blowfish`, `CipherMode = cmCBC`, `InitStr(Key, TDCP_ripemd160)`:
  Blowfish key = RIPEMD160(Key) (20 bytes), IV = BlowfishECB(0x00 * 8), CV := IV on Reset.
* DCPcrypt CBC partial block (Size mod 8 <> 0): `CV := E(CV); data[tail] := data[tail] xor CV`.
* Key = `#$A7 + IntToStr(SessionID + $25B3B1) (= +2470833)`; SessionID (Word) = Random(5000)+1001, regenerated
  every map change, sent in clear in PlayersList.SessionID.
* Every message handler does `Reset` before and after processing; fields are
  encrypted/decrypted one by one in a fixed order with their own sizes (order matters!).

## Client -> Server
| ID | Name | Size | Notes |
|----|------|------|-------|
| 4  | ClientSpriteSnapshot | ? | encrypted: 5 x 1 byte |
| 5  | ClientBulletSnapshot | ? | encrypted: 1,4,4,2 |
| 6  | ChatMessage | var | encrypted: byte at 3 |
| 14 | RequestGame | 46+len(pw) | [V] see below, NOT encrypted |
| 15 | PlayerInfo | 65 | [V] see below |
| 19 | PlayerDisconnect | ? | encrypted: byte at 3? |
| 31 | Pong | ? | |
| 34 | ? | ? | encrypted: 1 byte |
| 40 | ? | ? | encrypted 1,4,1 |
| 42 | ClientSpriteSnapshot_Mov | ? | encrypted 4,4,2,2,2 |
| 43 | ClientSpriteSnapshot_Dead | ? | encrypted 1 |
| 46 | VoteMap? | ? | |
| 47 | ? | ? | reply encrypted 1,1 |
| 48 | VoteKick? | ? | |
| 49 | VoteMapRequest? | ? | reply 22 bytes, encrypted 2,17 |
| 51 | RequestThing | ? | encrypted 1 |
| 53 | ? | ? | encrypted 1 |
| 55 | ClientFreeCam | ? | |
| 63 | ChangeTeam | ? | |
| 66 | ? (admin login?) | ? | encrypted 1 |
| 91 | ? | ? | |
| 105| Lobby ping | ? | no hash check |

### RequestGame (14) [V]
```
0  ID=14
1  Hash
3  Forwarded: Byte
4  Version: array[0..4] of Char = '1.7.1'
9  Name: array[0..23] of Char
33 HardwareID: string[11] (len byte + 11 chars)
45 Password: null-terminated (so size = 46 + Length(pw))
```
HWID validity: 11 chars; first 10 hex [0-9A-F]; h := 5381; for c in first 10: h := h*33 + HexVal(c) (32-bit);
last char = HexDigit(h and $F). Invalid -> UnAccepted state 7.
Replies: PlayersList (16) or UnAccepted (44). States: 1 OK, 2 WRONG_VERSION, 3 WRONG_PASSWORD,
4 BANNED (text=reason), 5 SERVER_FULL, 7 invalid HWID.

### PlayerInfo (15) [V] 65 bytes
```
0  ID=15, 1 Hash
3  Name: array[0..23] of Char
27 MapID: LongWord (= $25B400)          enc#8 (4)
31 Look: Byte                           enc#7 (1)
32 Team: Byte (0..5)                    enc#6 (1)
33 ShirtColor: LongWord                 enc#1 (4)
37 PantsColor: LongWord                 enc#2 (4)
41 SkinColor: LongWord                  enc#3 (4)
45 HairColor: LongWord                  enc#4 (4)
49 JetColor: LongWord                   enc#5 (4)
53 HardwareID: string[11]               enc#9 (12)
```
Encryption order: Reset; Shirt,Pants,Skin,Hair,Jet(4 each), Team(1), Look(1), MapID(4), HWID(12); Reset.
Hash computed over encrypted bytes.
Look bits: 1..8 hairstyle 1..4, $10 helmet, $20 hat, $40 chain1, $80 chain2.

## Server -> Client
| ID | Name | Size |
|----|------|------|
| 2  | HeartBeat (<=32 players) | 303 |
| 3  | ServerSpriteSnapshot | 41 (batched) |
| 5  | BulletSnapshot | 24 |
| 6  | ChatMessage | var |
| 7  | ServerSkeletonSnapshot | 6 (batched) |
| 8  | MapChange | 22 |
| 9  | ServerThingSnapshot | 71 (batched) |
| 12 | ThingTaken | 7 |
| 13 | SpriteDeath | 280 |
| 16 | PlayersList | 2150 |
| 17 | NewPlayer | 61 |
| 18 | ServerDisconnect | 3 |
| 19 | PlayerDisconnect | 5 |
| 21 | Delta_Movement | 27 |
| 25 | Delta_Weapons | 7 |
| 30 | Ping | 5 |
| 32 | FlagInfo | 5 |
| 33 | ServerThingMustSnapshot | 73 (batched) |
| 35 | HeartBeat (<=16 players) | 159 |
| 36 | HeartBeat (<=8 players) | 87 |
| 37 | IdleAnimation | 6 |
| 40 | ? | 3 |
| 41 | ServerSpriteSnapshot_Major | 32 (batched) |
| 44 | UnAccepted | 10+len |
| 45 | VoteOn | 49 |
| 52 | ServerVars | 986 |
| 54 | ServerSyncMsg | 8 |
| 56 | VoteOff | 3 |
| 60 | ForcePosition | 12 |
| 61 | ForceVelocity | 12 |
| 62 | ForceWeapon | 7 |
| 64 | SpecialMessage | var |
| 65 | WeaponActiveMessage | 5 |
| 69 | Gravity | 7 |
| 70 | PlaySound | 38 |
| 127| ? | 3 |

### UnAccepted (44) [V]
`3 State: Byte; 4 Text: PChar (null-term); 5..9 Version: array[0..4] (valid only when Text empty)`.
Size = 10 + Length(Text).

### PlayersList (16) [V] 2150 bytes
```
0    ID=16, 1 Hash
3    MapName: array[0..15] of Char
19   GameStyle: Byte                         ENC (order 2, size 1)
20   Players: Byte
21   KillLimit: Word
23   Flags: Byte  b0 Survival, b1 Realistic, b2 Connection=Internet(2), b3 BalanceTeams,
                  b4 BulletTime, b5 NoSniperLine, b6 WeaponsMode(Advance), b7 AntiSpyChat
24   ServerName: array[0..23] of Char
48   ServerInfo: array[0..59] of Char
108  Name: array[1..32] of array[0..23] of Char
876  ShirtColor[1..32], 1004 PantsColor[..], 1132 SkinColor[..], 1260 HairColor[..], 1388 JetColor[..] (LongWord)
1516 Team: array[1..32] of Byte
1548 PredDuration: array[1..32] of Byte
1580 MapID: LongWord ($25B400)               ENC (order 1, size 4)
1584 Gravity: Single                         ENC (order 3, size 4)
1588 Look: array[1..32] of Byte
1620 Pos: array[1..32] of TVector2
1876 Vel: array[1..32] of TVector2
2132 ?: Word (DAT_081b7a40, 0 seen)
2134 SessionID: Word (cipher key seed)
2136 TimeLimit: LongInt (ticks)
2140 TimeLeft: LongInt (ticks)
2144 MaxGrenades: Byte
2145 ServerTicks: LongInt
2149 SurvivalClearWeapons: Byte
```
Empty slot name = '0 ' (as 1.8).

### ServerSpriteSnapshot (3) [D] 41 bytes
`3 Num; 4 Pos: TVector2; 12 Vel: TVector2; 20 AimAngle: Byte; 21 Position: Byte; 22 Keys16: Word;
24 Look: Byte (b0 no helmet, b1 cigar=5, b2 cigar=10, b3 helmet=2); 25 Vest: Single; 29 Health: Single;
33 AmmoCount; 34 GrenadeCount; 35 WeaponNum; 36 SecondaryWeaponNum; 37 ServerTicks: LongInt`
AimAngle = Round(127.5/Pi * Angle2Points(MouseAim, SpritePos)) (byte wrap).

### ServerSpriteSnapshot_Major (41) [D] 32 bytes
`3 Num; 4 Pos; 12 Vel; 20 Health: Single; 24 AimAngle: Byte; 25 Position; 26 Keys16: Word; 28 ServerTicks`

### ServerSkeletonSnapshot (7) [D] 6 bytes: `3 Num; 4 RespawnCounter: SmallInt`

### ServerThingSnapshot (9) [D] 71 bytes
`3 Num; 4 Owner; 5 Style; 6 HoldingSprite; 7 Pos[1..4]: TVector2; 39 OldPos[1..4]`
### ServerThingMustSnapshot (33) [D] 73 bytes: as (9) + `71 Timeout: SmallInt`
### ThingTaken (12) [D] 7 bytes: `3 Num; 4 Who; 5 Style; 6 AmmoCount`
### BulletSnapshot S->C (5) [D] 24 bytes: `3 Owner; 4 WeaponNum; 5 Pos; 13 Vel; 21 Seed: Word; 23 Forced: Byte`
### SpriteDeath (13) [D] 280 bytes
`3 Num; 4 Killer; 5 KillBullet; 6 Where; 7 Constraints; 8 Pos[1..16]; 136 OldPos[1..16];
264 Health: Single; 268 OnFire; 269 RespawnCounter: SmallInt; 271 ShotDistance: Single; 275 ShotLife: Single; 279 ShotRicochet`

### HeartBeat (2 / 35 / 36) [D] N = 32 / 16 / 8 compacted player entries
`3 MapID: LongWord (0 near round start/end); 7 Active[N]; Kills[N]: Word; Caps[N]; Team[N];
Deaths[N]: Word; TeamScore[1..4]: Word; Ping[N]; Flags[N]`  size = 15 + 9N.

### Gravity (69) [D] 7 bytes: `3 Grav: Single`

## Client -> Server (decoded) [D unless marked]
All client messages: sender sprite is identified by IP:port; `Num` fields are advisory.
Encrypted fields are listed in order (cipher Reset before and after each message).

| ID | Name | Size | Layout | Encrypted (order) |
|----|------|------|--------|-------------------|
| 4  | ClientSpriteSnapshot | 8 | 3 AmmoCount, 4 SecAmmoCount, 5 WeaponNum, 6 SecWeaponNum, 7 Position | 3,4,5,6,7 (1 byte each) |
| 5  | ClientBulletSnapshot | 26 | 3 WeaponNum, 4 Pos, 12 Vel, 20 Seed:Word, 22 ClientTicks:LongInt | 3(1), 4(4)=Pos.X, 12(4)=Vel.X, 20(2) |
| 6  | ChatMessage (ANSI) | 5+len | 3 Num, 4 Text PChar | 3(1) |
| 14 | RequestGame | 46+len | see above | none [V] |
| 15 | PlayerInfo | 65 | see above | see above [V] |
| 19 | PlayerDisconnect | 5 | 3 Num, 4 Why | 3(1) |
| 31 | Pong | 4 | 3 PingNum | none |
| 34 | RequestPlayer | 4 | 3 SpriteNum -> server answers NewPlayer(17) | 3(1) |
| 40 | StatusReply | 9 | 3 RealisticMode:Byte, 4 JetCount:LongInt (<= Map.StartJet), 8 ?:Byte | 3(1),4(4),8(1) |
| 42 | ClientSpriteSnapshot_Mov | 25 | 3 Pos, 11 Vel, 19 Keys16:Word, 21 MouseAimX:SmallInt, 23 MouseAimY:SmallInt | 3(4),11(4),19(2),21(2),23(2) |
| 43 | ClientSpriteSnapshot_Dead | 4 | 3 CameraFocus | 3(1) |
| 46 | VoteMap | 45 | 3 MapName[16], 19 Reason[26]? | none |
| 47 | VoteKick | 31 | 3 Ban, 4 Num, 5 Reason[26] | 3(1),4(1) |
| 48 | (no-op) | | | |
| 49 | RequestMap | 3 | -> server answers MapChange(8) Counter=5, Counter+MapName ENCRYPTED (2),(17) | |
| 51 | RequestThing | 4 | 3 ThingID | 3(1) |
| 53 | RequestServerVars | 4 | 3 Num -> ServerVars(52) | 3(1) |
| 55 | ClientFreeCam | 12 | 3 FreeCamOn, 4 TargetPos | none |
| 63 | ChangeTeam | 4 | 3 Team | 3(1) |
| 66 | ChatMessage (Unicode) | 5+2len | 3 Num, 4 Text PWideChar | 3(1) |
| 91 | AntiCheatReport | 154 | (official client anti-cheat; not sent) | |
| 105| LobbyPing | | lobby server only | |

Chat text: first char is a prompt char (ignored, ' '), '/' at [0] = command; [1]='^' team; [1]='*' radio
followed by 2 digit radio code. Server relays the original text (ID 6 or 66) with Num = sender;
server messages: Num=255, text usually '/say ...'.

Server "StatusRequest" (ID 40, 3 bytes) is sent at 3000-tick countdown points (2000,800,400,60);
if no StatusReply (C->S 40) the player is kicked ("could not respond (maybe cheating)").
Reply resets countdown to 12000. Another timeout: no client packets for 1800 ticks -> kick.

## More Server -> Client [D]
### NewPlayer (17) 61 bytes
`3 Num; 4 ?:Word; 6 JoinType; 7 Name[24]; 31 Shirt; 35 Pants; 39 Skin; 43 Hair; 47 Jet (LongWord);
51 Team; 52 Look; 53 Pos: TVector2`
### ServerDisconnect (18) 3 bytes. PlayerDisconnect (19) 5: `3 Num; 4 Why`
### Delta_Movement (21) 27: `3 Num; 4 Pos; 12 Vel; 20 Keys16; 22 AimAngle; 23 ServerTick`
### Delta_Weapons (25) 7: `3 Num; 4 WeaponNum; 5 SecWeaponNum; 6 AmmoCount`
### Delta_Helmet (26) 5: `3 Num; 4 WearHelmet`
### Delta_MouseAim (29) 6: `3 Num; 4 AimAngle; 5 AimDistance div 100`
### Ping (30) 5: `3 PingTicks; 4 PingNum` -> reply Pong(31)
### FlagInfo (32) 5: `3 Style; 4 Who`
### IdleAnimation (37) 6: `3 Num; 4 IdleRandom: SmallInt`
### StatusRequest (40) 3: header only
### VoteOn (45) 49: `3 VoteType; 4 Timer: Word; 6 Who; 7 TargetName[16]; 23 Reason[26]`
### ServerVars (52) 986
`3 FriendlyFire; 4 AdvanceAmount; 5 TimeLimit: LongInt; 9 DisableMinimap; 10 AdvancedSpectate; 11 Radio;
12 Damage[1..20]: Single; 92 Ammo[20]: Byte; 112 ReloadTime[20]: Word; 152 Speed[20]: Single;
232 BulletStyle[20]; 252 StartUpTime[20]: Word; 292 Bink[20]: SmallInt; 332 FireInterval[20]: Word;
372 MovementAcc[20]: Single; 452 BulletSpread[20]: Single; 532 Recoil[20]: Word; 572 Push[20]: Single;
652 InheritedVelocity[20]: Single; 732 ModifierHead[20]; 812 ModifierChest[20]; 892 ModifierLegs[20] (Single);
972 WeaponActive[1..14]: Byte`
### ServerSyncMsg (54) 8: `3 TimeLeft: LongInt; 7 Paused: Byte`
### VoteOff (56) 3. ForcePosition (60) / ForceVelocity (61) 12: `3 Vec: TVector2; 11 PlayerID`
### ForceWeapon (62) 7: `3 WeaponNum; 4 SecWeaponNum; 5 AmmoCount; 6 SecAmmoCount`
### SpecialMessage (64) var: `3 MsgType; 4 LayerId; 5 Delay: LongInt; 9 Scale: Single; 13 Color; 17 X: Single; 21 Y: Single; 25 Text PChar`
### WeaponActiveMessage (65) 5: `3 Active; 4 Weapon`
### ChatMessage (6 ANSI / 66 Unicode) var: `3 Num; 4 Text (PChar / PWideChar)`
### MapChange (8) 22: `3 Counter: SmallInt; 5 MapName: string[16]`
### PlaySound (70) 38: `3 Name[27]; 30 Emitter: TVector2`
### (127) 3 bytes, header only, unknown purpose (ignore)

## Map ID [V]
Heartbeat MapID = crc32 (MSB-first table from 1.8 MapFile.pas) with init 5381 over the whole .pms file,
identical to OpenSoldat's MapFile.Hash. Mismatch twice -> client should re-request/disconnect.

## File server (TCP, game port + 10) [V]
Request: `STARTFILES\r\n` then paths `maps/NAME.pms`, `scenery-gfx/*.{png,jpg,bmp,gif}`,
`textures/*.{png,...}` each `\r\n`, then `ENDFILES\r\n`.
Response: `STARTFILES\r\n` + TotalSize:u32 BE + for each existing file: `path\r\n` + Size:u32 BE + bytes;
then `ENDFILES\r\n`. Missing files are skipped.
