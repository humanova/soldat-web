# Soldat Web — Soldat 1.7.1 in the browser

A port of the Soldat client to WebAssembly that plays on the **official Soldat 1.7.1
servers** (the ones in the in-game lobby). It is the open-sourced Soldat client code base,
compiled with Free Pascal to WebAssembly, with its network layer rewritten to speak the
closed 1.7.1 protocol (reverse engineered from the 1.7.1 dedicated server, see
`docs/PROTOCOL-1.7.1.md`).

Browsers cannot send UDP, so a small relay (`relay/server.mjs`, Node.js, no dependencies)
forwards the game's datagrams between a WebSocket and the game server. The same program
serves the web page, proxies the lobby server list and the servers' map downloads.

## Quick start

Requirements: Node.js 18 or newer, and a desktop browser with WebAssembly and WebGL 2
(current Chrome, Edge, Firefox or Safari).

```bash
node relay/server.mjs
```

Open http://localhost:8080, set your name and colors, pick a server and press **Join**
(or double-click the server). Links like `http://localhost:8080/?join=1.2.3.4:23073`
pre-fill the address. With `?debug=1` the browser's developer console shows the game
console and network messages.

The first click in the game captures the mouse. Esc opens the in-game menu ("Exit to
menu" returns to the server list). With "Full screen while playing" enabled, Chrome and
Edge also capture keys such as Esc, Ctrl+W and Ctrl+Q for the game.

## What works

Verified against the real 1.7.1 dedicated server (2.8.2) and live public servers, with an
independent client decoding what the server relays to other players:

- joining CTF, DM and survival servers, spectating, team selection, a wrong or correct
  server password, timeouts for servers that do not answer
- movement, aiming, shooting and grenades: the server accepts the client's encrypted
  updates and relays them to other players
- staying connected on servers with anti-cheat enabled (the periodic status checks are
  answered truthfully)
- map changes at the end of a round, by `/map` or by vote: the next map is loaded when the
  scoreboard countdown ends, like in the original client (the session carries over); a
  change the client missed is noticed through the heartbeat and resolved with the
  original client's map request
- maps and graphics the browser lacks are downloaded from the game server's file server
  (custom maps included); map textures and scenery come from the web server's mirror
  when it has them. For a map change they are fetched while the scoreboard is shown
- chat, team chat, radio, Unicode chat, server messages and scripts, server commands
  such as `/votemap` and `/kill`, scoreboard, kill feed
- settings and downloaded maps persist in the browser (IndexedDB)
- rendering at the display's refresh rate (60, 120, 144 Hz...) with the engine's
  interpolation between the 60 Hz physics ticks; a frame takes about 1 ms of CPU on an
  Apple M2 Pro with 24 bots on the server. `Alt+F3` shows the frame rate and ping.
  The `r_fpslimit`/`r_maxfps` settings have no effect in the browser.
- sounds, including the compressed (MS ADPCM) ones, decoded like SDL does (WebAudio; sound
  starts after the first click, as browsers require)
- rendering at the display's native resolution, with the 1.7.1 defaults for texture
  sharpness (mipmap LOD bias), smooth polygon edges and dithering
- text rendered with FreeType 2.6.1, the version the 1.7.1 Windows client ships, so the
  glyph shapes, widths and line metrics match the original (later versions hint the Play
  font differently)

Implemented the same way as the original client but not verified end to end: the vote
menus, and being kicked or banned (the reason stays on screen until Esc). As in the
original, the client disconnects itself after 3 minutes without mouse movement.

Not supported: recording or playing demos, Steam features, the in-game voice chat.
Desktop only (keyboard and mouse).

## Running it on a public site

`relay/server.mjs` options (flags or environment variables):

| Setting | Default | Meaning |
|---|---|---|
| `--port` / `PORT` | 8080 | HTTP port (page, `/api/servers`, WebSocket `/relay`) |
| `--root` / `ROOT` | `web/` | directory with the client |
| `--allow` / `ALLOW` | — | extra `host:port` game servers (the relay only connects to servers listed in the Soldat lobby) |
| `ALLOW_ANY=1` | off | allow any destination (private deployments only) |
| `ORIGINS` | same origin | other page origins allowed to use the relay (`*` for any) |
| `TRUST_PROXY=1` | off | take the client address from `X-Forwarded-For` (behind a reverse proxy) |
| `MAX_SESSIONS_PER_IP` | 4 | concurrent game/download sessions per visitor |

Put it behind a reverse proxy that terminates HTTPS and forwards WebSocket upgrades on
`/relay` (browsers require `wss://` on HTTPS pages). A player uses roughly 10–30 KB/s.

Things to know about relaying:

- **Every player behind the relay shares the relay's IP address** on the game server.
  An IP ban on one relayed player affects everybody using that relay (players still get
  distinct, persistent hardware IDs per browser, which servers can ban individually).
- The 1.7.1 server firewalls an address that sends more than 18 join requests within
  ~16 seconds. The relay paces join messages per server (at most 14 per 17 s) and the
  client retries gently, so many relayed players can join the same server, but a burst
  of joins (e.g. many players at a map change) is spread over a few seconds.
- The WebSocket runs over TCP: on lossy connections a lost packet delays the ones behind
  it, unlike real UDP. On good connections the relay adds only the WebSocket hop.

## How it works

```
 browser                                   relay (Node.js)              Soldat 1.7.1 server
 ┌───────────────────────────────┐        ┌──────────────────┐         ┌──────────────────┐
 │ soldat.wasm (Pascal client)   │  WS    │ /relay: WS <-> UDP│  UDP    │ game port        │
 │  WebGL2 / WebAudio / input    │<──────>│ file server proxy │<──────> │ port+10: files   │
 │ js/: WASI FS, SDL, GL, AL,    │  HTTP  │ /api/servers      │  HTTPS  │ lobby API        │
 │      PhysFS, net             │<──────>│ static files      │<──────> │                  │
 └───────────────────────────────┘        └──────────────────┘         └──────────────────┘
```

- `src/` — the client (Soldat/soldat, MIT) built with `-dWEB`. `src/shared/network/`
  holds the rewritten 1.7.1 network code (`Net.pas`, `NetCrypt.pas` for the Blowfish
  session cipher and message hashes, `NetworkClient*.pas`); `src/web/` replaces SDL2,
  OpenGL, OpenAL, PhysFS and Steam with small units whose functions are implemented in
  JavaScript, plus `WebMain.pas` (entry points) and fixes for Free Pascal's wasm RTL.
- `c/` — FreeType 2.6.1 (with `c/freetype-wasm.patch`) and stb_image compiled to wasm32
  with clang and linked into the module.
- `web/js/` — the JavaScript side: an in-memory file system with IndexedDB persistence
  (WASI), zip archives for PhysFS, WebGL2 (the game's GLSL 1.20 shaders are translated to
  GLSL ES), WebAudio, keyboard/mouse with pointer lock, and the relay client.
- `web/soldat.smod` — the game data (graphics, sounds, animations, maps, configs).
  Map textures and scenery are in `web/assets/` and loaded when a map needs them.

## Building from source

On macOS with Homebrew (Linux works the same with its packages):

```bash
brew install fpc llvm wasi-libc innoextract node
tools/setup-fpc.sh                  # Free Pascal trunk cross-compiler -> ~/fpc-wasm
c/build-c.sh                        # FreeType, stb_image -> c/obj/
tools/fetch-assets.sh assets-src    # base game data (+ official 1.7.1 files)
python3 tools/build-assets.py --base assets-src/base --v171 assets-src/app --out web
./build.sh                          # -> web/soldat.wasm
```

`tools/setup-fpc.sh` builds FPC at a fixed trunk commit with one patch
(`tools/fpc-ogwasm-table-number-leb.patch`) that lets the internal wasm linker accept a
relocation clang emits. Use `FPCROOT=...` with `build.sh` if you install it elsewhere.

**Game data licensing.** The pack prefers the files of the official 1.7.1 download
(Copyright Michal Marcinkowski, freeware, "all rights reserved") because that is what
servers run; the Soldat base repository's assets are CC BY 4.0. To produce a pack you
may redistribute freely, leave out `--v171`: graphics a map needs that the base set
lacks are then downloaded from the game servers, like any custom map.

`tools/protocol/` contains the Python tools used to verify the protocol against a real
server (join probe, spectator that decodes what the server relays, capture decoder,
admin console client; they need `pip install pycryptodome`).

`tools/bench/bench.mjs` measures frame pacing and the CPU and GPU time of each frame in
a separate headless Chrome (Node 22, no dependencies; `CHROME=` points to another
browser binary). Join a server that has bots, for example:

```bash
node tools/bench/bench.mjs --server 1.2.3.4:23073 --url http://localhost:8080/ --profile out.cpuprofile
```

`--uncapped` turns vsync off to show the highest frame rate; `--profile` also prints
where the CPU time goes, by Pascal function name (`tools/bench/profile.mjs` summarizes a
saved profile).

## Credits

Soldat by Michal Marcinkowski; open-source client by Transhuman Design and contributors
(MIT). Game assets from the Soldat base repository (CC BY 4.0) and Soldat 1.7.1.
Play font (SIL Open Font License). FreeType (FreeType License), stb (public domain).
