# Decrypts a capture of 1.7.1 traffic: finds the session key in PlayersList and prints
# the client's encrypted gameplay messages.
import struct, sys, zlib
from dcp import DCPBlowfish, key_for_session
data = open(sys.argv[1], 'rb').read()
magic = struct.unpack_from('<I', data, 0)[0]
le = magic == 0xa1b2c3d4
p = 24
pkts = []
linktype = struct.unpack_from('<I', data, 20)[0]
while p + 16 <= len(data):
    ts, tu, incl, orig = struct.unpack_from('<IIII', data, p); p += 16
    frame = data[p:p+incl]; p += incl
    off = 14 if linktype == 1 else 16
    ip = frame[off:]
    ihl = (ip[0] & 15) * 4
    src = '.'.join(map(str, ip[12:16])); dst = '.'.join(map(str, ip[16:20]))
    udp = ip[ihl:]
    sport, dport = struct.unpack_from('>HH', udp, 0)
    payload = udp[8:]
    pkts.append((ts + tu / 1e6, src, sport, dst, dport, payload))
cip = None
for t, src, sport, dst, dport, pl in pkts:
    d = zlib.decompress(pl[1:]) if pl[0] == 0xFF else pl
    if sport == 23073 and d[0] == 16 and len(d) >= 2150:
        sid = struct.unpack_from('<H', d, 2134)[0]; cip = DCPBlowfish(key_for_session(sid))
        print('%.3f PlayersList session %d serverticks %d' % (t, sid, struct.unpack_from('<i', d, 2145)[0]))
    if dport == 23073 and cip:
        mid = d[0]
        if mid == 5 and len(d) == 26:
            b = bytearray(d); cip.reset()
            for off, n in [(3,1),(4,4),(12,4),(20,2)]: b[off:off+n] = cip.decrypt(bytes(b[off:off+n]))
            cip.reset()
            w = b[3]; px, py, vx, vy = struct.unpack_from('<4f', b, 4); seed = struct.unpack_from('<H', b, 20)[0]; tk = struct.unpack_from('<i', b, 22)[0]
            print('%.3f BULLET weapon=%d pos=(%.1f,%.1f) vel=(%.2f,%.2f) seed=%d ticks=%d' % (t, w, px, py, vx, vy, seed, tk))
        elif mid == 4 and len(d) == 8:
            b = bytearray(d); cip.reset()
            for off in range(3, 8): b[off:off+1] = cip.decrypt(bytes(b[off:off+1]))
            cip.reset()
            print('%.3f C ammo=%d sec=%d wep=%d secwep=%d pos=%d' % (t, b[3], b[4], b[5], b[6], b[7]))
        elif mid == 42 and len(d) == 25:
            b = bytearray(d); cip.reset()
            for off, n in [(3,4),(11,4),(19,2),(21,2),(23,2)]: b[off:off+n] = cip.decrypt(bytes(b[off:off+n]))
            cip.reset()
            px, py, vx, vy = struct.unpack_from('<4f', b, 3); keys = struct.unpack_from('<H', b, 19)[0]; ax, ay = struct.unpack_from('<hh', b, 21)
            print('%.3f MOV pos=(%.1f,%.1f) vel=(%.2f,%.2f) keys=%04x aim=(%d,%d)' % (t, px, py, vx, vy, keys, ax, ay))
        elif mid not in (31,):
            print('%.3f client msg id=%d len=%d' % (t, mid, len(d)))
