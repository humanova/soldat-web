{
  Map download for the WebAssembly build.

  Soldat 1.7.1 servers serve maps and their graphics from a TCP "file server" on
  game port + 10 (STARTFILES / path list / ENDFILES). JavaScript performs the transfer
  through the relay and stores the files in the persistent downloads directory, which
  is mounted into the PhysFS search path, so downloaded files are found like built-in ones.

  Flow: fetch maps/NAME.pms -> parse it to find textures/sceneries that are missing
  locally -> fetch those. What happens afterwards depends on why the files were needed:
  - joining: the game is requested again and the handshake loads the map;
  - map change: the files are fetched while the next map is announced and ChangeMap
    waits for them (the session stays the same, nothing is re-requested);
  - wrong map version: the server's copy replaces the local one and is loaded.
}
unit WebDownload;

{$mode delphi}

interface

procedure StartMapDownload(Host: AnsiString; Port: Word; MapName: AnsiString);
function RedownloadMap(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
function MapAssetsMissing(const MapName: AnsiString): Boolean;
function EnsureMapAssets(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
function PrefetchMap(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
function MapFetchFailed(const MapName: AnsiString): Boolean;
procedure UpdateMapDownload;
procedure CancelMapDownload;
function MapDownloadActive: Boolean;
procedure ResetDownloadState;

implementation

uses
  SysUtils, Classes, PhysFS, Util, MapFile, GameRendering, GameStrings, Client,
  Game, Net, NetworkClientConnection, Constants;

// Starts a transfer; Files is a #10 separated list of relative paths. Returns a job id.
function js_fetch_files(Host: PAnsiChar; Port: LongInt; Files: PAnsiChar): LongInt; cdecl; external 'net' name 'fetch_files';
// 0 = pending, 1 = done, <0 = failed
function js_fetch_status(Job: LongInt): LongInt; cdecl; external 'net' name 'fetch_status';
function js_fetch_progress(Job: LongInt): LongInt; cdecl; external 'net' name 'fetch_progress';
procedure js_fetch_cancel(Job: LongInt); cdecl; external 'net' name 'fetch_cancel';

type
  TDownloadStage = (dsIdle, dsMap, dsAssets);
  TDownloadPurpose = (dpJoin, dpMapChange, dpRedownload);

var
  Redownloaded: TStringList = nil;
  AssetsAttempted: TStringList = nil;
  FailedMaps: TStringList = nil;
  Stage: TDownloadStage = dsIdle;
  Purpose: TDownloadPurpose = dpJoin;
  Job: LongInt = 0;
  DLHost: AnsiString;
  DLPort: Word;
  DLMap: AnsiString;
  LastProgress: LongInt = -1;

function NameList(var List: TStringList): TStringList;
begin
  if List = nil then
  begin
    List := TStringList.Create;
    List.CaseSensitive := False;
  end;
  Result := List;
end;

function MapDownloadActive: Boolean;
begin
  Result := Stage <> dsIdle;
end;

function MapFetchFailed(const MapName: AnsiString): Boolean;
begin
  Result := (FailedMaps <> nil) and (FailedMaps.IndexOf(MapName) >= 0);
end;

procedure CancelMapDownload;
begin
  if Stage <> dsIdle then
    js_fetch_cancel(Job);
  Stage := dsIdle;
end;

// a new connection tries every download again (the page can delete downloaded files)
procedure ResetDownloadState;
begin
  CancelMapDownload;
  if Redownloaded <> nil then
    Redownloaded.Clear;
  if AssetsAttempted <> nil then
    AssetsAttempted.Clear;
  if FailedMaps <> nil then
    FailedMaps.Clear;
end;

procedure ShowProgress(const Text: WideString);
begin
  // during a map change the game keeps rendering (paused): report in the console
  if Purpose = dpMapChange then
    MainConsole.Console(Text, GAME_MESSAGE_COLOR)
  else
    RenderGameInfo(Text);
end;

procedure StartFetch(Host: AnsiString; Port: Word; MapName, Files: AnsiString;
  NewStage: TDownloadStage; NewPurpose: TDownloadPurpose);
begin
  CancelMapDownload;
  DLHost := Host;
  DLPort := Port;
  DLMap := MapName;
  Purpose := NewPurpose;
  LastProgress := -1;
  ShowProgress(WideString(_('Downloading map') + ' ' + MapName + '...'));
  Job := js_fetch_files(PAnsiChar(Host), Port + 10, PAnsiChar(Files));
  Stage := NewStage;
end;

procedure StartMapDownload(Host: AnsiString; Port: Word; MapName: AnsiString);
begin
  StartFetch(Host, Port, MapName, 'maps/' + MapName + '.pms', dsMap, dpJoin);
end;

// The local copy of a map differs from the server's (heartbeat map id mismatch):
// fetch the server's version once; it takes precedence over the built-in one.
function RedownloadMap(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
var
  Key: AnsiString;
begin
  Result := False;
  Key := Host + ':' + IntToStr(Port) + '/' + MapName;
  if NameList(Redownloaded).IndexOf(Key) >= 0 then
    Exit;
  Redownloaded.Add(Key);
  StartFetch(Host, Port, MapName, 'maps/' + MapName + '.pms', dsMap, dpRedownload);
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
  if (AssetsAttempted <> nil) and (AssetsAttempted.IndexOf(MapName) >= 0) then
    Exit(False);  // already tried: play with whatever could be found
  Result := MissingAssets(MapName) <> '';
end;

// Fetches the textures and scenery of a map that is available locally. Returns False
// when there is nothing to fetch.
function FetchAssets(Host: AnsiString; Port: Word; MapName: AnsiString;
  NewPurpose: TDownloadPurpose): Boolean;
var
  Assets: AnsiString;
begin
  Result := False;
  if (AssetsAttempted <> nil) and (AssetsAttempted.IndexOf(MapName) >= 0) then
    Exit;
  Assets := MissingAssets(MapName);
  if Assets = '' then
    Exit;
  NameList(AssetsAttempted).Add(MapName);
  StartFetch(Host, Port, MapName, Assets, dsAssets, NewPurpose);
  Result := True;
end;

// Map textures and scenery are not part of the base archive: they come from the
// static asset mirror or the game server's file server. Returns False while they
// are being fetched (the game is requested again afterwards).
function EnsureMapAssets(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
begin
  Result := not FetchAssets(Host, Port, MapName, dpJoin);
end;

// A map change was announced: fetch what the next map needs while the scoreboard is
// shown. Returns True if a download was started (ChangeMap waits for it).
function PrefetchMap(Host: AnsiString; Port: Word; MapName: AnsiString): Boolean;
var
  Info: TMapInfo;
begin
  Result := False;
  if (Stage <> dsIdle) and SameText(DLMap, MapName) then
    Exit(True);  // already on its way
  if not GetMapInfo(MapName, UserDirectory, Info) then
  begin
    if MapFetchFailed(MapName) then
      Exit;
    StartFetch(Host, Port, MapName, 'maps/' + MapName + '.pms', dsMap, dpMapChange);
    Result := True;
  end
  else
    Result := FetchAssets(Host, Port, MapName, dpMapChange);
end;

procedure Finish;
begin
  Stage := dsIdle;
  FillCaseInsensitiveImageMap;
  case Purpose of
    dpJoin:
      begin
        // rejoin; the map is now available locally
        Map.Filename := '';  // reload even if a map with this name is loaded
        if MySprite > 0 then
          MapRejoin := True;
        RenderGameInfo(_('Loading'));
        ClientRequestGame;
      end;
    dpMapChange:
      ;  // ChangeMap is waiting for the files and loads the map
    dpRedownload:
      begin
        // load the server's copy of the current map, like a map change to it
        Map.Filename := '';
        MapChangeName := DLMap;
        MapChangeCounter := 0;
      end;
  end;
end;

procedure Fail(const Reason: WideString);
begin
  Stage := dsIdle;
  NameList(FailedMaps).Add(DLMap);
  if Purpose = dpMapChange then
  begin
    // ChangeMap reports it when the map is due
    MainConsole.Console(Reason, WARNING_MESSAGE_COLOR);
    Exit;
  end;
  ExitToMenu;
  RenderGameInfo(Reason);
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
    if (Progress <> LastProgress) and (Purpose <> dpMapChange) then
      RenderGameInfo(WideString(Format('%s %s (%d KB)', [_('Downloading map'), DLMap,
        Progress div 1024])));
    LastProgress := Progress;
    Exit;
  end;

  if Status < 0 then
  begin
    Fail(WideString(_('Could not download map') + ' ' + DLMap +
      '. ' + _('The server may not allow downloads.')));
    Exit;
  end;

  case Stage of
    dsMap:
      begin
        if not PHYSFS_exists(PChar('maps/' + DLMap + '.pms')) then
        begin
          Fail(WideString(_('Server did not provide map') + ' ' + DLMap));
          Exit;
        end;
        Assets := MissingAssets(DLMap);
        if (Assets = '') or (NameList(AssetsAttempted).IndexOf(DLMap) >= 0) then
          Finish
        else
        begin
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
