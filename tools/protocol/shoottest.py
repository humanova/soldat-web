# Shooter + spectator: checks whether the server accepts and relays a client bullet.
import socket, struct, sys, random, zlib, time
from dcp import DCPBlowfish, key_for_session
HOST = sys.argv[1]; PORT = int(sys.argv[2])
WEAPON = int(sys.argv[3]) if len(sys.argv) > 3 else 3
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
SIZES = {2: 303, 3: 41, 5: 24, 7: 6, 8: 22, 9: 71, 12: 7, 13: 280, 16: 2150, 17: 61, 18: 3, 19: 5,
         21: 27, 25: 7, 26: 5, 29: 6, 30: 5, 32: 5, 33: 73, 35: 159, 36: 87, 37: 6, 40: 3, 41: 32,
         45: 49, 52: 986, 54: 8, 56: 3, 60: 12, 61: 12, 62: 7, 65: 5, 69: 7, 70: 38, 127: 3}

class Client:
    def __init__(self, name, team):
        self.name = name.encode(); self.team = team; self.hw = make_hwid()
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); self.s.setblocking(False)
        self.cip = None; self.num = None; self.pos = None; self.ticks0 = None; self.t0 = None
        self.bullets = {}
    def send(self, b): self.s.sendto(fin(b), (HOST, PORT))
    def request_game(self):
        b = bytearray(46); b[0] = 14; b[4:9] = b'1.7.1'; b[9:9+len(self.name)] = self.name
        b[33] = 11; b[34:45] = self.hw.encode(); self.send(b)
    def enc(self, fields, b):
        self.cip.reset()
        for off, n in fields: b[off:off+n] = self.cip.encrypt(bytes(b[off:off+n]))
        self.cip.reset()
    def player_info(self):
        b = bytearray(65); b[0] = 15; b[3:3+len(self.name)] = self.name
        struct.pack_into('<I', b, 27, 0x25b400); b[31] = 0; b[32] = self.team
        struct.pack_into('<5I', b, 33, 0xFFFF0000, 0xFF0000FF, 0xFFE0B090, 0xFF303030, 0xFFFFFF00)
        b[53] = 11; b[54:65] = self.hw.encode()
        self.enc([(33,4),(37,4),(41,4),(45,4),(49,4),(32,1),(31,1),(27,4),(53,12)], b); self.send(b)
    def ticks(self): return self.ticks0 + int((time.time() - self.t0) * 60)
    def poll(self):
        while True:
            try: raw, _ = self.s.recvfrom(65536)
            except BlockingIOError: return
            data = zlib.decompress(raw[1:]) if raw[0] == 0xFF else raw
            p = 0
            while p < len(data):
                mid = data[p]; n = SIZES.get(mid, len(data) - p); d = data[p:p+n]; p += n
                if mid == 16:
                    sid = struct.unpack_from('<H', d, 2134)[0]; self.cip = DCPBlowfish(key_for_session(sid))
                    self.ticks0 = struct.unpack_from('<i', d, 2145)[0]; self.t0 = time.time()
                    self.player_info()
                elif mid == 17:
                    nm = d[7:31].split(b'\0')[0]
                    if nm == self.name: self.num = d[3]
                elif mid == 30: self.send(bytes([31, 0, 0, d[4]]))
                elif mid in (3, 41) and d[3] == self.num:
                    self.pos = struct.unpack_from('<2f', d, 4)
                elif mid == 5:
                    self.bullets[d[3]] = self.bullets.get(d[3], 0) + 1

shooter = Client('Shooter', 1); spec = Client('Spec', 5)
shooter.request_game(); spec.request_game()
t_end = time.time() + 12; fired = 0; last = 0; lastcam = 0; lastc = 0
while time.time() < t_end:
    shooter.poll(); spec.poll()
    now = time.time()
    if spec.cip and spec.num and shooter.num and now - lastcam > 0.5:
        lastcam = now
        b = bytearray([43, 0, 0, shooter.num]); spec.enc([(3, 1)], b); spec.send(b)
    if shooter.cip and shooter.num and shooter.pos and now - lastc > 1.0:
        lastc = now   # current weapon: AK-74, ammo 30
        b = bytearray([4, 0, 0, 30, 12, WEAPON, 11, 1]); shooter.enc([(3,1),(4,1),(5,1),(6,1),(7,1)], b); shooter.send(b)
    if shooter.cip and shooter.pos and lastc and now - last > 0.3 and fired < 20:
        last = now; fired += 1
        x, y = shooter.pos
        b = bytearray(26); b[0] = 5; b[3] = WEAPON
        struct.pack_into('<4f', b, 4, x + 6, y - 10, 12.0, 0.0)
        struct.pack_into('<H', b, 20, random.randrange(65536)); struct.pack_into('<i', b, 22, shooter.ticks())
        shooter.enc([(3,1),(4,4),(12,4),(20,2)], b); shooter.send(b)
    time.sleep(0.01)
print('shooter slot', shooter.num, 'pos', shooter.pos, 'fired', fired)
print('spectator saw bullets by owner:', spec.bullets)
