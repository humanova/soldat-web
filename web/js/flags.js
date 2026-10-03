// Country flags for the server lists (play and Soldat TV): web/flags.png holds the 4x3 flags of flag-icons
// (MIT, (c) 2013 Panayiotis Lipiridis, https://github.com/lipis/flag-icons) in 32x24 cells,
// 16 to a row, in this order.
const CODES = (
  'ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt ' +
  'bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cp cr cu cv cw cx cy cz de dg dj dk dm do dz ec ee ' +
  'eg eh er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm ' +
  'hn hr ht hu ic id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc ' +
  'li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ' +
  'ne nf ng ni nl no np nr nu nz om pa pc pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa ' +
  'sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt ' +
  'tv tw tz ua ug um un us uy uz va vc ve vg vi vn vu wf ws xk xx ye yt za zm zw'
).split(' ');
const COLS = 16;

// a 16x12 flag for a 2-letter country code, or null
export function flag(country) {
  const i = CODES.indexOf(String(country || '').toLowerCase());
  if (i < 0) return null;
  const e = document.createElement('i');
  e.className = 'cflag';
  e.style.backgroundPosition = `${-(i % COLS) * 16}px ${-Math.floor(i / COLS) * 12}px`;
  try {
    e.title = new Intl.DisplayNames(['en'], { type: 'region' }).of(country.toUpperCase());
  } catch (_) {
    e.title = country.toUpperCase();
  }
  return e;
}
