/* setjmp shim for building FreeType to wasm without exception handling.
   FreeType only longjmps on corrupt font data (validators); the gray rasterizer
   is patched to use an overflow flag instead. A longjmp therefore traps. */
#ifndef SOLDAT_WASM_SETJMP_SHIM
#define SOLDAT_WASM_SETJMP_SHIM
typedef int jmp_buf[1];
#define setjmp(b) 0
#define longjmp(b, v) __builtin_trap()
#endif
