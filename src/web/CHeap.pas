unit CHeap;
{ C allocator (malloc family) backed by FPC's memory manager, so C libraries linked into
  the wasm module share one heap with Pascal code. 16-byte aligned, size stored in header. }
{$mode objfpc}
interface
implementation
const HDR = 16;
function c_malloc(size: PtrUInt): Pointer; cdecl; public name 'malloc';
var p: PByte;
begin
  if size = 0 then size := 1;
  p := GetMem(size + HDR + 15);
  if p = nil then exit(nil);
  { align user pointer to 16 }
  Result := Pointer((PtrUInt(p) + HDR + 15) and not PtrUInt(15));
  PPointer(PByte(Result) - 8)^ := p;
  PPtrUInt(PByte(Result) - 4)^ := size;
end;
procedure c_free(ptr: Pointer); cdecl; public name 'free';
begin
  if ptr <> nil then FreeMem(PPointer(PByte(ptr) - 8)^);
end;
function c_calloc(n, size: PtrUInt): Pointer; cdecl; public name 'calloc';
begin
  Result := c_malloc(n * size);
  if Result <> nil then FillChar(Result^, n * size, 0);
end;
function c_realloc(ptr: Pointer; size: PtrUInt): Pointer; cdecl; public name 'realloc';
var old: PtrUInt;
begin
  if ptr = nil then exit(c_malloc(size));
  if size = 0 then begin c_free(ptr); exit(nil); end;
  old := PPtrUInt(PByte(ptr) - 4)^;
  Result := c_malloc(size);
  if Result <> nil then begin
    if old < size then Move(ptr^, Result^, old) else Move(ptr^, Result^, size);
    c_free(ptr);
  end;
end;
function c_aligned_alloc(align, size: PtrUInt): Pointer; cdecl; public name 'aligned_alloc';
begin Result := c_malloc(size); end;
function c_posix_memalign(out p: Pointer; align, size: PtrUInt): Integer; cdecl; public name 'posix_memalign';
begin p := c_malloc(size); if p = nil then Result := 12 else Result := 0; end;
function c_malloc_usable_size(ptr: Pointer): PtrUInt; cdecl; public name 'malloc_usable_size';
begin Result := PPtrUInt(PByte(ptr) - 4)^; end;
end.
