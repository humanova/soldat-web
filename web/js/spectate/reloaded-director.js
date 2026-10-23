// The hub's director (director.js) on a Soldat Reloaded server: it scores the players on what
// the snapshots the hub reads say (relay/lib/reloaded/client.mjs: one in six, every soldier in
// each) and on the server's words in them (shots, damage, kills), in place of 1.7.1's
// messages; whom it picks is as on a 1.7.1 server. Slots are the director's and the page's,
// 1 to 32: a soldier's id plus one.
import { Director } from './director.js';
import { E, MAX_PLAYERS } from './reloaded-wire.js';

const FIRE = 2 ** E.Button.Fire;
const FLAGS = new Set([E.Thing_Kind.Alpha_Flag, E.Thing_Kind.Bravo_Flag]); // a flag of team n is kind n

export class ReloadedDirector extends Director {
  constructor() {
    super();
    this.teams = new Map();    // slot -> team: who may be followed
    this.thingKinds = [];      // a thing's kind as last read, by its index
  }

  // A snapshot read (snapshotBody's frame), the words new in it ({ word }), the hub's own
  // soldier (its id); now in ms.
  seeFrame(f, words, own, now) {
    const { State, Gone } = E.Snap_Word;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const slot = i + 1;
      if (f.word[i] === Gone || (f.word[i] === State && !f.soldiers[i].active)) {
        this.players.delete(slot);
        this.teams.delete(slot);
        continue;
      }
      if (f.word[i] !== State) continue;   // as it was
      const s = f.soldiers[i];
      if (i === own || s.team === E.Team.Spectator || s.team === E.Team.None) {
        this.teams.delete(slot);
        continue;
      }
      this.teams.set(slot, s.team);
      const p = this.player(slot);
      [p.x, p.y] = s['body.pos'];
      [p.vx, p.vy] = s['body.velocity'];
      p.seen = true;
      if (s['controls.buttons'] & FIRE) p.firedAt = now;
      const health = s['vitals.health'], dead = s['vitals.dead'];
      if (!dead && !p.dead && health < p.health - 0.5) p.hurtAt = now;
      if (dead && !p.dead) p.deadAt = now;
      p.dead = dead;
      p.health = health;
    }
    for (let i = 0; i < f.thingWord.length; i++) {
      if (f.thingWord[i] === Gone) {
        if (FLAGS.has(this.thingKinds[i])) this.flags.delete(this.thingKinds[i]);
        this.thingKinds[i] = 0;
      }
      if (f.thingWord[i] !== State) continue;
      const t = f.things[i];
      this.thingKinds[i] = t.kind;
      if (!FLAGS.has(t.kind)) continue;
      const [x, y] = t['points[0]'];
      this.flags.set(t.kind, { holder: t.holder == null ? 0 : t.holder + 1, x, y });
    }
    for (const { word } of words) this.seeWord(word, now);
  }

  seeWord(w, now) {
    if (w.type === 'Shot') {
      this.player(w.owner + 1).firedAt = now;
      return;
    }
    if (w.type !== 'Ruling') return;
    const r = w.inner;
    if (r.type === 'Damage') {
      this.player(r.target + 1).hurtAt = now;
    } else if (r.type === 'Kill') {
      const victim = r.target + 1, killer = r.killer + 1;
      const p = this.player(victim);
      if (!p.dead) p.deadAt = now;
      p.dead = true;
      if (killer !== victim) {
        const k = this.player(killer);
        k.kills.push(now);
        if (k.kills.length > 8) k.kills.shift();
        this.lastKill = { killer, victim, at: now };
      }
    }
  }

  // whom to follow now (a slot, 0: no one)
  pickNow(now) {
    return this.pick(now, [...this.teams].map(([slot, team]) => ({ slot, team })));
  }
}
