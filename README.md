# Soldat Web

Soldat 1.7.1 in your browser, on the official public servers.
See the [demo video](https://youtu.be/rnsfcZrFU7s).

![A CTF round on ctf_Ash](docs/screenshots/battle.jpg)

This is the Soldat client compiled to WebAssembly, with its
network code rewritten to speak the 1.7.1 protocol. It started from the [open source codebase](https://github.com/soldat/soldat), but restoring 1.7.1 behavior required reverse-engineering the current official
client and server binaries to roll back divergences in that code base, as well as porting
the rendering and platform layers.

Browsers can't send UDP, so a small Node.js relay passes the game's packets
between the page and the game server.

## Play

You need [Node.js](https://nodejs.org) 18 or newer.
The built game is part of this repository, so there's nothing to
compile. Clone the repository and then run:

```bash
node relay/play.mjs
```

Then open <http://localhost:8080>.

1. Set up your gostek on the right. The preview uses the game's own sprites, skeleton
  and animation. Standing on the map of the server you select.
2. Pick a server and press **Join**, or double-click it. **Quick join** takes you to the
   busiest server that has room.

![The menu: server list and gostek preview](docs/screenshots/menu.png)

A few extras:

- `http://localhost:8080/?join=1.2.3.4:23073` fills in a server address.
- With "Full screen while playing" on, Chrome and Edge let the game have keys like Esc
  and Ctrl+W.
- `Alt+F3` in the game shows the frame rate and ping.

## What works

Everything you do in a round: moving, jets, all weapons and grenades, team and
spectator mode, chat, team chat, radio, the scoreboard and kill feed, and map changes.
Joining works for any game mode.

Maps the browser doesn't have, custom maps included, are downloaded from the game server
the same way the original client does it. Settings and downloaded maps stay in your
browser.

The game renders at your screen's resolution and refresh rate, and keeps the original's
look: the same texture settings, and the compressed sounds decoded the way SDL decodes them.

**Doesn't support**: Recording and playing demos.

![A CTF round on ctf_Lanubya](docs/screenshots/lanubya.jpg)

## Host it for others

The relay serves the page, proxies the server list and map downloads, and forwards the
game traffic. Put it behind a reverse proxy that handles HTTPS and passes WebSocket
upgrades on `/relay` (pages served over HTTPS must use `wss://`). Each player uses about
10 to 30 KB/s.

| Setting | Default | What it does |
|---|---|---|
| `--port` / `PORT` | 8080 | HTTP port |
| `--root` / `ROOT` | `web/` | folder with the client |
| `--allow` / `ALLOW` | none | extra `host:port` game servers to allow (by default only servers in the Soldat lobby) |
| `ALLOW_ANY=1` | off | allow any server (private setups only) |
| `ORIGINS` | same origin | other sites allowed to use the relay (`*` for any) |
| `TRUST_PROXY=1` | off | take the client address from `X-Forwarded-For` |
| `MAX_SESSIONS_PER_IP` | 4 | game and download sessions per visitor |

Good to know before you open it to the public:

- Everyone on your relay reaches game servers from the relay's IP address, so an IP ban
  on one of them bans all of them. Each browser still gets its own hardware ID, which
  servers can ban instead.
- A 1.7.1 server blocks an address that sends more than 18 join requests in about 16
  seconds. The relay spaces out joins per server (at most 14 per 17 seconds), so when
  many players join at once, some wait a few seconds.
- WebSockets run over TCP. On a lossy connection one lost packet holds up the ones behind
  it, which real UDP wouldn't do. On a good connection you won't notice.

## Soldat TV (live spectator)

`relay/spectator.mjs` is a separate, public-facing server for watching matches: Soldat TV.
It joins each game server named in its config once, as a spectator, and streams that one
connection to every viewer. Viewers can't play, chat or vote, and they can't pick a
server that isn't in the config, so the hub's IP only ever reaches those servers, with
a single spectator each.

```bash
cp relay/spectator.example.json relay/spectator.json   # list the servers to watch
node relay/spectator.mjs                                # http://localhost:8090
```

The page (`spectate.html`, the spectator client `soldat-spectate.wasm`) lists the
servers busiest first, with their map, mode and who plays, from the Soldat lobby (or from
the hub itself while it watches, with the players' teams). While watching:

- **Auto** follows the hub's pick (a flag carrier, else whoever just scored a kill);
  ‹ › or the players list follow one player; dragging moves the camera yourself; **Map**
  shows the whole map.
- Zoom with the mouse wheel, a touchpad pinch or two fingers; drag (or one finger) to
  look around. Zoomed out, team coloured arrows mark the players and flag icons the
  flags and their carriers. The game's own keys and menus are off in this build: the
  page drives the camera through the `soldat_spectator_*` exports
  (`src/spectator/Spectator.pas`).
- The page shows the score with where the flags are, flag news (taken, dropped,
  returned; a score is a big message), the followed player's health, weapon and kills and
  deaths, and the chat (closed until you open it). The game draws none of these itself in
  this build: no HUD, console, chat bubbles or team box, and a smaller kill feed.
- Drag a panel by its bar (the score and the flag news anywhere) to move it; a
  double-click on the bar puts it back. The browser remembers where they are.
- Phones work held sideways; the page asks you to turn an upright phone.

The server doesn't serve the game page and has no play relay. A viewer who opens a match
mid-game gets the current players, items and scores from the hub. Settings: `servers`
(`id`, `name`, `host`, `port`, optional `password` and `delaySeconds`), `playerName`,
`delaySeconds` (a broadcast delay, so players can't use the stream to spy on their
opponents), `lingerSeconds`, `maxViewers`, `maxViewersPerIp`, `origins`, `trustProxy` and
`lobbyUrl`.

- The game server needs a free spectator slot (`Max_Spectators`). If it has none, the
  hub reports that and never joins a team. Ask the admins before you add their server.
- The server sends frequent updates (and bullets) only around the player a spectator
  follows, and everyone shares the hub's camera target. Players far from it, as in
  the Map view, move less smoothly.

## Build it yourself

On macOS with Homebrew:

```bash
brew install fpc llvm wasi-libc innoextract node
tools/setup-fpc.sh                  # Free Pascal cross-compiler for WebAssembly -> ~/fpc-wasm
c/build-c.sh                        # FreeType 2.6.1 and stb_image -> c/obj/
tools/fetch-assets.sh assets-src    # game data: Soldat base + the official 1.7.1 files
python3 tools/build-assets.py --base assets-src/base --v171 assets-src/app --out web
./build.sh                          # -> web/soldat.wasm, web/soldat-spectate.wasm
```

On Debian Linux:

```bash
sudo apt update
sudo apt install fpc clang wasi-libc innoextract nodejs git curl patch python3 build-essential
tools/setup-fpc.sh                  # Free Pascal cross-compiler for WebAssembly -> ~/fpc-wasm
LLVM=/usr/bin WASI_SYSROOT=/usr c/build-c.sh  # FreeType 2.6.1 and stb_image -> c/obj/
tools/fetch-assets.sh assets-src    # game data: Soldat base + the official 1.7.1 files
python3 tools/build-assets.py --base assets-src/base --v171 assets-src/app --out web
./build.sh                          # -> web/soldat.wasm, web/soldat-spectate.wasm
```

`tools/setup-fpc.sh` builds a pinned Free Pascal trunk commit with one small patch for
its WebAssembly linker. Set `FPCROOT=...` for `build.sh` if you install it elsewhere.
`./build.sh play` or `./build.sh spectate` builds one of the two clients.

The pack prefers the files of the official 1.7.1 download (freeware, © Transhuman Design, all rights reserved), because that's what servers run.
The [base game content](https://github.com/opensoldat/base) is CC BY 4.0. For a pack you
can share freely, leave out `--v171`: anything a map needs that the base set lacks is then
downloaded from the game server, like for any custom map.


## How it works

```
 browser                                   relay (Node.js)              Soldat 1.7.1 server
 ┌───────────────────────────────┐        ┌──────────────────┐         ┌──────────────────┐
 │ soldat.wasm (Pascal client)   │  WS    │/relay: WS <-> UDP│  UDP    │ game port        │
 │  WebGL2 / WebAudio / input    │<──────>│ file server proxy│<──────> │ port+10: files   │
 │ js/: WASI FS, SDL, GL, AL,    │  HTTP  │   /api/servers   │  HTTPS  │ lobby API        │
 │      PhysFS, net              │<──────>│   static files   │<──────> │                  │
 └───────────────────────────────┘        └──────────────────┘         └──────────────────┘
```

- `src/`: the Soldat client in Pascal, built with `-dWEB` (`soldatweb.lpr`). The spectator
  (`soldatspectate.lpr`) is the same client built with `-dSPECTATOR` plus `src/spectator/`.
  `src/shared/network/` holds the rewritten 1.7.1 network code; [docs/PROTOCOL-1.7.1.md](docs/PROTOCOL-1.7.1.md) describes
  the protocol. `src/web/` replaces SDL2, OpenGL, OpenAL, PhysFS and Steam with small
  units implemented in JavaScript.
- `c/`: FreeType 2.6.1 (patched for WebAssembly, see `c/freetype-wasm.patch`) and
  stb_image, compiled with clang and linked into the module.
- `web/js/`: the browser side: a file system with IndexedDB storage, WebGL 2 (the game's
  shaders are translated to GLSL ES), WebAudio, input, the relay client and the menu.
- `web/soldat.smod`: the game data. Map textures and scenery are in `web/assets/`.
- `relay/play.mjs`: the relay. `relay/spectator.mjs`: the spectator hub
  (`relay/lib/hub.mjs` does the work). Both share `relay/lib/` and have no dependencies.

## Credits and license

Soldat was created by Michal Marcinkowski and © Transhuman Design. Get the original
game at [soldat.pl](https://soldat.pl/en/) or on
[Steam](https://store.steampowered.com/app/638490/Soldat/).

The code in this repository is MIT licensed, see [LICENSE](LICENSE). It is the Soldat
client by Transhuman Design and contributors ([Soldat/soldat](https://github.com/Soldat/soldat))
plus the web port by [humanova](https://github.com/humanova).

The game data is not covered by that license: `web/soldat.smod` and `web/assets/` hold
files of Soldat 1.7.1 (freeware, © Transhuman Design, all rights reserved) and of the
[base game content](https://github.com/opensoldat/base) (CC BY 4.0). The screenshots are
pictures of the game, and the icon (`web/favicon.ico`, `web/soldat-icon.png`) is Soldat's own.

Also included: the Play font by Jonas Hecksher (SIL Open Font License 1.1), the country
flags of [flag-icons](https://github.com/lipis/flag-icons) (MIT, `web/flags.png`), stb_image
(public domain) and FreeType (FreeType License). Portions of this software are copyright
© 2015 The FreeType Project (www.freetype.org). All rights reserved.
