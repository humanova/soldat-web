/* Minimal FreeType system module for the browser build: memory allocation via the C
   allocator (routed to Free Pascal's heap) and no file I/O (fonts are opened with
   FT_New_Memory_Face). */
#include <ft2build.h>
#include FT_CONFIG_CONFIG_H
#include <freetype/internal/ftdebug.h>
#include <freetype/ftsystem.h>
#include <freetype/fterrors.h>
#include <freetype/fttypes.h>
#include <stdlib.h>

static void* ft_alloc(FT_Memory memory, long size) { (void)memory; return malloc((size_t)size); }
static void* ft_realloc(FT_Memory memory, long cur, long size, void* block) { (void)memory; (void)cur; return realloc(block, (size_t)size); }
static void ft_free(FT_Memory memory, void* block) { (void)memory; free(block); }

FT_BASE_DEF( FT_Error )
FT_Stream_Open( FT_Stream stream, const char* filepathname )
{
  (void)filepathname;
  if ( !stream ) return FT_THROW( Invalid_Stream_Handle );
  return FT_THROW( Cannot_Open_Resource );
}

FT_BASE_DEF( FT_Memory )
FT_New_Memory( void )
{
  FT_Memory memory = (FT_Memory)malloc( sizeof ( *memory ) );
  if ( memory )
  {
    memory->user    = NULL;
    memory->alloc   = ft_alloc;
    memory->realloc = ft_realloc;
    memory->free    = ft_free;
  }
  return memory;
}

FT_BASE_DEF( void )
FT_Done_Memory( FT_Memory memory )
{
  free( memory );
}
