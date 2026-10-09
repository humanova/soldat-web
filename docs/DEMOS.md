# Soldat demos (.sdm) of older versions

Soldat TV plays demos recorded with Soldat 1.6.8, 1.7.0 and 1.7.1. Demos of 1.6.8 and 1.7.0
are converted to 1.7.1's layout on the page (`web/js/spectate/legacy.js`) when they are
opened. The converted demo can be downloaded from the replay bar, and `tools/migrate-demo.mjs`
converts many files at once:

```bash
node tools/migrate-demo.mjs --check demos/*.sdm     # which version recorded each
node tools/migrate-demo.mjs --out converted demos/*.sdm
```

The formats below were reverse engineered from the dedicated servers of each version. A demo
holds the server's messages as the client received them, so the server's message layouts are
the demo's.

## The file [all versions]

```
0    Header: array[1..6] of Char = 'SOLDEM'
6    Version: Word                  0 in 1.7.1 (DEMO_VERSION)
8    MapName: array[0..160] of Char
172  StartDate: Integer             Unix time
176  TicksNum: Integer
180  records: Size: Word, then Size bytes
```

Size 1 is the next tick (60 a second). Size 0 is followed by two bytes, which the game skips.
Any other record is a server message: `ID: Byte; Hash: Word; ...`, the same 3-byte header and
check value as on the wire ([protocol notes](PROTOCOL-1.7.1.md)). The client adds two kinds of
records itself:

- ClientSpriteSnapshot_Dead (43, 4 bytes): the player the camera follows (`3 CameraFocus`).
- Delta_Movement (21, 27 bytes): its own player, every few ticks.

In the 1.8 source a demo starts with what a joining player gets: PlayersList, the recorder's
own NewPlayer (the "Demo Recorder" spectator), ServerVars and the items. The replay needs that
PlayersList to start.

## What changed between versions

These are identical in 1.6.8, 1.7.0 and 1.7.1: the 3-byte header and its check value (djb2:
5381, ×33, over byte 0 and bytes 3 on), the session cipher and its key (`#$A7 +
IntToStr(SessionID + $25B3B1)`, Blowfish/RIPEMD-160), and every message not listed below. Their
sizes match, and so does every offset the server writes. This includes chat (6, 66),
SpecialMessage (64) and the heartbeats, apart from their map id.

The 1.6.9 betas added a byte to PlayersList for their Survival_Clear_Weapons setting. 1.7.0
went back to 1.6.8's network code (changelog: "reverted to 1.6.8 netcode") but kept that byte. 1.7.1 stores health and vest as Singles instead of integers. It also
sends each weapon's hitbox modifiers, and NewPlayer says how the player joined.

| ID | Message | 1.6.8 | 1.7.0 | 1.7.1 |
|----|---------|-------|-------|-------|
| 3  | ServerSpriteSnapshot | 36 | 36 | 41 |
| 13 | SpriteDeath | 278 | 278 | 280 |
| 16 | PlayersList | 2149 | 2150 | 2150 |
| 17 | NewPlayer | 60 | 60 | 61 |
| 41 | ServerSpriteSnapshot_Major | 30 | 30 | 32 |
| 52 | ServerVars | 746 | 746 | 986 |

### ServerSpriteSnapshot (3)
```
1.6.8, 1.7.0 (36)                        1.7.1 (41)
0..24  as 1.7.1 (Num, Pos, Vel,          0..24
       AimAngle, Position, Keys16, Look)
25  Vest: Byte (0..100)                  25 Vest: Single
26  Health: SmallInt                     29 Health: Single
28  AmmoCount                            33
29  GrenadeCount                         34
30  WeaponNum                            35
31  SecondaryWeaponNum                   36
32  ServerTicks: LongInt                 37
```
The server keeps health as a 32-bit Integer (−400 for a body that is gone) and sends its low
16 bits.

### ServerSpriteSnapshot_Major (41)
```
1.6.8, 1.7.0 (30)                 1.7.1 (32)
3 Num, 4 Pos, 12 Vel              same
20 Health: SmallInt               20 Health: Single
22 AimAngle                       24
23 Position                       25
24 Keys16: Word                   26
26 ServerTicks: LongInt           28
```

### SpriteDeath (13)
```
1.6.8, 1.7.0 (278)                1.7.1 (280)
3..263 as 1.7.1 (Num, Killer,     same
  KillBullet, Where, Constraints,
  Pos[1..16], OldPos[1..16])
264 Health: SmallInt              264 Health: Single
266 OnFire                        268
267 RespawnCounter: SmallInt      269
269 ShotDistance: Single          271
273 ShotLife: Single              275
277 ShotRicochet                  279
```

### NewPlayer (17)
1.7.1 put `6 JoinType: Byte` (0 normal, 1 silent) before the name. Everything after it
moves by one: 1.6.8/1.7.0 `6 Name[24]; 30 Shirt; 34 Pants; 38 Skin; 42 Hair; 46 Jet; 50 Team;
51 Look; 52 Pos`.

### ServerVars (52)
1.7.1 put `ModifierHead, ModifierChest, ModifierLegs: array[1..20] of Single` at 732, before
`WeaponActive[1..14]`, which moves from 732 to 972. Up to 1.7.0 the game had the modifiers
built in: head 1.15, chest 1, legs 0.9. Both servers hold 1.15 as an 80-bit constant and 0.9
as a Single.

### PlayersList (16)
1.6.8's ends at 2148: it has no `2149 SurvivalClearWeapons`. Its three encrypted fields (MapID,
GameStyle, Gravity) and their key are as in 1.7.1.

### Heartbeat map id (2, 35, 36)
`3 MapID` is 1.7.1's CRC of the map file. 1.6.8 and 1.7.0 compute it otherwise: neither has the
CRC seeded with 5381 nor the constant `$25B400`. The 1.7.1 client takes a map id it does not
know for another version of the map and asks for it again. On the page, such a replay showed
neither the score nor the players. Conversion therefore sets the map id to 0, which the client
does not check.

## What conversion does

For a demo of 1.6.8 or 1.7.0:

- Each message above gets 1.7.1's layout. Health and vest become Singles, JoinType is normal,
  the modifiers get the built-in values, SurvivalClearWeapons is 0, and the heartbeat map ids
  are 0.
- Every message gets a fresh check value. The old game played demos without checking them; the
  1.7.1 client drops a message whose value is wrong.
- The header's version becomes 0.

For a demo of any version:

- A record holding several messages is split into one record a message, by the sizes of its
  version. The replay reads one message a record. A compressed record (a datagram starting
  with `$FF`) is inflated first.
- The PlayersList's game mode and gravity must decrypt to plausible values (game mode 0..6,
  gravity 0..10). If they are plausible only in clear, as a client may have written them, they
  are encrypted with the list's session id.

The version is told by the sizes of the six messages that changed. A record of several
messages of one kind is a multiple of its size. PlayersList's size then separates 1.6.8 from
1.7.0. A demo whose messages fit no known layout is refused, not converted.

## Not verified

- No old client was available to check against. soldat.pl, its downloads and archive.org were
  out of reach. The header version older clients wrote is not known; the converter ignores it.
  The demo's records are assumed to be the messages as received, as in the 1.8 source
  (`Net.pas` HandleMessages: `DemoRecorder.SaveRecord`), whose demo code is 2002's
  (`Demo.pas`).
- Versions before 1.6.8 and the 1.6.9 betas were not available. The changelog says 1.7.0
  "reverted to 1.6.8 netcode", so 1.6.9 may differ. Demos whose messages do not fit are
  refused.
- The tests (`npm test`) use made-up matches in each layout. Converted 1.6.8 and 1.7.0 matches
  were played on the Soldat TV page (headless Chromium, the wasm client): the map, the
  players, the score and a kill showed.

## Sources

| Version | Server | From | SHA-1 of `soldatserver` |
|---------|--------|------|-------------------------|
| 1.6.8 | 2.7.8 | `soldatserver2.7.8_1.6.8.zip` in the Docker Hub image `hhanh/soldat` (2015) | `266fb87fa38c2c083a2fde3877e5ed80bb254d8b` |
| 1.7.0 | 2.8.0 | GitHub `albertobaraza/soldat`, commit `fde6047` | `13a553768f04df72ef3dcf326814e45e8abb1891` |
| 1.7.1 | 2.8.1 | `soldatserver2.8.1_1.7.1.zip` in the Docker Hub image `ualjjcanada/soldatserver` | `a0058978b9e439c55b7aa43ec8aa1f89f64ec219` |

They are stripped 32-bit Free Pascal binaries. `tools/protocol/layouts.py` lists the messages a
server builds, their sizes and the offsets it writes, and compares two servers:

```bash
pip install capstone pyelftools
python3 tools/protocol/layouts.py sizes 2.7.8/soldatserver
python3 tools/protocol/layouts.py diff 2.8.0/soldatserver 2.8.1/soldatserver
python3 tools/protocol/layouts.py fields 2.8.0/soldatserver 8152240 17 60
```

Where to look in each (check value function; then the builders of 3, 13, 16, 17, 41, 52):

| | check value | 3 | 13 | 16 | 17 | 41 | 52 |
|-|-|-|-|-|-|-|-|
| 2.7.8 | `814acf0` | `814afb0` | `8230270` | `815c760` | `814c910` | `814b4a0` | `814eb10` |
| 2.8.0 | `8150620` | `81508e0` | `82393e0` | `8162180` | `8152240` | `8150dd0` | `81544c0` |
| 2.8.1 | `805fea0` | `8060570` | `8061ec0` | `8062900` | `80634b0` | `8060af0` | `8065950` |

The session key is built after `SessionID := Random(5000) + 1001`
(2.7.8 `80d3881`, 2.8.0 `80d901f`, 2.8.1 `809ac4e`).
