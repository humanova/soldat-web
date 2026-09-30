# Joins as a spectator and reports what the server broadcasts about one player:
# bullets (id 5), snapshots (3/41) and deltas (21), so the browser client's
# encrypted uploads can be checked for sane values.
import socket, struct, sys, random, zlib, time
from dcp import DCPBlowfish, key_for_session
HOST = sys.argv[1]; PORT = int(sys.argv[2]); DUR = float(sys.argv[3]); WATCH = sys.argv[4]
def phash(b):
    h = (b[0] + 0xB5A5) & 0xFFFF
    for x in b[3:]: h = (h * 33 + x) & 0xFFFF
    return h
def fin(b):
    b = bytearray(b); struct.pack_into('<H', b, 1, phash(b)); return bytes(b)
HEX = '0123456789ABCDEF'
def make_hwid():
    s = ''.join(random.choice(HEX) for _ in range(10)); h = 5381
    for c in s: h = (h * 33 + HEX.index(c)) & 0xFFFFFFFF
    return s + HEX[h & 0xF]
NAME = b'Watcher'; HW = make_hwid()
def request_game():
    b = bytearray(46); b[0] = 14; b[4:9] = b'1.7.1'; b[9:9+len(NAME)] = NAME
    b[33] = 11; b[34:45] = HW.encode(); return fin(b)
def player_info(cip, team=5, look=0):
    b = bytearray(65); b[0] = 15; b[3:3+len(NAME)] = NAME
    struct.pack_into('<I', b, 27, 0x25b400); b[31] = look; b[32] = team
    struct.pack_into('<5I', b, 33, 0xFFFF0000, 0xFF0000FF, 0xFFE0B090, 0xFF303030, 0xFFFFFF00)
    b[53] = 11; b[54:65] = HW.encode()
    cip.reset()
    for off, n in [(33,4),(37,4),(41,4),(45,4),(49,4),(32,1),(31,1),(27,4),(53,12)]:
        b[off:off+n] = cip.encrypt(bytes(b[off:off+n]))
    cip.reset()
    return fin(b)
SIZES = {2: 303, 3: 41, 5: 24, 7: 6, 8: 22, 9: 71, 12: 7, 13: 280, 16: 2150, 17: 61, 18: 3, 19: 5,
         21: 27, 25: 7, 26: 5, 29: 6, 30: 5, 32: 5, 33: 73, 35: 159, 36: 87, 37: 6, 40: 3, 41: 32,
         45: 49, 52: 986, 54: 8, 56: 3, 60: 12, 61: 12, 62: 7, 65: 5, 69: 7, 70: 38, 127: 3}
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(0.3)
s.sendto(request_game(), (HOST, PORT))
cip = None; t0 = time.time(); names = {}; target = None; bullets = 0; snaps = 0; last_cam = 0; by_owner = {}; weapons_seen = {}
while time.time() - t0 < DUR:
    if cip and target and time.time() - last_cam > 0.5:
        # spectator camera follows the watched player so the server relays its bullets
        last_cam = time.time()
        cip.reset(); cam = cip.encrypt(bytes([target])); cip.reset()
        s.sendto(fin(bytes([43, 0, 0]) + cam), (HOST, PORT))
    try: raw, _ = s.recvfrom(65536)
    except socket.timeout: continue
    data = zlib.decompress(raw[1:]) if raw[0] == 0xFF else raw
    p = 0
    while p < len(data):
        mid = data[p]; n = SIZES.get(mid, len(data) - p)
        d = data[p:p+n]; p += n
        if mid == 16:
            sid = struct.unpack_from('<H', d, 2134)[0]; cip = DCPBlowfish(key_for_session(sid))
            for i in range(32):
                nm = d[108+i*24:108+(i+1)*24].split(b'\0')[0].decode('latin1')
                if nm and nm != '0 ': names[i+1] = nm
            target = next((k for k, v in names.items() if v.startswith(WATCH)), None)
            print('players:', names, '-> watching slot', target)
            s.sendto(player_info(cip), (HOST, PORT))
        elif mid == 17:
            num = d[3]; nm = d[7:31].split(b'\0')[0].decode('latin1'); names[num] = nm
            if nm.startswith(WATCH): target = num; print('new player', num, nm)
        elif mid == 30:
            s.sendto(fin(bytes([31, 0, 0, d[4]])), (HOST, PORT))  # pong
        elif mid == 5:
            by_owner[d[3]] = by_owner.get(d[3], 0) + 1
            weapons_seen.setdefault(d[3], set()).add(d[4])
        elif mid == 6:
            print('chat from %d: %r' % (d[3], d[4:].split(b'\0')[0].decode('latin1')))
        elif mid == 66:
            t = d[4:]; t = t[:len(t) - len(t) % 2]
            txt = t.decode('utf-16-le').split('\0')[0]
            print('unicode chat from %d: %r' % (d[3], txt))
        elif mid == 45:
            print('VOTE ON type=%d who=%d target=%r' % (d[3], d[6], d[7:23].split(b'\0')[0]))
        elif mid == 13:
            print('death: num=%d killer=%d weapon/bullet=%d' % (d[3], d[4], d[5]))
        if mid == 5 and target and d[3] == target:
            bullets += 1
            if bullets <= 5:
                own, wep = d[3], d[4]; px, py, vx, vy = struct.unpack_from('<4f', d, 5); seed = struct.unpack_from('<H', d, 21)[0]
                print('bullet from %d weapon=%d pos=(%.1f,%.1f) vel=(%.2f,%.2f) seed=%d' % (own, wep, px, py, vx, vy, seed))
        elif mid in (3, 41) and target and d[3] == target:
            snaps += 1
            if snaps % 20 == 1:
                px, py, vx, vy = struct.unpack_from('<4f', d, 4)
                extra = ''
                if mid == 3:
                    extra = ' ammo=%d grenades=%d weapon=%d secweapon=%d health=%.0f vest=%.0f' % (
                        d[33], d[34], d[35], d[36], struct.unpack_from('<f', d, 29)[0], struct.unpack_from('<f', d, 25)[0])
                print('snapshot id=%d pos=(%.1f,%.1f) vel=(%.2f,%.2f)%s' % (mid, px, py, vx, vy, extra))
print('bullets seen:', bullets, 'snapshots:', snaps, 'by owner:', {names.get(k, k): v for k, v in by_owner.items()}, 'weapons:', weapons_seen)
