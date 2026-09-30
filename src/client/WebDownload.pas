{
  Map download for the WebAssembly build.

  Soldat 1.7.1 servers serve maps and their graphics from a TCP "file server" on
  game port + 10 (STARTFILES / path list / ENDFILES). JavaScript performs the transfer
  through the relay and stores the files in the persistent downloads directory, which
  is mounted into the PhysFS search path, so downloaded files are found like built-in ones.

  Flow: fetch maps/NAME.pms -> parse it to find textures/sceneries that are missing
  locally -> fetch those -> request the game again.
}
unit WebDownload;

{$mode delphi}

interface

procedure StartMapDownload(Host: AnsiString; Port: Word; MapName: AnsiString);
function RedownloadMap(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
function MapAssetsMissing(const MapName: AnsiString): Boolean;
function EnsureMapAssets(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
procedure UpdateMapDownload;
procedure CancelMapDownload;
function MapDownloadActive: Boolean;

implementation

uses
  SysUtils, Classes, PhysFS, Util, MapFile, GameRendering, GameStrings, Client,
  Game, Net, NetworkClientConnection;

// Starts a transfer; Files is a #10 separated list of relative paths. Returns a job id.
function js_fetch_files(Host: PAnsiChar; Port: LongInt; Files: PAnsiChar): LongInt; cdecl; external 'net' name 'fetch_files';
// 0 = pending, 1 = done, <0 = failed
function js_fetch_status(Job: LongInt): LongInt; cdecl; external 'net' name 'fetch_status';
function js_fetch_progress(Job: LongInt): LongInt; cdecl; external 'net' name 'fetch_progress';
procedure js_fetch_cancel(Job: LongInt); cdecl; external 'net' name 'fetch_cancel';

type
  TDownloadStage = (dsIdle, dsMap, dsAssets);

var
  Redownloaded: TStringList = nil;
  AssetsAttempted: TStringList = nil;
  Stage: TDownloadStage = dsIdle;
  Job: LongInt = 0;
  DLHost: AnsiString;
  DLPort: Word;
  DLMap: AnsiString;
  LastProgress: LongInt = -1;

function MapDownloadActive: Boolean;
begin
  Result := Stage <> dsIdle;
end;

procedure CancelMapDownload;
begin
  if Stage <> dsIdle then
    js_fetch_cancel(Job);
  Stage := dsIdle;
end;

procedure StartMapDownload(Host: AnsiString; Port: Word; MapName: AnsiString);
begin
  CancelMapDownload;
  DLHost := Host;
  DLPort := Port;
  DLMap := MapName;
  LastProgress := -1;
  RenderGameInfo(WideString(_('Downloading map') + ' ' + MapName + '...'));
  Job := js_fetch_files(PAnsiChar(Host), Port + 10, PAnsiChar('maps/' + MapName + '.pms'));
  Stage := dsMap;
end;

// The local copy of a map differs from the server's (heartbeat map id mismatch):
// fetch the server's version once; it takes precedence over the built-in one.
function RedownloadMap(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
begin
  Result := False;
  if Redownloaded = nil then
  begin
    Redownloaded := TStringList.Create;
    Redownloaded.CaseSensitive := False;
  end;
  if Redownloaded.IndexOf(Host + ':' + IntToStr(Port) + '/' + MapName) >= 0 then
    Exit;
  Redownloaded.Add(Host + ':' + IntToStr(Port) + '/' + MapName);
  StartMapDownload(Host, Port, MapName);
  Result := True;
end;

function ImageExists(const Path: AnsiString): Boolean;
var
  Base: AnsiString;
begin
  // the game also accepts alternative image formats for the same base name
  Base := ChangeFileExt(Path, '');
  Result := PHYSFS_exists(PChar(Path)) or PHYSFS_exists(PChar(Base + '.png')) or
    PHYSFS_exists(PChar(Base + '.bmp')) or PHYSFS_exists(PChar(Base + '.jpg')) or
    PHYSFS_exists(PChar(Base + '.gif'));
end;

function MissingAssets(const MapName: AnsiString): AnsiString;
var
  Info: TMapInfo;
  MapData: TMapFile;
  i: Integer;
  Name: AnsiString;
  List: TStringList;
begin
  Result := '';
  if not GetMapInfo(MapName, UserDirectory, Info) then
    Exit;
  MapData := Default(TMapFile);
  if not LoadMapFile(Info, MapData) then
    Exit;

  List := TStringList.Create;
  try
    List.Sorted := True;
    List.Duplicates := dupIgnore;
    for i := 0 to High(MapData.Textures) do
    begin
      Name := Trim(MapData.Textures[i]);
      if (Name <> '') and not ImageExists('textures/' + Name) then
        List.Add('textures/' + Name);
    end;
    for i := 0 to High(MapData.Scenery) do
    begin
      Name := Trim(MapData.Scenery[i].Filename);
      if (Name <> '') and not ImageExists('scenery-gfx/' + Name) then
        List.Add('scenery-gfx/' + Name);
    end;
    List.LineBreak := #10;
    Result := Trim(List.Text);
  finally
    List.Free;
  end;
end;

function MapAssetsMissing(const MapName: AnsiString): Boolean;
begin
  Result := MissingAssets(MapName) <> '';
  if Result and (AssetsAttempted <> nil) and (AssetsAttempted.IndexOf(MapName) >= 0) then
    Result := False;  // already tried: play with whatever could be found
end;

// Map textures and scenery are not part of the base archive: they come from the
// static asset mirror or the game server's file server. Returns False while they
// are being fetched (the game is requested again afterwards).
function EnsureMapAssets(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
var
  Assets: AnsiString;
begin
  Result := True;
  if not MapAssetsMissing(MapName) then
    Exit;
  Assets := MissingAssets(MapName);
  if AssetsAttempted = nil then
  begin
    AssetsAttempted := TStringList.Create;
    AssetsAttempted.CaseSensitive := False;
  end;
  AssetsAttempted.Add(MapName);

  CancelMapDownload;
  DLHost := Host;
  DLPort := Port;
  DLMap := MapName;
  LastProgress := -1;
  RenderGameInfo(WideString(_('Downloading map') + ' ' + MapName + '...'));
  Job := js_fetch_files(PAnsiChar(Host), Port + 10, PAnsiChar(Assets));
  Stage := dsAssets;
  Result := False;
end;

procedure Finish;
begin
  Stage := dsIdle;
  // rejoin; the map is now available locally
  FillCaseInsensitiveImageMap;
  Map.Filename := '';  // reload even if a map with this name is loaded
  if MySprite > 0 then
    MapRejoin := True;
  RenderGameInfo(_('Loading'));
  ClientRequestGame;
end;

procedure UpdateMapDownload;
var
  Status, Progress: LongInt;
  Assets: AnsiString;
begin
  if Stage = dsIdle then
    Exit;

  Status := js_fetch_status(Job);
  if Status = 0 then
  begin
    Progress := js_fetch_progress(Job);
    if Progress <> LastProgress then
    begin
      LastProgress := Progress;
      RenderGameInfo(WideString(Format('%s %s (%d KB)', [_('Downloading map'), DLMap,
        Progress div 1024])));
    end;
    Exit;
  end;

  if Status < 0 then
  begin
    Stage := dsIdle;
    RenderGameInfo(WideString(_('Could not download map') + ' ' + DLMap +
      '. ' + _('The server may not allow downloads.')));
    ClientDisconnect;
    Exit;
  end;

  case Stage of
    dsMap:
      begin
        if not PHYSFS_exists(PChar('maps/' + DLMap + '.pms')) then
        begin
          Stage := dsIdle;
          RenderGameInfo(WideString(_('Server did not provide map') + ' ' + DLMap));
          ClientDisconnect;
          Exit;
        end;
        Assets := MissingAssets(DLMap);
        if Assets = '' then
          Finish
        else
        begin
          if AssetsAttempted = nil then
          begin
            AssetsAttempted := TStringList.Create;
            AssetsAttempted.CaseSensitive := False;
          end;
          AssetsAttempted.Add(DLMap);
          LastProgress := -1;
          Job := js_fetch_files(PAnsiChar(DLHost), DLPort + 10, PAnsiChar(Assets));
          Stage := dsAssets;
        end;
      end;
    dsAssets:
      Finish;
  end;
end;

end.
