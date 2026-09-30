import socket, struct, sys, random, zlib, time
from dcp import DCPBlowfish, key_for_session
HOST = sys.argv[1]; PORT = int(sys.argv[2]); DUR = float(sys.argv[3]) if len(sys.argv) > 3 else 6
def phash(b):
    h = (b[0] + 0xB5A5) & 0xFFFF
    for x in b[3:]: h = (h * 33 + x) & 0xFFFF
    return h
def fin(b):
    b = bytearray(b); struct.pack_into('<H', b, 1, phash(b)); return bytes(b)
HEX = '0123456789ABCDEF'
def make_hwid():
    s = ''.join(random.choice(HEX) for _ in range(10)); h = 0x1505
    for c in s: h = (h * 33 + HEX.index(c)) & 0xFFFFFFFF
    return s + HEX[h & 0xF]
NAME = b'BrowserProbe'; HW = make_hwid()
def request_game():
    b = bytearray(46); b[0] = 14; b[4:9] = b'1.7.1'; b[9:9+len(NAME)] = NAME
    b[33] = 11; b[34:45] = HW.encode(); return fin(b)
def player_info(cip, team=1, look=0):
    b = bytearray(65); b[0] = 15; b[3:3+len(NAME)] = NAME
    struct.pack_into('<I', b, 27, 0x25b400); b[31] = look; b[32] = team
    struct.pack_into('<5I', b, 33, 0xFFFF0000, 0xFF0000FF, 0xFFE0B090, 0xFF303030, 0xFFFFFF00)
    b[53] = 11; b[54:65] = HW.encode()
    cip.reset()
    for off, n in [(33,4),(37,4),(41,4),(45,4),(49,4),(32,1),(31,1),(27,4),(53,12)]:
        b[off:off+n] = cip.encrypt(bytes(b[off:off+n]))
    cip.reset()
    return fin(b)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(0.5)
s.sendto(request_game(), (HOST, PORT))
cip = None; t0 = time.time(); counts = {}
while time.time() - t0 < DUR:
    try: raw, _ = s.recvfrom(65536)
    except socket.timeout: continue
    d = zlib.decompress(raw[1:]) if raw[0] == 0xFF else raw
    ok = struct.unpack_from('<H', d, 1)[0] == phash(d)
    mid = d[0]; counts[(mid, len(d))] = counts.get((mid, len(d)), 0) + 1
    if counts[(mid, len(d))] <= 2:
        print('%.2f id=%d len=%d ok=%s comp=%s %s' % (time.time()-t0, mid, len(d), ok, raw[0]==0xFF, d[:40].hex()))
    if mid == 16:
        sid = struct.unpack_from('<H', d, 2134)[0]; cip = DCPBlowfish(key_for_session(sid))
        s.sendto(player_info(cip), (HOST, PORT)); print('  -> sent PlayerInfo, session', sid)
print('summary', sorted(counts.items()))
