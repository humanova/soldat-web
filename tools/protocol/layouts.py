# Message layouts of a Soldat dedicated server (Linux, i386, Free Pascal: 2.7.4 on, Soldat
# 1.6.4 on), read from its code: how docs/DEMOS.md compares the versions. kylix.py reads the
# older ones. Needs: pip install capstone pyelftools
#
#   python3 layouts.py sizes soldatserver            every message it builds: id, size, function
#   python3 layouts.py fields soldatserver FN ID SIZE   what that function writes where
#   python3 layouts.py diff old/soldatserver new/soldatserver
#
# A server builds a message on its stack: the ID byte at the record's start, then fields,
# then the check value (bytes 1..2) by a call with the record's address and size. That
# function (djb2, 5381) is the one called most often so.
import re, sys
from collections import Counter, defaultdict
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from elftools.elf.elffile import ELFFile

STACK = re.compile(r'\[(ebp|esp)(?: \+ [a-z]{3}(?:\*\d)?)?(?: ([+-]) (0x[0-9a-f]+|\d+))?\]')
BYTE_STORE = re.compile(r'^byte ptr \[(ebp|esp)(?: ([+-]) (0x[0-9a-f]+|\d+))?\], (0x[0-9a-f]+|\d+)$')
LEA = re.compile(r'^(e[a-d]x|esi|edi), \[(ebp|esp)(?: ([+-]) (0x[0-9a-f]+|\d+))?\]$')
IMM = re.compile(r'^(e[a-d]x|esi|edi), (0x[0-9a-f]+|\d+)$')
WIDTH = {'byte': 1, 'word': 2, 'dword': 4, 'qword': 8}


def disp(sign, v):
    if v is None:
        return 0
    return -int(v, 0) if sign == '-' else int(v, 0)


class Binary:
    def __init__(self, path):
        with open(path, 'rb') as f:
            text = ELFFile(f).get_section_by_name('.text')
            self.base, self.code = text['sh_addr'], text.data()
        self.md = Cs(CS_ARCH_X86, CS_MODE_32)
        self.md.skipdata = True
        # functions: every direct call target starts one, and so does each FPC prologue
        starts = set()
        for ins in self.md.disasm(self.code, self.base):
            if ins.mnemonic == 'call' and ins.op_str.startswith('0x'):
                t = int(ins.op_str, 16)
                if self.base <= t < self.base + len(self.code):
                    starts.add(t)
        c = self.code
        for i in range(1, len(c) - 3):
            if c[i] == 0x55 and c[i + 1] == 0x89 and c[i + 2] == 0xE5 and c[i - 1] in (0x00, 0x90, 0xC3, 0xC2, 0x8D):
                starts.add(self.base + i)
        self.starts = sorted(starts)

    def function(self, addr):
        k = self.starts.index(addr)
        end = self.starts[k + 1] if k + 1 < len(self.starts) else self.base + len(self.code)
        return list(self.md.disasm(self.code[addr - self.base:end - self.base], addr))

    # (function, call address, callee, id, size) for each call with a stack record and its size
    def builds(self):
        out = []
        for s in self.starts:
            regs, stores = {}, {}
            for ins in self.function(s):
                op = ins.op_str
                if ins.mnemonic == 'mov':
                    m = BYTE_STORE.match(op)
                    if m:
                        stores[(m.group(1), disp(m.group(2), m.group(3)))] = int(m.group(4), 0) & 0xFF
                        continue
                    m = IMM.match(op)
                    if m:
                        regs[m.group(1)] = ('imm', int(m.group(2), 0))
                        continue
                    regs.pop(op.split(',')[0], None)
                elif ins.mnemonic == 'lea':
                    m = LEA.match(op)
                    if m:
                        regs[m.group(1)] = ('stk', m.group(2), disp(m.group(3), m.group(4)))
                    else:
                        regs.pop(op.split(',')[0], None)
                elif ins.mnemonic == 'call':
                    # register calling convention: the record in eax, its size in edx
                    a, d = regs.get('eax'), regs.get('edx')
                    if op.startswith('0x') and a and d and a[0] == 'stk' and d[0] == 'imm' and 3 <= d[1] <= 4096:
                        mid = stores.get((a[1], a[2]))
                        if mid is not None:
                            out.append((s, ins.address, int(op, 16), mid, d[1]))
                    regs = {}
                elif ins.mnemonic not in ('cmp', 'test', 'push', 'jmp', 'ret'):
                    regs.pop(op.split(',')[0], None)
        return out

    def messages(self):
        found = self.builds()
        hash_fn = Counter(f[2] for f in found).most_common(1)[0][0]
        by_id = defaultdict(list)
        for fn, _, callee, mid, size in found:
            if callee == hash_fn:
                by_id[mid].append((fn, size))
        return hash_fn, by_id

    # [(offset in the message, width or None, instruction)] that the function writes
    def fields(self, fn, mid, size):
        ins = self.function(fn)
        rec = None
        for i in ins:
            m = BYTE_STORE.match(i.op_str) if i.mnemonic == 'mov' else None
            if m and int(m.group(4), 0) == mid:
                rec = (m.group(1), disp(m.group(2), m.group(3)))
                break
        if rec is None:
            return []
        out = []
        for i in ins:
            for m in STACK.finditer(i.op_str):
                o = disp(m.group(2), m.group(3)) - rec[1]
                if m.group(1) == rec[0] and 0 <= o < size and i.mnemonic not in ('cmp', 'test', 'movzx'):
                    w = next((WIDTH[k] for k in WIDTH if i.op_str.startswith(k + ' ptr')), None)
                    out.append((o, w, '%x: %s %s' % (i.address, i.mnemonic, i.op_str)))
        return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'sizes':
        b = Binary(sys.argv[2])
        hash_fn, by_id = b.messages()
        print('check value function: %x' % hash_fn)
        for mid in sorted(by_id):
            print('%3d  %s' % (mid, ', '.join('%d (%x)' % (s, fn) for fn, s in sorted(set(by_id[mid]), key=lambda x: x[1]))))
    elif cmd == 'fields':
        b = Binary(sys.argv[2])
        for o, w, text in b.fields(int(sys.argv[3], 16), int(sys.argv[4]), int(sys.argv[5])):
            print('+%-5d %-2s %s' % (o, w or '', text))
    elif cmd == 'diff':
        a, b = Binary(sys.argv[2]), Binary(sys.argv[3])
        (_, ma), (_, mb) = a.messages(), b.messages()
        for mid in sorted(set(ma) | set(mb)):
            if mid not in ma or mid not in mb:
                print('%3d  only in %s' % (mid, sys.argv[2] if mid in ma else sys.argv[3]))
                continue
            (fa, sa), (fb, sb) = ma[mid][0], mb[mid][0]
            oa = sorted({o for o, _, _ in a.fields(fa, mid, sa) if o > 2})
            ob = sorted({o for o, _, _ in b.fields(fb, mid, sb) if o > 2})
            same = sa == sb and oa == ob
            print('%3d  %4d %4d  %s' % (mid, sa, sb, 'same' if same else 'DIFFERENT'))
            if not same:
                print('       %s\n       %s' % (oa, ob))
    else:
        print(__doc__ if __doc__ else open(__file__).read().split('\nimport')[0])
        sys.exit(2)


if __name__ == '__main__':
    main()
