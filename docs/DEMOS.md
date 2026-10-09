# Soldat demos (.sdm) of older versions

Soldat TV plays the demos the game recorded from Soldat 1.2.0 to 1.7.1, the betas' too, and
its own. 1.2.0 (2004) is the first version that recorded demos (F8). They are converted to
1.7.1's layout on the page when they are opened (`web/js/spectate/legacy.js`,
the layouts in `legacy-formats.js`). The converted demo can be downloaded from the replay bar.
`tools/migrate-demo.mjs` converts many files at once:

```bash
node tools/migrate-demo.mjs --check demos/*.sdm     # which version recorded each
node tools/migrate-demo.mjs --out converted demos/*.sdm
```

The formats below were reverse engineered from the dedicated servers of each version, all on
[static.soldat.pl/downloads](https://static.soldat.pl/downloads/). A demo holds the server's
messages as the client got them, so the server's message layouts are the demo's. The games
came with a demo (`demos/intro.sdm`): every release's format was checked against one, and
converted ones were played on the page. The betas' were read from their servers only.

| Versions | Server | Demo checked | Format |
|----------|--------|--------------|--------|
| 1.2.0, 1.2.1 | 2.2.9 (1.2.1's) | the 1.2 intro, recorded with 1.2.0 | `1.2.1` |
| 1.3.0, 1.3.1 | 2.4.9 (1.3.1's; 2.5.x) | the 1.3 intro, recorded with 1.3.0 | `1.3.1` |
| 1.4.1 | 2.6.1 | 1.4.1's intro | `1.4.1` |
| 1.4.0, 1.4.2 | 2.6.0, 2.6.2 (2.6.3, Soldatserver+ 1.0.x) | 1.4.0's intro (1.4.2 has the same) | `1.4.2` |
| 1.5.0 | 2.6.4, 2.6.5 | 1.5.0's intro | `1.5.0` |
| 1.5.1 beta (20e, 21f) | 2.7.0 beta (151e, 151f) | | `1.5.1` |
| 1.6.0 to 1.6.3, their RCs and betas | 2.7.0 to 2.7.3 | 1.6.0's intro (to 1.6.3 the same) | `1.6.0` |
| 1.6.4 beta 2 to 4 | 2.7.4 b2 to b4 | | `1.6.4b` |
| 1.6.4 RC1 | 2.7.4 rc1 | | `1.6.4rc1` |
| 1.6.4 (RC2 on), 1.6.5, 1.6.6 beta 1 | 2.7.4, 2.7.5, 2.7.6 b1 | 1.6.4's intro, 1.6.4 RC3's | `1.6.4` |
| 1.6.6 (beta 2 on) | 2.7.6 | 1.6.6's intro | `1.6.6` |
| 1.6.7 beta 1 | 2.7.7 b1 | | `1.6.7b1` |
| 1.6.7 (beta 2 on) | 2.7.7 | (none: 1.6.7's intro is a 1.6.8 one) | `1.6.7` |
| 1.6.8 beta 1 | 2.7.8 b1 | | `1.6.8b1` |
| 1.6.8 (beta 2 on) | 2.7.8 | 1.6.7's and 1.6.8's intro | `1.6.8` |
| 1.6.9, 1.7.0, their alphas, betas and RCs | 2.7.9, 2.8.0, 2.8.0.9 | 1.6.9's intro (1.7.0 and 1.7.1 have the same) | `1.7.0` |
| 1.7.1 beta 1 | 2.8.1 b1 | | `1.7.1b1` |
| 1.7.1, 1.7.1.1 | 2.8.1, 2.8.2 | Soldat TV's demos | `1.7.1` |

1.2.0 and 1.3.0 had no dedicated server of their own (the game hosted). Their intros are the
ones 1.2.1 and 1.3.1 shipped, and fit 1.2.1's and 1.3.1's servers in all their messages.

## The file

The game's demos have no header up to 1.7.1. Their records start at once up to 1.6.3, and
after three bytes (`00 00 00`) from 1.6.4 on. The 180-byte header is Soldat TV's (and the 1.8
source's), and a converted demo gets one, with the map's name from the PlayersList and the
ticks counted. It has no date, so the page shows the file's.

```
0    Header: array[1..6] of Char = 'SOLDEM'
6    Version: Word                  0 (DEMO_VERSION)
8    MapName: array[0..160] of Char
172  StartDate: Integer             Unix time
176  TicksNum: Integer
180  records
```

A record is `Size: Word`, then Size bytes. Size 1 is the next tick (60 a second). Size 0 is
followed by two bytes, which the game skips. Any other record is a datagram as the client got
it: one message, several of the same kind (sprite snapshots come four or eight at a time), or
a compressed one (`$FF`, then zlib). The page's replay reads one message a record, so records
are split and inflated. Before 1.6.4 a two-byte record is a message too. A recording can stop
in the middle of a record (1.6.4 RC3's intro): such a last record is left out.

A demo starts with what a joining player gets: the PlayersList, the recorder's own NewPlayer
(slot 32, named `DEMO`), ServerVars and the items. The client adds records itself: its own
movement (Delta_Movement, 21) every few ticks and the player the camera follows
(ClientSpriteSnapshot_Dead, 43).

## What changed between versions

A message is `ID: Byte; Hash: Word; ...` from 1.6.4 on (the hash is djb2 from 5381, ×33, over
byte 0 and bytes 3 on). Before, it was the ID alone. For each version, legacy-formats.js lists
the fields of the messages that differ from 1.7.1's. Every other message has the same fields.
That was checked by the offsets each server writes (`tools/protocol/layouts.py`, `kylix.py`)
and by the intro demos. The sizes include the header:

| ID | Message | 1.2.1 | 1.3.1 | 1.4.1 | 1.4.2 | 1.5 | 1.6.0–3 | 1.6.4–5 | 1.6.6 | 1.6.7 | 1.6.8 | 1.6.9–1.7.0 | 1.7.1 |
|----|---------|------|------|------|------|-----|---------|---------|-------|-------|-------|-------------|-------|
| 3 | ServerSpriteSnapshot | 30 | 30 | 22 | 30 | 30 | 30 | 36 | 36 | 36 | 36 | 36 | 41 |
| 41 | ServerSpriteSnapshot_Major | 23 | 23 | 15 | 23 | 23 | 23 | 29 | 29 | 30 | 30 | 30 | 32 |
| 21 | Delta_Movement | 21 | 21 | 21 | 21 | 21 | 21 | 27 | 27 | 27 | 27 | 27 | 27 |
| 5 | BulletSnapshot | 19 | 19 | 19 | 19 | 19 | 21 | 24 | 24 | 24 | 24 | 24 | 24 |
| 13 | SpriteDeath | 266 | 275 | 275 | 275 | 276 | 276 | 278 | 278 | 278 | 278 | 278 | 280 |
| 16 | PlayersList | 1525 | 1525 | 1511 | 1511 | 1517 | 1633 | 1637 | 1637 | 2149 | 2149 | 2150 | 2150 |
| 17 | NewPlayer | 58 | 58 | 58 | 58 | 58 | 58 | 60 | 60 | 60 | 60 | 60 | 61 |
| 35 | HeartBeat (16 slots) | 93 | 93 | 93 | 93 | 109 | 109 | 159 | 159 | 159 | 159 | 159 | 159 |
| 37 | IdleAnimation | 3 | 3 | 3 | 3 | 3 | 3 | 6 | 6 | 6 | 6 | 6 | 6 |
| 52 | ServerVars | – | 507 | 542 | 542 | 604 | 604 | 686 | 746 | 746 | 746 | 746 | 986 |

- **Snapshots** (3, 41, 21) had no `ServerTicks` before 1.6.4, and 1.4.1's sprite snapshots
  no velocity. Health was an integer (SmallInt) and the vest a byte up to 1.7.0. The major
  snapshot had one byte of keys (the low byte of Keys16) up to 1.6.6.
- **Bullets** (5) carried their bullet style, not their weapon, before 1.6.4, and no seed
  before 1.6.0. `Forced` came in 1.6.4.
- **SpriteDeath** (13): `Constraints` (which body parts are gone) came in 1.5, the shot's
  distance, life and ricochet by 1.3.1.
- **PlayersList** (16): the server's name and info and `PredDuration` came in 1.6.0, the
  players' positions and velocities in 1.6.7, `SurvivalClearWeapons` in 1.6.9. 1.4.x had no
  gravity in it, and 1.5 to 1.6.3 a word after it (set as the server loads its scripts),
  encrypted with the rest. 1.2.1 and 1.3.1 listed the weapons the menu offers at its end.
- **NewPlayer** (17): `JoinType` came in 1.7.1.
- **HeartBeat** (2, 35, 36): before 1.6.4, kills, deaths, the team scores, teams and (from
  1.5) caps; no `Active`, ping or flags. The entries are those of the players there, in
  order; unused ones have team 255.
- **IdleAnimation** (37): `IdleRandom` was a byte before 1.6.4.
- **ServerVars** (52): see below. 1.2.1 sent none.
- **IDs**: 1.6.8 added ForceVelocity (61) and VoteOff (56). ForceWeapon, SpecialMessage,
  WeaponActiveMessage, Unicode chat, Gravity and PlaySound were 61, 63, 64, 65, 68 and 69
  before, one less than in 1.6.8. SpecialMessage got `LayerId` then, and ForcePosition (60)
  its player.

### Weapons

Weapons have a number (in snapshots, bullets, Delta_Weapons, ForceWeapon) and a place in
ServerVars' arrays. Both changed in 1.6.8:

- **Numbers**: before 1.6.8, the knife, chainsaw and LAW were 14, 15 and 16, and the flamer,
  bow and flamed arrows 11, 12 and 13. 1.6.8 swapped them. The guns (0 to 10), the M2 (30),
  grenades (50 on) and punching (255) kept theirs.
- **ServerVars' order**: 1.7.1's is Eagle, MP5, AK-74, Steyr, Spas, Ruger, M79, Barrett,
  Minimi, Minigun, Socom, Knife, Chainsaw, LAW, Flamed Arrows, Bow, Flamer, M2, Punch,
  Grenade. 1.6.4 to 1.6.7 had the M2 before the arrows, bow and flamer. Up to 1.6.3 the order
  was Punch, Knife, AK-74, Minimi, Ruger, MP5, Spas, M79, Grenade, Eagle, Flamer, Steyr,
  Barrett, Minigun, Socom, Chainsaw, Bow, Flamed Arrows, LAW, M2.
- **ServerVars' settings**: up to 1.6.3 there were ten, not thirteen: no BulletSpread, Push
  nor InheritedVelocity (given 1.6.4's defaults). Ammo, ReloadTime, StartUpTime and Recoil
  were LongInts, FireInterval and MovementAcc bytes. 1.4 had no AdvancedSpectate or Radio and
  Recoil as a byte. 1.3.1 had neither DisableMinimap nor Recoil, and kept the menu's weapons
  in the PlayersList. MovementAcc was weapons.ini's integer up to 1.6.5; from 1.6.6 the
  servers divide it by 200, which 1.7.1's weapons.ini does itself. The hitbox modifiers
  (1.7.1) were built in: head 1.15, chest 1, legs 0.9.

The 1.6.7 intro demo has 1.6.8's weapons, while the 1.6.7 server has the old ones: the demo
was recorded with a later build. A demo of 1.6.7 or 1.6.8 is told apart by where its
ServerVars has the flamer.

### The player list's encrypted fields

The client decrypts the PlayersList's map id, game mode and gravity with a key from its
session id (`SessionID := Random(5000) + 1001`). The servers since 1.5 hash the key with
RIPEMD-160 and use it for Blowfish in CBC mode (DCPcrypt). The key is `#$A7 +
IntToStr(SessionID + $25B3B1)` from 1.6.0 on, `+ $B37B1` in 1.5. The older servers used
SHA-1 with RC4 (1.4) or CAST-128 (1.2, 1.3), and keys `'s' + IntToStr(SessionID + X)`, X
$80600 (1.2.1), $92600 (1.3.1), $97800 (1.4.0), $A6000 (1.4.1) or $A5A00 (1.4.2)
(`kylix.py key`).

The games wrote the list to their demos decrypted from 1.4 on. The 1.2 and 1.3 intros have it
encrypted, and it did not decrypt with 1.2.1's and 1.3.1's keys: they were recorded with 1.2.0
and 1.3.0, whose keys are not known. For a list that does not decrypt, the converter guesses the game
mode from the map's name and the match (ctf_, inf_, htf_ maps; pointmatch if the yellow flag
is there; a team match if anyone has a team).

### The heartbeats' map id

The heartbeats' `MapID` is 1.7.1's CRC of the map file. Older versions compute it otherwise,
and the 1.7.1 client takes a map id it does not know for another version of the map. On the
page, such a replay showed neither the score nor the players. Conversion sets it to 0, which
the client does not check.

### The betas

The betas, release candidates and alphas send their release's sizes, but for these (the
format of each in the table above):

- **1.5.1 beta**: 1.6.0's layouts and key, but NewPlayer (17) had a byte and a short string (25
  characters) before the position: 85 bytes.
- **1.6.4 beta 2 to 4**: bullets (5) without `Forced` (23 bytes). ServerVars (52) without
  `InheritedVelocity`, and each setting for 23 weapons, 1.6.4's 20 and three of the game's own
  after them (693 bytes). Message 66 (23 bytes) is a copy of a bullet sent to some players:
  left out. Beta 2 has only a Kylix server, whose sizes are beta 3's.
- **1.6.4 RC1**: bullets without `Forced`.
- **1.6.6 beta 1**: 1.6.4's layouts (MovementAcc a byte).
- **1.6.7 beta 1**: 1.6.6's PlayersList (1637 bytes).
- **1.6.8 beta 1**: ForcePosition (60) and ForceVelocity (61) without their player (11 bytes):
  left out. No VoteOff. The weapons are already 1.6.8's.
- **1.7.1 beta 1**: 1.7.0's ServerVars, without the hitbox modifiers (746 bytes).
- **1.7.1.1** (2.8.2): 1.7.1's.

## What conversion does

- A version is chosen by how well its message sizes fit the demo's records (the framing tells
  1.2.0–1.6.3 from 1.6.4–1.7.1). A ServerVars of 746 bytes also tells the weapons' order,
  which 1.6.7 and 1.6.8 differ by. A beta that differs from its release only in messages a
  demo does not have is taken for the release, which converts it the same.
- Each message gets 1.7.1's ID, header and check value. Its fields are copied or converted,
  and those the version did not have are filled in:
  - **ServerTicks:** the demo's tick.
  - **Vest and health:** become Singles.
  - **Velocity in 1.4.1:** 0.
  - **Bullet's weapon before 1.6.4:** the shooter's weapon of that style, or the style's usual one.
  - **Weapon numbers and ServerVars' order:** 1.7.1's.
  - **The settings older ServerVars lack:** the defaults above.
  - **Heartbeats:** `Active` from the teams, and the map id 0.
- The PlayersList is encrypted with the 1.7.1 key.
- Messages 1.7.1 has no use for are left out:
  - ForcePosition before 1.6.8, and ForceVelocity in 1.6.8 beta 1.
  - SpecialMessage before 1.6.4, whose layout is not known.
  - 1.6.4–1.6.6's message 71.
  - 1.4.2's message 67.
  - 1.2's VoteOn.
  - 1.6.4 beta 2 to 4's message 66.
- More than a few messages that fit no version's sizes: the demo is refused.

A demo of 1.7.1 with Soldat TV's header stays as it is. Records of several messages are split,
compressed ones inflated, and a list in clear encrypted.

## Not verified

- **1.2.0 and 1.3.0** had no server to read: their layouts are taken to be 1.2.1's and
  1.3.1's, which their intros fit. Their session keys are not known.
- **The betas** were read from their servers alone: no demo of theirs was found. Their
  bullets' weapon is taken from the same place in a bullet as 1.6.4's.
- **1.7.1's own recordings:** none was available. 1.7.1 ships 1.6.9's intro, so its recordings
  are taken to be headerless like the 1.6.x ones. With Soldat TV's header they are read as well.
- **Maps:** a demo on a map the page does not have cannot be shown ("Server did not provide
  map"). The stock maps of every release from 1.2.0 to 1.7.0 are there (see below); custom
  ones are not. A beta is taken to have had its release's maps.
- **The tests** (`npm test`) use a made-up match in each layout, check every layout's sizes
  against the servers' and convert the intro demos (`web/intros/`).

## The intro demos

The page lists the intro demo of each version that had one of its own (`web/intros/`, listed
in `web/js/spectate/intros.js`), gzipped as the games shipped them (`app/demos/intro.sdm` in the
installers). A version that kept its predecessor's has none of its own:

| File | Came with | Map | Recorded | SHA-1 of `intro.sdm` | From |
|------|-----------|-----|----------|----------------------|------|
| `intro-1.2.0.sdm.gz` | 1.2.0, 1.2.1 | Krab | 2004-01-09 | `4f312847f262cc2b834b183edfccdb52ec62d8bb` | `soldat12.zip` |
| `intro-1.3.0.sdm.gz` | 1.3.0, 1.3.1 | htf_Mare | 2005-08-02 | `1a61c631b5159ef8715ca78097a1423f16b180cb` | `soldat13.zip` |
| `intro-1.4.0.sdm.gz` | 1.4.0, 1.4.2 | Bigfalls | 2007-04-03 | `90b440039fd9cb3bbfd383b5035df890f78794e1` | `soldat14.zip` |
| `intro-1.4.1.sdm.gz` | 1.4.1 | Bigfalls | 2007-05-24 | `22f642636e46325027609a3c4f20ecfbfe797d61` | `soldat141.zip` |
| `intro-1.5.0.sdm.gz` | 1.5.0, 1.5.1 beta, 1.6.0 RCs | Cambodia | 2009-04-06 | `45c1682fa896cb978300fe62bf46157c535e38fe` | `soldat15.zip` |
| `intro-1.6.0.sdm.gz` | 1.6.0 to 1.6.3, 1.6.4 betas | Cambodia | 2011-08-30 | `86162a1dd85020d897601d1df3b22b08aa400234` | `soldat160.zip` |
| `intro-1.6.4.sdm.gz` | 1.6.4, 1.6.5, 1.6.6 betas | Cambodia | 2013-07-21 | `b2b17413c27103669b804f19285881e191245296` | `soldat164.zip` |
| `intro-1.6.6.sdm.gz` | 1.6.6, 1.6.7 betas | htf_Boxed | 2013-10-06 | `742a44129238b0e7f67556f3d6714d66ad55d704` | `soldat166.zip` |
| `intro-1.6.7.sdm.gz` | 1.6.7, 1.6.8 | RatCave | 2014-04-16 | `a3ddfe1e45a2b37449beeaeefc03b1e4425aa240` | `soldat167.zip` |
| `intro-1.6.9.sdm.gz` | 1.6.9 to 1.7.1.1 | Cambodia | 2015-05-29 | `4a3e0ebfba1ab8671ac4dbaa4922ee982f6e226d` | `soldat169.zip` |

The dates on the page are the versions' release dates (the wiki's
[change logs](https://wiki.soldat.pl/index.php/Change_Logs)); "Recorded" is the file's date.
Not on the page: 1.6.4 RC3's intro on Flashback (`895ee534…`, only in that RC, cut short at
its end).

## The maps of their time

Many stock maps were reshaped between versions: 1.6.0 redid Cambodia, 1.7.0 remade ctf_Ash and
moved ctf_Maya 65 px up, and so on. A demo played on 1.7.1's map then shows its players inside
the ground or in the air (22% of the 1.5.0 intro's positions are in 1.7.1's Cambodia).

`tools/old-maps.py` reads the stock maps of every release from 1.2.0 to 1.7.0 (their
installers), groups each map's versions by the ground a player collides with (versions that
differ by less than 0.5% of its area are one), and keeps those that differ from 1.7.1's by more
than 1%: 102 files of 58 maps, in the asset mirror as `maps/<map>~<tag>.pms`. The tag is the
first version with it, without "1." and dots (`Cambodia~20`: 1.2.0 to 1.5.0; `~60`: 1.6.0 to
1.6.2). A map 1.7.1 lacks (htf_Mare, ctf_Death2, Storm...) keeps its name for its newest
version. The textures and scenery they draw that 1.7.1 has not come along (32 files, as the
games had them). `web/assets/old-maps.json` lists them all, and `tools/build-assets.py` keeps
them; `web/js/spectate/old-maps-data.js` is the list the page picks from.

When the page plays a converted demo, it scores 1.7.1's map and each older version of it by
the share of the players' positions (sprite snapshots, movement) that are inside the ground,
and plays on the lowest; on a tie, on the one the demo's version shipped
(`web/js/spectate/old-maps.js`). It plays a copy with the map renamed; the converted file
keeps the map's own name, for the game. htf_Mare's scenery `moon.bmp` is in no version: it is
not drawn, as in the game.

## Sources

The servers (`soldatserver<server>_<game>.zip`, older `soldatserver<server>.zip`) and the
games (`soldat<game>.zip`, Inno Setup installers: `innoextract`) are on
[static.soldat.pl/downloads](https://static.soldat.pl/downloads/). The servers are 32-bit
Linux binaries:

- 2.7.4 on: Free Pascal, read by `tools/protocol/layouts.py`.
- 2.7.3 and older: Kylix, read by `tools/protocol/kylix.py`.
- 2.6.1 to 2.7.2: also packed with UPX (`upx -d`).

| Server | Game | SHA-1 of `soldatserver` (as in the zip) |
|--------|------|------------------------------------------|
| 2.2.9 | 1.2.1 | `329bbcad1ca2867208c31819eba8770b35a83bf9` |
| 2.4.9 | 1.3.1 | `a9206c7f0dccd94f212703b81091dbe1c6f5dcc5` |
| 2.6.0 | 1.4.0 | `a0d277e1e5f97470aaf5a64b9daf35f9426c05c2` |
| 2.6.1 | 1.4.1 | `48a5ec7279c5941b9fef3ce970f3dac191d7d2b5` (UPX) |
| 2.6.2 | 1.4.2 | `43e12508f2926f7b9b34db1bb19e15dfa03e652f` (UPX) |
| 2.6.5 | 1.5.0 | `bd740d5a758751eda006f492e14996164ce6d0a7` (UPX) |
| 2.7.0 | 1.6.0 | `6f2765bebe149da00fe6bb3fd91bca8bf8f0f28a` (UPX) |
| 2.7.3 | 1.6.3 | `f13b5c6ce666e829fb9c0f93dca196f3f55c0d0c` |
| 2.7.4 | 1.6.4 | `f11bac3fba13927a4099660541287366eb829792` |
| 2.7.5 | 1.6.5 | `48bad13d4cb08865e05367d2cd9cc83fb0893cb4` |
| 2.7.6 | 1.6.6 | `1aa2778fbf0c7823b5e1aa3caef990cf1c7fbcc3` |
| 2.7.7 | 1.6.7 | `0e64a68c8061e6751561288daa17907f2e2ecfc4` |
| 2.7.8 | 1.6.8 | `266fb87fa38c2c083a2fde3877e5ed80bb254d8b` |
| 2.7.9 | 1.6.9 | `38483f31fee55610fa22e7ed50677e83c71792b7` |
| 2.8.0 | 1.7.0 | `13a553768f04df72ef3dcf326814e45e8abb1891` |
| 2.8.1 | 1.7.1 | `a0058978b9e439c55b7aa43ec8aa1f89f64ec219` |

The betas whose layouts differ (the others were compared by their sizes alone):

| Server | Game | SHA-1 of the binary |
|--------|------|---------------------|
| 2.7.0 beta 151e, 151f | 1.5.1 beta | `c1fd86889e3f31a82e8b41c45846a82ed0c48227`, `7259352ff18877321a33729dc188d709243ffddc` (UPX) |
| 2.7.4 b2 (`soldatserver_delphi`) | 1.6.4 beta 2 | `152848f4b563d5cb17963cafe90c43fd1938f1fd` |
| 2.7.4 b3, b4 (`soldatserver_lazarus`) | 1.6.4 beta 3, 4 | `fb4e611773b25a5485b08fc7f3935f0942969cdc`, `87b40b816bfd930c485f5d2257b299cf2f6b34a9` |
| 2.7.4 rc1 (`soldatserver_lazarus`) | 1.6.4 RC1 | `9ecbd2a1738d640af3c10f9bcf616fa7dac751c0` |
| 2.7.6 b1 | 1.6.6 beta 1 | `171e72c6646468446d041d081d3352b4f16ccdc9` |
| 2.7.7 b1 | 1.6.7 beta 1 | `3f161610c0e3ff6cfe87cda4317c74247062dd58` |
| 2.7.8 b1 | 1.6.8 beta 1 | `b9b9d56a3b083787f6eca74721f993baa25d6540` |
| 2.8.1 b1 | 1.7.1 beta 1 | `3fd538c180708c3953b8111d7f85c7cf3990555e` |
| 2.8.2 | 1.7.1.1 | `c598a51c0f378d2fa4573299dee8b6d625bf7ace` |

```bash
pip install capstone pyelftools
python3 tools/protocol/layouts.py sizes 2.7.8/soldatserver
python3 tools/protocol/layouts.py diff 2.8.0/soldatserver 2.8.1/soldatserver
python3 tools/protocol/layouts.py fields 2.8.0/soldatserver 8152240 17 60
upx -d -o 2.7.0/soldatserver.unpacked 2.7.0/soldatserver
python3 tools/protocol/kylix.py sizes 2.7.3/soldatserver
python3 tools/protocol/kylix.py fields 2.7.3/soldatserver 8112a6c 21 21
python3 tools/protocol/kylix.py key 2.4.9/soldatserver
```

Where to look in the servers of 1.6.8 to 1.7.1 (check value function; then the builders of 3,
13, 16, 17, 41, 52):

| | check value | 3 | 13 | 16 | 17 | 41 | 52 |
|-|-|-|-|-|-|-|-|
| 2.7.8 | `814acf0` | `814afb0` | `8230270` | `815c760` | `814c910` | `814b4a0` | `814eb10` |
| 2.8.0 | `8150620` | `81508e0` | `82393e0` | `8162180` | `8152240` | `8150dd0` | `81544c0` |
| 2.8.1 | `805fea0` | `8060570` | `8061ec0` | `8062900` | `80634b0` | `8060af0` | `8065950` |

How the weapons were placed and numbered was read from the servers' weapon tables, and from
ServerVars' arrays in each intro demo (each weapon's ammo, reload time, speed and style match
one weapons.ini section). The bullets' weapon numbers were checked by their speed and count
(the chainsaw fires a bullet each tick).
