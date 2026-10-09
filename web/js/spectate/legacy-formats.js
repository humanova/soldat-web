// The message layouts of Soldat 1.2.0 to 1.7.1 and their betas, as their dedicated servers build
// them (docs/DEMOS.md has how each was found). legacy.js converts a demo's messages with them.
//
// A layout lists a message's fields after its header: [name, type], the type one of u8 i8
// u16 i16 i32 u32 f32, b<n> (n bytes taken as they are) or <type>[<n>] (an array). The
// header is ID: Byte; Hash: Word from 1.6.4 on, the ID alone before.

// ---------------------------------------------------------------- 1.7.1, the target

const heartbeat = (n) => [
  ['MapID', 'u32'], ['Active', `u8[${n}]`], ['Kills', `u16[${n}]`], ['Caps', `u8[${n}]`], ['Team', `u8[${n}]`],
  ['Deaths', `u16[${n}]`], ['TeamScore', 'u16[4]'], ['Ping', `u8[${n}]`], ['Flags', `u8[${n}]`],
];

const W = 20;  // weapons in ServerVars
export const L171 = {
  2: heartbeat(32),
  3: [['Num', 'u8'], ['Pos', 'b8'], ['Vel', 'b8'], ['AimAngle', 'u8'], ['Position', 'u8'], ['Keys16', 'u16'], ['Look', 'u8'],
    ['Vest', 'f32'], ['Health', 'f32'], ['Ammo', 'u8'], ['Grenades', 'u8'], ['Weapon', 'u8'], ['Secondary', 'u8'], ['ServerTicks', 'i32']],
  5: [['Owner', 'u8'], ['Weapon', 'u8'], ['Pos', 'b8'], ['Vel', 'b8'], ['Seed', 'u16'], ['Forced', 'u8']],
  7: [['Num', 'u8'], ['RespawnCounter', 'i16']],
  8: [['Counter', 'i16'], ['MapName', 'b17']],
  9: [['Thing', 'b68']],
  12: [['Num', 'u8'], ['Who', 'u8'], ['Style', 'u8'], ['Ammo', 'u8']],
  13: [['Num', 'u8'], ['Killer', 'u8'], ['KillBullet', 'u8'], ['Where', 'u8'], ['Constraints', 'u8'], ['Skeleton', 'b256'],
    ['Health', 'f32'], ['OnFire', 'u8'], ['RespawnCounter', 'i16'], ['ShotDistance', 'f32'], ['ShotLife', 'f32'], ['Ricochet', 'u8']],
  16: [['MapName', 'b16'], ['GameStyle', 'u8'], ['Players', 'u8'], ['KillLimit', 'u16'], ['Flags', 'u8'], ['ServerName', 'b24'],
    ['ServerInfo', 'b60'], ['Names', 'b768'], ['Colors', 'b640'], ['Team', 'b32'], ['PredDuration', 'b32'], ['MapID', 'u32'],
    ['Gravity', 'f32'], ['Look', 'b32'], ['PlayerPos', 'b256'], ['PlayerVel', 'b256'], ['Reserved', 'u16'], ['SessionID', 'u16'],
    ['TimeLimit', 'i32'], ['CurrentTime', 'i32'], ['MaxGrenades', 'u8'], ['ServerTicks', 'i32'], ['SurvivalClearWeapons', 'u8']],
  17: [['Num', 'u8'], ['Reserved', 'u16'], ['JoinType', 'u8'], ['Name', 'b24'], ['Colors', 'b20'], ['Team', 'u8'], ['Look', 'u8'], ['Pos', 'b8']],
  18: [],
  19: [['Num', 'u8'], ['Why', 'u8']],
  21: [['Num', 'u8'], ['Pos', 'b8'], ['Vel', 'b8'], ['Keys16', 'u16'], ['AimAngle', 'u8'], ['ServerTicks', 'i32']],
  25: [['Num', 'u8'], ['Weapon', 'u8'], ['Secondary', 'u8'], ['Ammo', 'u8']],
  26: [['Num', 'u8'], ['WearHelmet', 'u8']],
  29: [['Num', 'u8'], ['AimAngle', 'u8'], ['AimDistance', 'u8']],
  30: [['PingTicks', 'u8'], ['PingNum', 'u8']],
  32: [['Style', 'u8'], ['Who', 'u8']],
  33: [['Thing', 'b68'], ['Timeout', 'i16']],
  35: heartbeat(16),
  36: heartbeat(8),
  37: [['Num', 'u8'], ['IdleRandom', 'i16']],
  40: [],
  41: [['Num', 'u8'], ['Pos', 'b8'], ['Vel', 'b8'], ['Health', 'f32'], ['AimAngle', 'u8'], ['Position', 'u8'], ['Keys16', 'u16'], ['ServerTicks', 'i32']],
  43: [['CameraFocus', 'u8']],
  45: [['Vote', 'b46']],
  52: [['FriendlyFire', 'u8'], ['AdvanceAmount', 'u8'], ['TimeLimit', 'i32'], ['DisableMinimap', 'u8'], ['AdvancedSpectate', 'u8'], ['Radio', 'u8'],
    ['Damage', `f32[${W}]`], ['Ammo', `u8[${W}]`], ['ReloadTime', `u16[${W}]`], ['Speed', `f32[${W}]`], ['BulletStyle', `u8[${W}]`],
    ['StartUpTime', `u16[${W}]`], ['Bink', `i16[${W}]`], ['FireInterval', `u16[${W}]`], ['MovementAcc', `f32[${W}]`], ['BulletSpread', `f32[${W}]`],
    ['Recoil', `u16[${W}]`], ['Push', `f32[${W}]`], ['InheritedVelocity', `f32[${W}]`], ['ModifierHead', `f32[${W}]`],
    ['ModifierChest', `f32[${W}]`], ['ModifierLegs', `f32[${W}]`], ['WeaponActive', 'u8[14]']],
  54: [['Time', 'i32'], ['Pause', 'u8']],
  56: [],
  60: [['Pos', 'b8'], ['PlayerID', 'u8']],
  61: [['Vel', 'b8'], ['PlayerID', 'u8']],
  62: [['Weapon', 'u8'], ['Secondary', 'u8'], ['Ammo', 'u8'], ['SecAmmo', 'u8']],
  65: [['Active', 'u8'], ['Weapon', 'u8']],
  69: [['Grav', 'f32']],
  70: [['Name', 'b27'], ['Emitter', 'b8']],
  127: [],
};
// messages of any length: chat (6, and 66 in Unicode), UnAccepted (44), SpecialMessage (64)
export const VARIABLE = new Set([6, 44, 64, 66]);

// ---------------------------------------------------------------- older versions

const swap = (layout, changes) => layout.flatMap(([n, t]) => (n in changes ? changes[n] : [[n, t]]));

// Health and vest were integers up to 1.7.0, ServerVars had no hitbox modifiers, NewPlayer
// no JoinType
const L170 = {
  3: swap(L171[3], { Vest: [['Vest', 'u8']], Health: [['Health', 'i16']] }),
  41: swap(L171[41], { Health: [['Health', 'i16']] }),
  13: swap(L171[13], { Health: [['Health', 'i16']] }),
  17: swap(L171[17], { JoinType: [] }),
  52: swap(L171[52], { ModifierHead: [], ModifierChest: [], ModifierLegs: [] }),
};
const PL168 = swap(L171[16], { SurvivalClearWeapons: [] });
const PL166 = swap(PL168, { PlayerPos: [], PlayerVel: [] });
// 1.6.0 to 1.6.3: no check value, and so no ServerTicks anywhere; PlayersList had a fourth
// encrypted field (a word set as the server loads its scripts)
const PL163 = swap(PL166, { Gravity: [['Gravity', 'f32'], ['ScriptWord', 'u16']], ServerTicks: [] });
const PL150 = swap(PL163, { ServerName: [], ServerInfo: [], PredDuration: [] });
const PL142 = swap(PL150, { Gravity: [], ScriptWord: [] });
const noTicks = (layout) => swap(layout, { ServerTicks: [] });

// ServerVars before 1.6.4: ten weapon settings, not thirteen, in another order (OLD_ORDER)
const SV163 = [['FriendlyFire', 'u8'], ['AdvanceAmount', 'u8'], ['TimeLimit', 'i32'], ['DisableMinimap', 'u8'], ['AdvancedSpectate', 'u8'], ['Radio', 'u8'],
  ['Damage', `f32[${W}]`], ['Ammo', `i32[${W}]`], ['ReloadTime', `i32[${W}]`], ['Speed', `f32[${W}]`], ['BulletStyle', `u8[${W}]`],
  ['StartUpTime', `i32[${W}]`], ['Bink', `i16[${W}]`], ['FireInterval', `u8[${W}]`], ['MovementAcc', `u8[${W}]`], ['Recoil', `i32[${W}]`],
  ['WeaponActive', 'u8[14]']];
const SV142 = swap(SV163, { AdvancedSpectate: [], Radio: [], Recoil: [['Recoil', `u8[${W}]`]] });

// heartbeats before 1.6.4: kills, deaths, the team scores, teams and (from 1.5) caps
const oldHeartbeat = (n, caps) => [['MapID', 'u32'], ['Kills', `u16[${n}]`], ['Deaths', `u16[${n}]`], ['TeamScore', 'u16[4]'],
  ['Team', `u8[${n}]`], ...(caps ? [['Caps', `u8[${n}]`]] : [])];

// ---------------------------------------------------------------- the weapons

// Where each weapon's settings are in ServerVars: 1.7.1's order is Eagle, MP5, AK-74, Steyr,
// Spas, Ruger, M79, Barrett, Minimi, Minigun, Socom, Knife, Chainsaw, LAW, Flamed Arrows,
// Bow, Flamer, M2, Punch, Grenade. For each older place, its place in 1.7.1's (1-based).
export const ORDER = {
  new: Array.from({ length: W }, (_, i) => i + 1),
  // 1.6.4 to 1.6.7: M2, Flamed Arrows, Bow, Flamer
  old16: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 18, 15, 16, 17, 19, 20],
  // up to 1.6.3: Punch, Knife, AK-74, Minimi, Ruger, MP5, Spas, M79, Grenade, Eagle, Flamer,
  // Steyr, Barrett, Minigun, Socom, Chainsaw, Bow, Flamed Arrows, LAW, M2
  old14: [19, 12, 3, 9, 6, 2, 5, 7, 20, 1, 17, 4, 8, 10, 11, 13, 16, 15, 14, 18],
};
// Weapon numbers (snapshots, bullets): before 1.6.8 knife, chainsaw and LAW were 14 to 16,
// flamer, bow and flamed arrows 11 to 13; 1.6.8 swapped them
export const OLD_WEAPON_NUM = (n) => (n >= 11 && n <= 13 ? n + 3 : n >= 14 && n <= 16 ? n - 3 : n);
// a weapon (1.7.1's numbers) for each bullet style: what a bullet was before 1.6.4 carried
export const STYLE_WEAPON = { 1: 1, 2: 50, 3: 5, 4: 7, 5: 14, 6: 255, 7: 15, 8: 16, 9: 51, 10: 52, 11: 11, 12: 13, 13: 53, 14: 30 };
export const WEAPON_STYLE = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 3, 6: 1, 7: 4, 8: 1, 9: 1, 10: 1, 11: 11, 12: 11, 13: 12, 14: 5, 15: 7, 16: 8, 30: 14, 255: 6, 50: 2, 51: 9, 52: 10, 53: 13 };
// the settings ServerVars has had since 1.6.4, as 1.6.4 sent them by default (1.7.1's order):
// what the older versions had built in
export const DEFAULT_SPREAD = [0.15, 0.15, 0.1, 0.05, 0.8, 0, 0, 0, 0.05, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
export const DEFAULT_PUSH = [0.0168, 0.0116, 0.0124, 0.0092, 0.0196, 0.0104, 0, 0.0056, 0.0136, 0.0124, 0.02, 0, 0.0028, 0, 0, 0.0148, 0, 0.0088, 0.04, 0];
export const DEFAULT_INHERITED = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0, 0.5, 0.5, 0.5, 0.5, 0, 0, 1];
// the hitbox modifiers the game had built in up to 1.7.0
export const MODIFIER = { head: 1.15, chest: 1, legs: 0.9 };
// MovementAcc: the servers divide weapons.ini's value by 200 since 1.6.6; before, they sent it
// as it was
export const MOVEMENT_ACC_SCALE = 200;
export const DEFAULT_GRAVITY = 0.06;

// ---------------------------------------------------------------- the formats

// A format: how one or more versions sent their messages. msgs: the version's message ID ->
// { to: 1.7.1's ID, layout: the version's (1.7.1's if left out) }, or a message 1.7.1 has no
// use for: null (legacy.js knows its size) or { drop: its size }. Messages left out are
// unknown to it.
function format(key, name, hashed, base, changes, extra = {}) {
  const msgs = new Map(base ? base.msgs : Object.keys(L171).map((id) => [+id, { to: +id }]));
  if (!base) for (const id of VARIABLE) msgs.set(id, { to: id });
  for (const [id, m] of Object.entries(changes)) {
    if (m === undefined) msgs.delete(+id);
    else msgs.set(+id, m && (m.drop !== undefined ? m : { ...m, to: m.to ?? +id }));
  }
  return { key, name, hashed, msgs, weapons: 'new', bulletStyle: false, encrypted: ['MapID', 'GameStyle', 'Gravity'], cipher: CIPHER_160, ...(base && pick(base)), ...extra };
}
const pick = (f) => ({ weapons: f.weapons, bulletStyle: f.bulletStyle, encrypted: f.encrypted, cipher: f.cipher });

// The session key of PlayersList's encrypted fields: a prefix and the session id plus a number
// (the hash RIPEMD-160, the cipher Blowfish) from 1.5 on. Before, the servers hashed with SHA-1
// and encrypted with RC4 (1.4) or CAST-128 (1.2, 1.3), keyed 's' + the session id plus
// $80600 (1.2.1), $92600 (1.3.1), $97800 (1.4.0), $A6000 (1.4.1) or $A5A00 (1.4.2). Those are
// left out here (null): the 1.4 games wrote the list to their demos in clear, and the lists of
// the 1.2 and 1.3 intro demos did not decrypt so (legacy.js guesses their game mode): they
// were recorded with 1.2.0 and 1.3.0, whose keys are not known (no server of theirs).
const CIPHER_160 = ['\xA7', 0x25B3B1];
const CIPHER_150 = ['\xA7', 0xB37B1];

const F171 = format('1.7.1', 'Soldat 1.7.1', true, null, {});
// 1.7.1 beta 1: 1.7.0's ServerVars, without the hitbox modifiers
const F171b1 = format('1.7.1b1', 'Soldat 1.7.1 beta 1', true, F171, { 52: { layout: L170[52] } });
const F170 = format('1.7.0', 'Soldat 1.6.9–1.7.0', true, F171, {
  3: { layout: L170[3] }, 41: { layout: L170[41] }, 13: { layout: L170[13] }, 17: { layout: L170[17] }, 52: { layout: L170[52] },
});
const F168 = format('1.6.8', 'Soldat 1.6.8', true, F170, { 16: { layout: PL168 } });
// 1.6.8 beta 1: ForcePosition and ForceVelocity without their player (left out), no VoteOff
const F168b1 = format('1.6.8b1', 'Soldat 1.6.8 beta 1', true, F168, { 56: undefined, 60: { drop: 11 }, 61: { drop: 11 } });
// 1.6.7: the IDs from 60 on before 1.6.8 added ForceVelocity (61) and VoteOff (56); its
// ForcePosition has no player (it moved the player it was sent to): left out
const renumbered = { 56: undefined, 60: null, 61: { to: 62 }, 62: undefined, 63: { to: 64, special: 'noLayer' }, 64: { to: 65 }, 65: { to: 66 }, 66: undefined, 68: { to: 69 }, 69: { to: 70 }, 70: undefined };
const F167 = format('1.6.7', 'Soldat 1.6.7', true, F168, renumbered, { weapons: 'old16' });
// 1.6.7 beta 1: 1.6.6's PlayersList
const F167b1 = format('1.6.7b1', 'Soldat 1.6.7 beta 1', true, F167, { 16: { layout: PL166 } });
const F166 = format('1.6.6', 'Soldat 1.6.6', true, F167, {
  16: { layout: PL166 }, 41: { layout: swap(L170[41], { Keys16: [['Keys16', 'u8']] }) }, 71: null,
});
const SV164 = swap(L170[52], { MovementAcc: [['MovementAcc', `u8[${W}]`]] });
const F164 = format('1.6.4', 'Soldat 1.6.4–1.6.5', true, F166, { 52: { layout: SV164 } });
// 1.6.4's betas: bullets without Forced. Up to beta 4, ServerVars without InheritedVelocity
// and 23 weapons (three of the game's own after the 20, left out), and a copy of the bullet
// (66) sent to some players (left out)
const noForced = swap(L171[5], { Forced: [] });
const F164rc1 = format('1.6.4rc1', 'Soldat 1.6.4 RC1', true, F164, { 5: { layout: noForced } });
const F164b = format('1.6.4b', 'Soldat 1.6.4 beta 2–4', true, F164rc1, {
  52: { layout: SV164.filter(([n]) => n !== 'InheritedVelocity').map(([n, t]) => [n, t.replace(`[${W}]`, '[23]')]) },
  66: { drop: 23 },
});
// 1.6.0 to 1.6.3: no check value; bullets carried their style, not their weapon
const unhashed = {
  2: { layout: oldHeartbeat(32, true) }, 35: { layout: oldHeartbeat(16, true) }, 36: { layout: oldHeartbeat(8, true) },
  3: { layout: noTicks(L170[3]) }, 41: { layout: noTicks(F166.msgs.get(41).layout) }, 21: { layout: noTicks(L171[21]) },
  5: { layout: [['Owner', 'u8'], ['Style', 'u8'], ['Pos', 'b8'], ['Vel', 'b8'], ['Seed', 'u16']] },
  16: { layout: PL163 }, 37: { layout: [['Num', 'u8'], ['IdleRandom', 'i8']] }, 52: { layout: SV163 },
  60: null, 61: { to: 62 }, 63: null, 64: { to: 65 }, 65: undefined, 68: { to: 69 }, 69: { to: 70 }, 71: undefined,
  44: null, 127: undefined,
};
const F160 = format('1.6.0', 'Soldat 1.6.0–1.6.3', false, F164, unhashed,
  { weapons: 'old14', bulletStyle: true, encrypted: ['MapID', 'GameStyle', 'Gravity', 'ScriptWord'] });
// 1.5.1's beta (20e, 21f): NewPlayer had a byte and a short string (25 characters) before
// the position
const F151 = format('1.5.1', 'Soldat 1.5.1 beta', false, F160, {
  17: { layout: swap(L170[17], { Pos: [['Flag', 'u8'], ['Text', 'b26'], ['Pos', 'b8']] }) },
});
// 1.5: bullets without a seed, PlayersList without the server's name and info
const F150 = format('1.5.0', 'Soldat 1.5', false, F160, {
  5: { layout: [['Owner', 'u8'], ['Style', 'u8'], ['Pos', 'b8'], ['Vel', 'b8']] }, 16: { layout: PL150 },
}, { cipher: CIPHER_150 });
// 1.4.2: no gravity (nor its word) in PlayersList, heartbeats without caps, deaths without
// the body's constraints, three settings less in ServerVars, ForceWeapon without the
// secondary's ammo
const F142 = format('1.4.2', 'Soldat 1.4.0 or 1.4.2', false, F150, {
  16: { layout: PL142 }, 52: { layout: SV142 },
  2: { layout: oldHeartbeat(32, false) }, 35: { layout: oldHeartbeat(16, false) }, 36: { layout: oldHeartbeat(8, false) },
  13: { layout: swap(L170[13], { Constraints: [] }) }, 61: { to: 62, layout: [['Weapon', 'u8'], ['Secondary', 'u8'], ['Ammo', 'u8']] },
  67: null, 68: undefined, 69: undefined,
}, { encrypted: ['MapID', 'GameStyle'], cipher: null });
// 1.4.1: snapshots without the velocity
const noVel = (layout) => swap(layout, { Vel: [] });
const F141 = format('1.4.1', 'Soldat 1.4.1', false, F142, {
  3: { layout: noVel(F142.msgs.get(3).layout) }, 41: { layout: noVel(F142.msgs.get(41).layout) },
});
// 1.3.0 and 1.3.1: the weapons the menu offers in PlayersList, not in ServerVars, which had
// neither the minimap's switch nor recoil (1.3.0's demos fit 1.3.1's server: it has none of
// its own)
const F131 = format('1.3.1', 'Soldat 1.3.0 or 1.3.1', false, F142, {
  16: { layout: [...PL142, ['WeaponActive', 'b14']] },
  52: { layout: swap(SV142, { DisableMinimap: [], Recoil: [], WeaponActive: [] }) },
});
// 1.2.0 and 1.2.1: deaths without the shot's distance, life and ricochet; no ServerVars (the
// game's own weapons), VoteOn of another layout (1.2.0's demos fit 1.2.1's server). Demos came
// with 1.2.0: no older version recorded any.
const F121 = format('1.2.1', 'Soldat 1.2.0 or 1.2.1', false, F131, {
  13: { layout: swap(F142.msgs.get(13).layout, { ShotDistance: [], ShotLife: [], Ricochet: [] }) }, 52: undefined, 45: null,
});

// newest first (a beta after its release, which wins a tie)
export const FORMATS = [F171, F171b1, F170, F168, F168b1, F167, F167b1, F166, F164, F164rc1, F164b, F160, F151, F150, F142, F141, F131, F121];
export const FORMAT = Object.fromEntries(FORMATS.map((f) => [f.key, f]));
