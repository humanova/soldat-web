{
  Runs first: the WebAssembly RTL has no system code page, so make UTF-8 the
  default before any other unit converts strings. cp1252 covers old data files.
}
unit WebCodePage;

interface

uses
  WebWideString, cp1252;

implementation

initialization
  DefaultSystemCodePage := CP_UTF8;
  DefaultFileSystemCodePage := CP_UTF8;
  DefaultRTLFileSystemCodePage := CP_UTF8;
end.
