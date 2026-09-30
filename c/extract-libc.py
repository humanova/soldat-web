#!/usr/bin/env python3
"""Extract the minimal set of wasi-libc archive members needed by our C objects, since
Free Pascal's internal wasm linker only accepts object files (no archive search)."""
import subprocess, sys, os, re
LLVM = os.environ.get('LLVM', '/opt/homebrew/opt/llvm/bin')
SYSROOT = os.environ.get('WASI_SYSROOT', '/opt/homebrew/opt/wasi-libc/share/wasi-sysroot')
LIBC = os.path.join(SYSROOT, 'lib/wasm32-wasip1/libc.a')
objdir, outdir = sys.argv[1], sys.argv[2]
# symbols supplied by the Pascal side (cmem unit) or ignored
provided = {'malloc', 'free', 'calloc', 'realloc', 'aligned_alloc', 'posix_memalign', 'malloc_usable_size'}
def nm(path):
    out = subprocess.run([LLVM + '/llvm-nm', '-A', path], capture_output=True, text=True).stdout
    res = []
    for line in out.splitlines():
        m = re.match(r'(.*?):\s+(?:[0-9a-f]+\s+)?([A-Za-z])\s+(\S+)$', line)
        if m: res.append((m.group(1), m.group(2), m.group(3)))
    return res
defs, undefs = set(), set()
for f in os.listdir(objdir):
    if f.endswith('.o'):
        for _, t, s in nm(os.path.join(objdir, f)):
            (undefs if t == 'U' else defs).add(s) if t in 'UTDBRVW' or t == 'U' else None
member_defs, member_undefs = {}, {}
for path, t, s in nm(LIBC):
    member = path.split(':')[-1].strip('[]()')
    m = re.search(r'\(([^)]+)\)$', path)
    member = m.group(1) if m else path.split(':')[-1]
    if t == 'U': member_undefs.setdefault(member, set()).add(s)
    elif t in 'TDBRVW': member_defs.setdefault(s, member)
need = set(u for u in undefs if u not in defs and u not in provided)
chosen, unresolved = set(), set()
while need:
    s = need.pop()
    if s in defs or s in provided: continue
    mem = member_defs.get(s)
    if mem is None:
        unresolved.add(s); continue
    if mem in chosen: continue
    chosen.add(mem)
    for d, m2 in member_defs.items():
        if m2 == mem: defs.add(d)
    for u in member_undefs.get(mem, ()):
        if u not in defs and u not in provided: need.add(u)
os.makedirs(outdir, exist_ok=True)
for f in os.listdir(outdir):
    if f.endswith('.o') or f.endswith('.obj'):
        os.remove(os.path.join(outdir, f))
for mem in sorted(chosen):
    subprocess.run([LLVM + '/llvm-ar', 'x', '--output', outdir, LIBC, mem], check=True)
    # prefix: member names like memchr.o could clash with Pascal unit objects
    base = re.sub(r'(\.c)?\.obj$', '', mem)
    base = base[:-2] if base.endswith('.o') else base
    os.replace(os.path.join(outdir, mem), os.path.join(outdir, 'libc_' + base + '.o'))
print('members:', ' '.join(sorted(chosen)))
print('unresolved (expected WASI imports / Pascal-provided):', ' '.join(sorted(unresolved)))
