# Soldat Reloaded on Soldat TV

Soldat TV also watches [Soldat Reloaded](https://github.com/soldatreloaded/soldatreloaded)
servers live. Viewers watch them in Reloaded's own game, built for the browser (the
`reloaded/` submodule), not in the 1.7.1 spectator client. A server entry with
`"game": "reloaded"` does it:

```json
{ "id": "reloaded-eu", "name": "Soldat Reloaded EU", "host": "203.0.113.7", "port": 23073, "game": "reloaded" }
```

`port` is the game port. Reloaded has no spectator slots: the hub joins as a player, picks
the spectator team (`/team 5`), and takes one of the 32 slots. `delaySeconds`, `group` and
`askPassword` work as for a 1.7.1 server. Recording (`record`) does not yet.

Optionally, at the top level, `"reloaded": { "dir": "data/reloaded", "web": "reloaded/web/dist" }`:
- `dir` is where the hub keeps the map files it fetches from the servers (default
  `data/reloaded` next to the config).
- `web` is the web build of the game, served at `/reloaded/` (default `reloaded/web/dist` in
  the repo).

## The game

`reloaded/` is the web port of Soldat Reloaded, a fork of its repo with a browser build
(`reloaded/web/`, see its README). The game compiles to WebAssembly unchanged but for its
platform layer: the network line is a WebSocket, files live in the page, and the map's
images are fetched as a map needs them. Build it once, and again after updating the
submodule:

```sh
git submodule update --init
ODIN=... WASI_SDK=... RAYLIB=... reloaded/web/build.sh all    # writes reloaded/web/dist
```

The page shows a Reloaded channel as any other: the guide, the channel bar, the delay and
Soldat TV's chat. The picture is the game in a frame (`/reloaded/?line=<hub>/watch&watch=<id>`),
with its own HUD, scoreboard, chat and controls for following the players.

## How it works

The hub forwards the server's messages unchanged. It reads as little of them as it can:

```
Reloaded server ──ENet──> client.mjs ──the server's own messages──> hub.mjs ──/watch──> each viewer's game
                          joins, acknowledges                       delay, the join,
                                                                    map downloads
```

- Each viewer's game joins the hub as it would join the server. The hub answers as the
  server answers a joining player (`players.odin`): `Welcome` with the hub's own slot (every
  viewer plays the part of the hub's spectator), then the weapons, the round's `Map` and its
  art, the scripts' texts, the round's end and the vote, each as it stands where the viewer
  comes into the stream. Then come the server's messages as they arrive.
- Nothing a viewer's game sends goes to the server. The hub reads the header of its state
  (to see what it has heard) and answers its map downloads (`Map_Fetch`) from its own copy.
  It fetched that copy from the server once, when the round began (`files.mjs`, by SHA-256).
- Reloaded sends each snapshot as a delta against the newest one the client acknowledged.
  Every viewer gets every snapshot, so any snapshot the hub acknowledges is a base the
  viewers have. The hub reads one snapshot in six (`client.mjs`): it acknowledges those, and
  the server's words (kills, captures) in them. A word comes again in every snapshot until
  it is acknowledged, so none is missed. The others pass through with only their header
  read.
- A viewer's game reads no snapshots while its map loads, so afterwards it needs a whole
  one. The hub holds its acknowledgement back until the server, its base grown too old,
  sends whole snapshots. Without a delay it does this while some viewer has not yet heard
  the stream. With a delay it does this every 3 seconds, because one asked for now reaches
  viewers only a delay later.

The cost on the relay, against a local server with 6 bots: about 3.4% of a CPU core for the
connection to the server. Reading the snapshots is 0.4% of that, and the rest is ENet and
UDP. Each viewer adds about 0.1%.

- `relay/lib/reloaded/enet.mjs`: the client side of ENet 1.3, as much as Reloaded uses
  (one peer, a reliable and an unreliable channel, fragments).
- `relay/lib/reloaded/wire.mjs`: Reloaded's messages. Its snapshots are written by field
  tables made from its structs' `net` tags. `tools/reloaded/dump-wire.sh` builds a small
  Odin program against a Reloaded checkout that prints those tables, the unions' variants
  and the enums as `wire-<version>.json`. A new protocol version is a new dump, and a new
  build of `reloaded/` on the same version.
- `relay/lib/reloaded/query.mjs`: the server's own query, for the guide's list.
