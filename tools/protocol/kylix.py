# Message layouts of the dedicated servers built with Kylix (Soldat 1.2.1 to 1.6.3, soldatserver
# 2.2.9 to 2.7.3), whose code layouts.py cannot follow: frames are often esp-based, ebp is a
# general register, a message's address goes to a global pointer before the send. docs/DEMOS.md
# has how the versions compare. Needs: pip install capstone pyelftools. Some of the servers are
# packed with UPX: unpack them first (upx -d -o soldatserver.unpacked soldatserver).
#
#   python3 kylix.py sizes soldatserver               the messages it sends: id, size, builder
#                                                     (a first look: it misses some, and can
#                                                     take a pushed 255 for a size)
#   python3 kylix.py fields soldatserver FN ID SIZE   what builder FN writes into message ID
#   python3 kylix.py key soldatserver                 the session key: recipe, hash and cipher
#
# The sweep tracks esp so that [esp+X] is read relative to the function's entry, follows a
# message's address through a global pointer, and counts the stack arguments a call takes from
# the callee's "ret N".
import re, sys, bisect
from collections import defaultdict
import layouts as L

MEM = re.compile(r'\[(esp|ebp)(?: \+ (e[a-z]{2})(?:\*\d)?)?(?: ([+-]) (0x[0-9a-f]+|\d+))?\]')
BSTORE = re.compile(r'^byte ptr \[(esp|ebp)(?: ([+-]) (0x[0-9a-f]+|\d+))?\], (0x[0-9a-f]+|\d+)$')
GSTORE = re.compile(r'^dword ptr \[(0x[0-9a-f]+)\], (e[a-d]x|esi|edi)$')
GLOAD = re.compile(r'^(e[a-d]x|esi|edi), dword ptr \[(0x[0-9a-f]+)\]$')
WIDTH = {'byte': 1, 'word': 2, 'dword': 4, 'qword': 8, 'xword': 10, 'tbyte': 10}


class Bin(L.Binary):
    def __init__(self, path):
        super().__init__(path)
        self._arity = {}

    def arity(self, fn):
        if fn not in self._arity:
            n = 0
            try:
                k = bisect.bisect_right(self.starts, fn) - 1
                if self.starts[k] == fn:
                    for i in self.function(fn):
                        if i.mnemonic == 'ret':
                            n = int(i.op_str, 0) // 4 if i.op_str else 0
                            break
            except Exception:
                pass
            self._arity[fn] = n
        return self._arity[fn]

    def sweep(self, fn):
        """[(ins, esp delta before it, ebp's slot if ebp points into the esp frame)]"""
        out, d, eb = [], 0, None
        for i in self.function(fn):
            out.append((i, d, eb))
            mn, op = i.mnemonic, i.op_str
            if mn == 'lea' and op.startswith('ebp, [esp'):
                m = re.match(r'^ebp, \[esp(?: ([+-]) (0x[0-9a-f]+|\d+))?\]$', op)
                eb = (L.disp(m.group(1), m.group(2)) - d) if m else None
            elif op.startswith('ebp,') and mn in ('mov', 'xor', 'add', 'sub', 'pop', 'lea'):
                eb = None
            elif mn == 'pop' and op == 'ebp':
                eb = None
            if mn == 'push': d += 4
            elif mn == 'pop': d -= 4
            elif mn == 'pushal': d += 32
            elif mn == 'popal': d -= 32
            elif mn in ('sub', 'add') and op.startswith('esp, '):
                try: v = int(op[5:], 0)
                except ValueError: continue
                v = v - (1 << 32) if v >= 1 << 31 else v
                d += v if mn == 'sub' else -v
            elif mn == 'call' and op.startswith('0x'):
                d -= 4 * self.arity(int(op, 16))
            elif mn in ('ret', 'jmp'):
                pass
        return out

    @staticmethod
    def slot(base, sign, v, d, eb=None):
        off = L.disp(sign, v)
        if base == 'esp': return ('esp', off - d)
        if eb is not None: return ('esp', eb + off)
        return ('ebp', off)

    def builds(self):
        out = []
        for s in self.starts:
            stores, regs, glob, pushes = {}, {}, {}, []
            for i, d, eb in self.sweep(s):
                op, mn = i.op_str, i.mnemonic
                if mn == 'mov':
                    m = BSTORE.match(op)
                    if m:
                        stores[self.slot(m.group(1), m.group(2), m.group(3), d, eb)] = int(m.group(4), 0) & 0xFF
                        continue
                    m = GSTORE.match(op)
                    if m and regs.get(m.group(2), ('',))[0] == 'stk':
                        glob[m.group(1)] = regs[m.group(2)]; continue
                    m = GLOAD.match(op)
                    if m and m.group(2) in glob:
                        regs[m.group(1)] = glob[m.group(2)]; continue
                    m = L.IMM.match(op)
                    if m: regs[m.group(1)] = ('imm', int(m.group(2), 0)); continue
                    regs.pop(op.split(',')[0], None)
                elif mn == 'lea':
                    m = L.LEA.match(op)
                    if m: regs[m.group(1)] = ('stk',) + self.slot(m.group(2), m.group(3), m.group(4), d, eb)
                    else: regs.pop(op.split(',')[0], None)
                elif mn == 'push':
                    if re.match(r'^(0x[0-9a-f]+|\d+)$', op): pushes.append(('imm', int(op, 0)))
                    else: pushes.append(regs.get(op))
                elif mn == 'pop':
                    if pushes: pushes.pop()
                    regs.pop(op, None)
                elif mn == 'call':
                    if op.startswith('0x'):
                        t = int(op, 16); n = self.arity(t)
                        args = [regs.get(r) for r in ('eax', 'edx', 'ecx')] + (pushes[-n:] if n else [])
                        recs = [a for a in args if a and a[0] == 'stk' and a[1:] in stores]
                        imms = [a[1] for a in args if a and a[0] == 'imm' and 2 <= a[1] <= 8192]
                        if recs and imms:
                            r = recs[0]
                            out.append((s, i.address, t, stores[r[1:]], imms[0], r[1:]))
                        if n: del pushes[-n:]
                    regs = {}
                elif mn not in ('cmp', 'test', 'jmp', 'ret') and op:
                    regs.pop(op.split(',')[0], None)
        return out

    def fields(self, fn, rec, size):
        """offsets written inside the record at slot rec (('esp'|'ebp', off)) of size bytes"""
        res = []
        for i, d, eb in self.sweep(fn):
            if i.mnemonic in ('cmp', 'test', 'movzx', 'movsx', 'lea', 'push'):
                continue
            first = i.op_str.split(',')[0]
            m = MEM.search(first)
            if not m or m.group(2):
                continue
            sl = self.slot(m.group(1), m.group(3), m.group(4), d, eb)
            if sl[0] != rec[0]:
                continue
            o = sl[1] - rec[1]
            if 0 <= o < size:
                w = next((WIDTH[k] for k in WIDTH if first.startswith(k + ' ptr')), None)
                if i.mnemonic.startswith('f') and w is None: w = 4
                res.append((o, w, '%x: %s %s' % (i.address, i.mnemonic, i.op_str)))
        return res



def fields_of(b, fn, mid, size):
    """the record whose ID byte the function stores (its first such store), and its fields"""
    for i, d, eb in b.sweep(fn):
        m = BSTORE.match(i.op_str) if i.mnemonic == 'mov' else None
        if m and int(m.group(4), 0) == mid:
            rec = b.slot(m.group(1), m.group(2), m.group(3), d, eb)
            return rec, b.fields(fn, rec, size)
    return None, []


def session_key(path):
    """after SessionID := Random(5000) + 1001: (number added, prefix, hash class, cipher class)"""
    from elftools.elf.elffile import ELFFile
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    e = ELFFile(open(path, 'rb'))
    secs = [(s['sh_addr'], s.data()) for s in e.iter_sections() if s['sh_type'] != 'SHT_NOBITS' and s['sh_addr']]

    def rd(a, n):
        for b0, d in secs:
            if b0 <= a and a + n <= b0 + len(d):
                return d[a - b0:a - b0 + n]

    def u32(a):
        b = rd(a, 4)
        return int.from_bytes(b, 'little') if b else None

    def text(a):  # a Delphi string literal (its length before it)
        n = u32(a - 4)
        return rd(a, n) if n and 0 < n < 40 else None

    def cname(vmt):  # a class's name (vmtClassName, -44)
        p = u32(vmt - 44) if vmt else None
        s = rd(p, 64) if p else None
        if s and 0 < s[0] < 60 and all(32 < c < 127 for c in s[1:1 + s[0]]):
            return s[1:1 + s[0]].decode()

    t = e.get_section_by_name('.text')
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.skipdata = True
    ins = list(md.disasm(t.data(), t['sh_addr']))
    for k, i in enumerate(ins):
        if not (i.mnemonic == 'mov' and i.op_str.endswith(', 0x1388') and any('0x3e9' in j.op_str for j in ins[k + 1:k + 5])):
            continue
        add, prefix, hashref, cipher = 0, None, None, None
        for j in ins[k + 3:k + 30]:
            m = re.match(r'^(eax|ax), (0x[0-9a-f]+)$', j.op_str)
            if m and j.mnemonic in ('add', 'sub') and prefix is None:
                v = int(m.group(2), 16)
                v = v - (1 << 32) if v >= 1 << 31 else v
                add += v if j.mnemonic == 'add' else -v
            m = re.match(r'^edx, (0x[0-9a-f]+)$', j.op_str)
            if j.mnemonic == 'mov' and m and prefix is None:
                prefix = text(int(m.group(1), 16))
            m = re.match(r'^ecx, dword ptr \[(0x[0-9a-f]+)\]$', j.op_str)
            if j.mnemonic == 'mov' and m:
                hashref = int(m.group(1), 16)
            m = re.match(r'^eax, dword ptr \[(0x[0-9a-f]+)\]$', j.op_str)
            if j.mnemonic == 'mov' and m and hashref:
                cipher = int(m.group(1), 16)
                break
        made = None  # the cipher object's class: who stores it
        for n, x in enumerate(ins):
            if cipher and x.mnemonic == 'mov' and x.op_str == 'dword ptr [0x%x], eax' % cipher:
                for y in reversed(ins[max(0, n - 8):n]):
                    m = re.match(r'^eax, dword ptr \[(0x[0-9a-f]+)\]$', y.op_str)
                    if y.mnemonic == 'mov' and m:
                        made = cname(u32(int(m.group(1), 16)))
                        if made:
                            break
                if made:
                    break
        return add & 0xFFFFFFFF, prefix, cname(u32(hashref)) if hashref else None, made


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'sizes':
        b = Bin(sys.argv[2])
        by = defaultdict(set)
        for s, a, t, mid, size, rec in b.builds():
            by[mid].add((size, s))
        for mid in sorted(by):
            print('%3d  %s' % (mid, ', '.join('%d (%x)' % x for x in sorted(by[mid]))))
    elif cmd == 'fields':
        b = Bin(sys.argv[2])
        rec, f = fields_of(b, int(sys.argv[3], 16), int(sys.argv[4]), int(sys.argv[5]))
        print('record at', rec)
        for o, w, txt in sorted(set(f)):
            print('+%-5d %-2s %s' % (o, w or '', txt))
    elif cmd == 'key':
        add, prefix, hashc, cipherc = session_key(sys.argv[2])
        print('key: %r + IntToStr(SessionID + $%X), hash %s, cipher %s' % (prefix.decode('latin1') if prefix else None, add, hashc, cipherc))
    else:
        print(open(__file__).read().split('\nimport')[0])
        sys.exit(2)


if __name__ == '__main__':
    main()
