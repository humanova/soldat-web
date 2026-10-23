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
`askPassword` and `record` work as for a 1.7.1 server.

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

The page shows a Reloaded channel as any other. The picture is the game in a frame
(`/reloaded/?line=<hub>/watch&watch=<id>&tv=1`) under the page's own picture, which takes the
mouse and the keys. With `tv` the game is Soldat TV's as the 1.7.1 spectator build is
(`apps/client/match/tv.odin` in `reloaded/`): it takes the same calls by the same names
(`soldat_spectator_follow`, `_zoom`, `_pan`, `_overview`, `_frame`, `_mouse`, `_auto`) and hands
over its state and events as text in the same formats. The frame is of the page's origin, so
the page calls it directly (`window.soldatTv`). So the camera (Auto, a player, free, the whole
map, the zoom), the score, the flag news, the vote, the followed player's card, the roster
and the game's chat are the page's, as on a 1.7.1 channel; the game draws the world, the kill
feed and the names over heads.

## Recordings

With `record`, the hub records each round it is watched for as Reloaded's own demo (a
`.srdm`, `relay/lib/reloaded/record.mjs`), kept with the 1.7.1 demos in the recordings
folder. Its summary (`<id>.json`) has `"game": "reloaded"`, the map's SHA-256 (`mapHash`), the
players and the teams' captures. The demo is what the hub's viewers hear: the server's
messages from the round's `Map` on, and a tick of the game every 60th of a second, as the
game's own recorder writes them. It plays in the game as a demo the game recorded.

The hub also writes its director's picks into the demo, as a record of a kind of its own
(`camera`, a slot), which the game's demo player passes over and its Soldat TV mode tells the
page.

A replay of one (`/replay?id=<id>`) opens the game in the frame with the demo
(`/reloaded/?demo=/demos/<id>.srdm&map=<map>&mapUrl=/reloaded/maps/<mapHash>.pms&tv=1`). The
game fetches the demo, and the map from the hub's copy if it hasn't got it. The game plays
the demo; the page's bar asks it where it is, sets its speed and has it jump
(`soldat_tv_demo_*`), as `web/js/spectate/reloaded-replay.js` does in `Replay`'s place. So a
Reloaded replay has the bar of any replay (the speed, the timeline with the captures and the
plays, J/L and the other keys), highlights only, a match's clips (`&clip=<n>`) and reels of
several matches, 1.7.1's and Reloaded's mixed (`/replay?reel=...`). The guide marks them
`Reloaded`.

A `.srdm` from the viewer's computer plays on the demo page (`/demo`) the same way, from a
`blob:` address: nothing is sent. Its map must be one the game has. Its plays, its rating and
the director's picks are found in the page, by the same code the hub runs
(`web/js/spectate/reloaded-plays.js`).

### Highlights and rating

A Reloaded match has highlights and a rating as a 1.7.1 match has them: the same plays, the
same rules, by the same code (`findPlays` in `web/js/spectate/highlights.js`).
`web/js/spectate/reloaded-plays.js` reads the demo into what that code takes, in the relay
and in the page alike (a demo file dropped on `/demo` is read where it is). The kills, the
flags taken and the captures are the server's words in the snapshots; who plays, where,
where the flags are, the clock and the score are the snapshots' state. A kill's weapon is
given 1.7.1's number for it, and its distance is in metres in both games.

Times are the demo's ticks, as its player and the game's bar count them. Something the
server did on its tick T is at the first demo tick that shows T.

Reading a demo's snapshots takes a second or two, so the relay does it on a thread of its
own (`plays-worker.mjs`):

- as a round's demo is kept, for its summary's `highlights` and `rating`;
- as the relay starts, for any Reloaded summary kept without them;
- for `/api/demos?id=<id>&clips`, which adds the demo's `clips` (the last 20 are kept).
  The page finds a 1.7.1 demo's clips in the demo itself.

A demo recorded before the hub wrote its director's picks into it has no camera records.
For one of those, `&clips` also adds `cams` (`[{ tick, slot }]`): the picks worked out from
its snapshots by the hub's director, each 800 ms early, as `directDemo` does for an old 1.7.1
demo. A demo with picks of its own has no `cams`.

## Playing

The play relay (`relay/play.mjs`, play.soldat.live's) lets a browser play on a Reloaded server
too. It serves the game at `/reloaded/` (`RELOADED_WEB`, default `reloaded/web/dist`), and
`/reloaded/?play=<host>:<port>` joins that server through it: the game's line is a WebSocket to
the relay's `/relay`, greeted with `{ type: 'reloaded', host, port }`, and the relay holds an
ENet peer to the server for each player (`relay/lib/reloaded/play.mjs`). The messages go through
unchanged, each on its kind's channel, but a signed-in player's `Hello` carries their Discord
account's hardware id, as their 1.7.1 `RequestGame` does. Discord sign-in, the limits on
sessions and games per account, and the blocked accounts are the 1.7.1 relay's. A Reloaded
server is in no 1.7.1 lobby, so the relay joins one only from its server list (`SERVER_LIST`),
`ALLOW` or `ALLOW_ANY`. The game's own server browser doesn't work in a browser (it asks
servers over UDP): a page names the server to join.

Soldat TV's guide has a Play link on a Reloaded server's row, to
`play.soldat.live/reloaded/?play=<host>:<port>`, only when its entry in the config has `play`:
`true` for its `host:port`, or the `"host:port"` to join (when the hub reaches the server at an
internal address). That is the only server address in the relay's `/api/watch` listing (the
hubs' reasons that viewers see have theirs taken out), so put a server there only once it is
on the play relay's list too (`SERVER_LIST` or `ALLOW`): elsewhere the link would show an
address that can't be played.

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
- The hub's director (`web/js/spectate/reloaded-director.js`, around `director.js` there) scores the
  players on the snapshots it reads and the words in them (shots, damage, kills), as it scores
  them on a 1.7.1 server's messages. Its picks go to the viewers as `{ type: 'follow', slot }`
  text through the delay, a little early, and a viewer who comes in hears the last one. The
  page's Auto follows them.
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
- `web/js/spectate/reloaded-wire.js`: Reloaded's wire as the page and the relay both read it:
  the bits, the field tables, the words and the snapshots. Its snapshots are written by field
  tables made from its structs' `net` tags. `tools/reloaded/dump-wire.sh` builds a small
  Odin program against a Reloaded checkout that prints those tables, the unions' variants
  and the enums as `relay/lib/reloaded/wire-<version>.json`, and copies the newest into
  `web/js/spectate/reloaded-wire-data.js` (`tools/reloaded/wire-js.mjs`). A new protocol
  version is a new dump, and a new build of `reloaded/` on the same version.
- `relay/lib/reloaded/wire.mjs`: that, and Reloaded's messages, which only the relay reads and
  writes.
- `relay/lib/reloaded/query.mjs`: the server's own query, for the guide's list.

## Developing

Everything can run on one machine: a Reloaded server with bots, a relay of its own, and the
game built for the browser.

1. The game: `git submodule update --init`, then build `reloaded/web/dist` (its
   `web/README.md`).
2. A server: in `reloaded/`, `cd assets && odin run ../apps/server -- -port:24073`. Its
   bots are set in `assets/server.config.mjson` (`bots`), and a short `time_limit` (2) gives
   a new round, and a recording, every few minutes. Its bots move on ctf_Ash, but stand at
   their spawn on ctf_Aftermath and ctf_Bolanos, so give it a rotation of `["ctf_Ash"]`.
   The server rewrites that file as it starts, so leave it out of commits.
3. A config of its own, outside the repo (never `relay/spectator.json`):

   ```json
   {
     "port": 8199,
     "playerName": "Soldat TV test",
     "lingerSeconds": 30,
     "servers": [
       { "id": "sr-local", "name": "SR local", "host": "127.0.0.1", "port": 24073, "game": "reloaded", "record": true },
       { "id": "sr-delay", "name": "SR local, 10 s delay", "host": "127.0.0.1", "port": 24073, "game": "reloaded", "delaySeconds": 10, "record": true }
     ],
     "recordings": { "dir": "data/recordings", "minSeconds": 20, "minPlayers": 2 },
     "reloaded": { "dir": "data/reloaded" },
     "lobbyUrl": "https://127.0.0.1:1/v0/servers"
   }
   ```

   `lobbyUrl` points nowhere so the guide lists only these two. The relay keeps its
   recordings and map files next to the config.
4. `node relay/spectator.mjs --config <the config> --port 8199`, and open
   `http://127.0.0.1:8199/`. A round is recorded while it is watched, plus `lingerSeconds`.
   Its replay is in the guide's replays once the round ends.
5. `node tools/reloaded/check-demo.mjs <recordings>/<id>.srdm.gz` reads a recording back as
   the game would: its header, its records, and every snapshot against its base.
   `npm test` runs the relay's tests, Reloaded's among them.

A demo also plays in the game outside the browser: copy it into `reloaded/assets/demos/`,
then `cd reloaded/assets && odin run ../apps/client -- demos/<id>.srdm`.
