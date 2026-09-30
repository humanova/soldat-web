/* Minimal compiler-rt builtins needed by wasi-libc / C libs when no libclang_rt for wasm32 is available. */
typedef int ti_int __attribute__((mode(TI)));
typedef unsigned tu_int __attribute__((mode(TI)));
typedef unsigned long long du_int;
typedef long long di_int;
static tu_int mul_ddu(du_int a, du_int b) {
  const int bits = 32; const du_int lower = 0xFFFFFFFFull;
  du_int t, rlow, rhigh;
  rlow = (a & lower) * (b & lower);
  t = rlow >> bits; rlow &= lower;
  t += (a >> bits) * (b & lower);
  rlow += (t & lower) << bits;
  rhigh = t >> bits;
  t = rlow >> bits; rlow &= lower;
  t += (b >> bits) * (a & lower);
  rlow += (t & lower) << bits;
  rhigh += t >> bits;
  rhigh += (a >> bits) * (b >> bits);
  return ((tu_int)rhigh << 64) | rlow;
}
ti_int __multi3(ti_int a, ti_int b) {
  du_int al = (du_int)a, ah = (du_int)((tu_int)a >> 64);
  du_int bl = (du_int)b, bh = (du_int)((tu_int)b >> 64);
  tu_int r = mul_ddu(al, bl);
  du_int rh = (du_int)(r >> 64) + ah * bl + al * bh;
  return (ti_int)(((tu_int)rh << 64) | (du_int)r);
}

/* FreeType reads FREETYPE_PROPERTIES from the environment; there is none in the browser. */
char *getenv(const char *name) { (void)name; return 0; }

/* Standalone strtol (musl's version drags in stdio/TLS machinery via its FILE-based scanner). */
long strtol(const char *s, char **end, int base) {
  const char *p = s; long v = 0; int neg = 0, any = 0;
  while (*p == ' ' || (*p >= '\t' && *p <= '\r')) p++;
  if (*p == '+' || *p == '-') { neg = (*p == '-'); p++; }
  if ((base == 0 || base == 16) && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) { p += 2; base = 16; }
  else if (base == 0 && p[0] == '0') base = 8;
  else if (base == 0) base = 10;
  for (;; p++) {
    int d;
    if (*p >= '0' && *p <= '9') d = *p - '0';
    else if (*p >= 'a' && *p <= 'z') d = *p - 'a' + 10;
    else if (*p >= 'A' && *p <= 'Z') d = *p - 'A' + 10;
    else break;
    if (d >= base) break;
    v = v * base + d; any = 1;
  }
  if (end) *end = (char *)(any ? p : s);
  return neg ? -v : v;
}
