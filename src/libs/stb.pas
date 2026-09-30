{*******************************************************}
{                                                       }
{       stb Unit for SOLDAT                             }
{                                                       }
{       Copyright (c) 2015 Mariano Cuatrin              }
{                                                       }
{*******************************************************}

unit stb;

interface

type
  PPInteger = ^PInteger;

// stb_image
function stbi_xload_file(filename: PAnsiChar; w, h, f: PInteger; delays: PPInteger): PByte;

function stbi_xload_mem(buffer: PByte; len: Integer; w, h, f: PInteger; delays: PPInteger): PByte; cdecl; external;

function stbi_load(filename: PAnsiChar; w, h, c: PInteger; req_comp: Integer): PByte;

procedure stbi_image_free(data: Pointer); cdecl; external;

function stbi_load_from_memory(buffer: Pointer; len: Integer; w, h, c: PInteger; req_comp: Integer): PByte; cdecl; external;


// stb_image_write
function stbi_write_png(filename: PAnsiChar; w, h, comp: Integer; data: Pointer; stride: Integer): Integer;

function stbi_write_bmp(filename: PAnsiChar; w, h, comp: Integer; data: Pointer): Integer;

function stbi_write_tga(filename: PAnsiChar; w, h, comp: Integer; data: Pointer): Integer;

function stbi_write_hdr(filename: PAnsiChar; w, h, comp: Integer; data: Pointer): Integer;

function stbir_resize_uint8(in_data: PByte; in_w, in_h, in_stride: Integer;
  out_data: PByte; out_w, out_h, out_stride, num_channels: Integer): Integer; cdecl; external;

implementation

// File-based stb entry points are not available in the browser build.
function stbi_xload_file(filename: PAnsiChar; w, h, f: PInteger; delays: PPInteger): PByte;
begin Result := nil; end;
function stbi_load(filename: PAnsiChar; w, h, c: PInteger; req_comp: Integer): PByte;
begin Result := nil; end;
function stbi_write_png(filename: PAnsiChar; w, h, comp: Integer; data: Pointer; stride: Integer): Integer;
begin Result := 0; end;
function stbi_write_bmp(filename: PAnsiChar; w, h, comp: Integer; data: Pointer): Integer;
begin Result := 0; end;
function stbi_write_tga(filename: PAnsiChar; w, h, comp: Integer; data: Pointer): Integer;
begin Result := 0; end;
function stbi_write_hdr(filename: PAnsiChar; w, h, comp: Integer; data: Pointer): Integer;
begin Result := 0; end;

end.
