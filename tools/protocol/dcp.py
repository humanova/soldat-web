# Emulation of DCPcrypt TDCP_blowfish + InitStr(key, TDCP_ripemd160), CBC mode with DCPcrypt partial-block semantics.
try:
    from Crypto.Cipher import Blowfish
    from Crypto.Hash import RIPEMD160
except ImportError:
    from Cryptodome.Cipher import Blowfish
    from Cryptodome.Hash import RIPEMD160
class DCPBlowfish:
    def __init__(self, keystr: bytes, dcp1compat=False):
        d = RIPEMD160.new(keystr).digest()  # 20 bytes = 160 bits; blowfish max key 448 bits -> use full digest
        self.ecb = Blowfish.new(d, Blowfish.MODE_ECB)
        iv = (b'\xff' if dcp1compat else b'\x00') * 8
        self.iv = self.ecb.encrypt(iv)
        self.reset()
    def reset(self): self.cv = self.iv
    def _x(self, a, b): return bytes(x ^ y for x, y in zip(a, b))
    def encrypt(self, data: bytes) -> bytes:
        out = bytearray()
        n = len(data) // 8
        for i in range(n):
            blk = self.ecb.encrypt(self._x(data[i*8:i*8+8], self.cv))
            self.cv = blk; out += blk
        r = len(data) % 8
        if r:
            self.cv = self.ecb.encrypt(self.cv)
            out += self._x(data[n*8:], self.cv[:r])
        return bytes(out)
    def decrypt(self, data: bytes) -> bytes:
        out = bytearray()
        n = len(data) // 8
        for i in range(n):
            c = data[i*8:i*8+8]
            out += self._x(self.ecb.decrypt(c), self.cv); self.cv = c
        r = len(data) % 8
        if r:
            self.cv = self.ecb.encrypt(self.cv)
            out += self._x(data[n*8:], self.cv[:r])
        return bytes(out)
def key_for_session(sid): return b'\xa7' + str(sid + 0x25b3b1).encode()
