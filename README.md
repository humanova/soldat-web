# Soldat Web

**Play Soldat 1.7.1 in your browser at [play.soldat.live](https://play.soldat.live)**, on the
official public servers, next to players on the original game. Nothing to install.
Or watch live matches at **[soldat.live](https://soldat.live)**, and see the
[demo video](https://youtu.be/rnsfcZrFU7s).

![Soldat TV: a live CTF round on AUS7RAL EuroShots #2, ctf_MFM](docs/screenshots/soldat-tv.jpg)

## How it was done

The original Pascal client, compiled to WebAssembly. It started from the
[open source codebase](https://github.com/soldat/soldat). Its network code was rewritten to
speak the 1.7.1 protocol, which was reverse engineered from the official client and server.
SDL, OpenGL, OpenAL and the file system were replaced with WebGL 2, WebAudio and IndexedDB.
Browsers can't send UDP, so a small Node.js relay with no dependencies carries the game's
packets over a WebSocket.

![The menu: server list and gostek preview](docs/screenshots/menu.png)

## Soldat TV

Live matches in the browser, without joining them. Soldat TV joins each server once, as a
spectator, and streams that one connection to every viewer.

- **An auto camera that directs the match.** It picks who to follow: the flag carrier, the
  fight, whoever just got the kill. It frames them with their enemies, zooms out for a
  fight and back in, eases its moves, and cuts when the action is far away.
- **Or take the camera**: follow one player, look around freely, or see the whole map.
- **On screen**: the score, flag news, the kill feed and the followed player's card.
- **Viewer chat**, with everyone on the site or only the people watching the same server.
- **Replays of every recorded match**, with pause, speed (¼× to 4×) and a timeline marked
  with the captures and the best plays.
- **Highlights found automatically**: multi-kills, two kills with one shot, long shots,
  knife throws, saves, clutch captures. Watch a match's highlights back to back, share a
  link to a single clip, or make a reel of several matches.
- **Match ratings** from 0 to 100, for how good a match is to watch.
- **Your own demos**: drop a `.sdm` file to play it, highlights included. It never leaves
  your browser. Demos of Soldat 1.6.8 and 1.7.0 are converted as they open, and the converted
  file can be downloaded ([old demo formats](docs/DEMOS.md)).
- A **broadcast delay** so players can't use the stream to spy on each other, and phones work
  held sideways.

![A CTF round on ctf_Lanubya](docs/screenshots/lanubya.jpg)

## Run it yourself

You need [Node.js](https://nodejs.org) 18 or newer. The built game is in the repository, so
there's nothing to compile.

```bash
node relay/play.mjs              # the game, at http://localhost:8080
```

```bash
cp relay/spectator.example.json relay/spectator.json   # the servers to watch
node relay/spectator.mjs         # Soldat TV, at http://localhost:8090
```

Every setting is described at the top of [relay/play.mjs](relay/play.mjs) and
[relay/spectator.mjs](relay/spectator.mjs). Before you open a relay to the public:

- **Game servers see the relay's IP address**, not the players'. An IP ban hits everyone on
  the relay, so players get hardware IDs that servers can ban with `/banhw` instead. With
  Discord sign-in on (`DISCORD_CLIENT_ID`), each account keeps the same hardware ID.
- **Anyone can list a server in the lobby.** Every server the relay joins learns its address.
  Set `SERVER_LIST` to join only the servers you choose.
- Put it behind HTTPS that passes WebSocket upgrades. A player uses 10 to 30 KB/s.
- For Soldat TV, ask a server's admins before you add it. It needs a free spectator slot.

## Build it

On macOS. On Debian, install
`fpc clang wasi-libc innoextract nodejs git curl patch python3 build-essential` with apt
instead, and run `c/build-c.sh` with `LLVM=/usr/bin WASI_SYSROOT=/usr`.

```bash
brew install fpc llvm wasi-libc innoextract node
tools/setup-fpc.sh                  # Free Pascal cross-compiler for WebAssembly
c/build-c.sh                        # FreeType 2.6.1 and stb_image
tools/fetch-assets.sh assets-src    # game data: Soldat base + the official 1.7.1 files
python3 tools/build-assets.py --base assets-src/base --v171 assets-src/app --out web
./build.sh                          # -> web/soldat.wasm, web/soldat-spectate.wasm
```

Leave out `--v171` for a game data pack you can share freely. The game then downloads
anything missing from the server, like a custom map.

## Inside

```
 browser                          relay (Node.js)              Soldat 1.7.1 server
 ┌──────────────────────────┐     ┌──────────────────┐         ┌──────────────────┐
 │ soldat.wasm (Pascal)     │ WS  │   WS <-> UDP     │  UDP    │ game port        │
 │ WebGL2, WebAudio, input  │<───>│   map downloads  │<──────> │ port+10: files   │
 │ IndexedDB file system    │HTTP │   server list    │  HTTPS  │ lobby API        │
 └──────────────────────────┘     └──────────────────┘         └──────────────────┘
```

- `src/`: the client in Pascal. `src/shared/network/` is the 1.7.1 network code
  ([protocol notes](docs/PROTOCOL-1.7.1.md)). `src/web/` stands in for SDL2, OpenGL and
  OpenAL. `src/spectator/` adds Soldat TV's camera.
- `web/js/`: the browser side. `web/js/spectate/` has Soldat TV's director, replays and
  highlights, and the conversion of older demos (`legacy.js`, also `tools/migrate-demo.mjs`).
- `relay/`: the game relay (`play.mjs`) and the Soldat TV hub (`spectator.mjs`).

## Credits and license

Soldat was created by Michal Marcinkowski and © Transhuman Design. Get the original game at
[soldat.pl](https://soldat.pl/en/) or on [Steam](https://store.steampowered.com/app/638490/Soldat/).

The code is MIT licensed, see [LICENSE](LICENSE). It is the Soldat client by Transhuman
Design and contributors ([Soldat/soldat](https://github.com/Soldat/soldat)) plus the web
port by [humanova](https://twitter.com/humanova).

The game data is not covered by that license: `web/soldat.smod` and `web/assets/` hold files
of Soldat 1.7.1 (freeware, © Transhuman Design, all rights reserved) and of the
[base game content](https://github.com/opensoldat/base) (CC BY 4.0). The screenshots and
link previews are pictures of the game. Soldat TV's icons are made from Soldat's own.

Also included: the Play font by Jonas Hecksher (SIL Open Font License 1.1), the country flags
of [flag-icons](https://github.com/lipis/flag-icons) (MIT), stb_image (public domain) and
FreeType (FreeType License). Portions of this software are copyright © 2015 The FreeType
Project (www.freetype.org). All rights reserved.
