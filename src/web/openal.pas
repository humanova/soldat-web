{
  OpenAL subset for the WebAssembly build of Soldat.

  Implemented in JavaScript on top of WebAudio (import module "al"). Declarations match
  the FreePascal OpenAL headers so Sound.pas compiles unchanged.
}
unit openal;

{$mode objfpc}

interface

type
  ALboolean = Boolean;
  ALchar = AnsiChar;
  PALchar = PAnsiChar;
  ALint = LongInt;
  PALint = ^ALint;
  ALuint = LongWord;
  PALuint = ^ALuint;
  ALsizei = LongInt;
  ALenum = LongInt;
  ALfloat = Single;
  PALfloat = ^ALfloat;
  PALvoid = Pointer;

  ALCchar = AnsiChar;
  PALCchar = PAnsiChar;
  ALCboolean = Boolean;
  ALCint = LongInt;
  PALCint = ^ALCint;
  ALCdevice = record end;
  PALCdevice = ^ALCdevice;
  ALCcontext = record end;
  PALCcontext = ^ALCcontext;

const
  AL_NONE = 0;
  AL_FALSE = 0;
  AL_TRUE = 1;
  AL_PITCH = $1003;
  AL_POSITION = $1004;
  AL_LOOPING = $1007;
  AL_BUFFER = $1009;
  AL_GAIN = $100A;
  AL_SOURCE_STATE = $1010;
  AL_INITIAL = $1011;
  AL_PLAYING = $1012;
  AL_PAUSED = $1013;
  AL_STOPPED = $1014;
  AL_BUFFERS_QUEUED = $1015;
  AL_BUFFERS_PROCESSED = $1016;
  AL_FORMAT_MONO8 = $1100;
  AL_FORMAT_MONO16 = $1101;
  AL_FORMAT_STEREO8 = $1102;
  AL_FORMAT_STEREO16 = $1103;
  AL_FORMAT_MONO_FLOAT32 = $10010;
  AL_FORMAT_STEREO_FLOAT32 = $10011;
  AL_NO_ERROR = AL_FALSE;

procedure alBufferData(bid: ALuint; format: ALenum; data: PALvoid; size: ALsizei; freq: ALsizei); cdecl; external 'al' name 'alBufferData';
procedure alDeleteBuffers(n: ALsizei; const buffers: PALuint); cdecl; external 'al' name 'alDeleteBuffers';
procedure alDeleteSources(n: ALsizei; const sources: PALuint); cdecl; external 'al' name 'alDeleteSources';
procedure alDistanceModel(distanceModel: ALenum); cdecl; external 'al' name 'alDistanceModel';
procedure alGenBuffers(n: ALsizei; buffers: PALuint); cdecl; external 'al' name 'alGenBuffers';
procedure alGenSources(n: ALsizei; sources: PALuint); cdecl; external 'al' name 'alGenSources';
function alGetError: ALenum; cdecl; external 'al' name 'alGetError';
procedure js_alGetSourcei(sid: ALuint; param: ALenum; value: PALint); cdecl; external 'al' name 'alGetSourcei';
procedure alSource3f(sid: ALuint; param: ALenum; value1, value2, value3: ALfloat); cdecl; external 'al' name 'alSource3f';
procedure alSourcePause(sid: ALuint); cdecl; external 'al' name 'alSourcePause';
procedure alSourcePlay(sid: ALuint); cdecl; external 'al' name 'alSourcePlay';
procedure alSourceQueueBuffers(sid: ALuint; numEntries: ALsizei; const bids: PALuint); cdecl; external 'al' name 'alSourceQueueBuffers';
procedure alSourceStop(sid: ALuint); cdecl; external 'al' name 'alSourceStop';
procedure alSourceUnqueueBuffers(sid: ALuint; numEntries: ALsizei; bids: PALuint); cdecl; external 'al' name 'alSourceUnqueueBuffers';
procedure alSourcef(sid: ALuint; param: ALenum; value: ALfloat); cdecl; external 'al' name 'alSourcef';
procedure alSourcei(sid: ALuint; param: ALenum; value: ALint); cdecl; external 'al' name 'alSourcei';

procedure alGetSourcei(sid: ALuint; param: ALenum; var value: ALint);

function alcOpenDevice(const devicename: PALCchar): PALCdevice;
function alcCreateContext(device: PALCdevice; const attrlist: PALCint): PALCcontext;
function alcMakeContextCurrent(context: PALCcontext): ALCboolean;
procedure alcDestroyContext(context: PALCcontext);
function alcCloseDevice(device: PALCdevice): ALCboolean;
function alcGetCurrentContext: PALCcontext;
function alcGetContextsDevice(context: PALCcontext): PALCdevice;

implementation

function js_alInit: LongInt; cdecl; external 'al' name 'alInit';

var
  DummyDevice: ALCdevice;
  DummyContext: ALCcontext;
  Current: PALCcontext = nil;

procedure alGetSourcei(sid: ALuint; param: ALenum; var value: ALint);
begin
  js_alGetSourcei(sid, param, @value);
end;

function alcOpenDevice(const devicename: PALCchar): PALCdevice;
begin
  if js_alInit <> 0 then
    Result := @DummyDevice
  else
    Result := nil;
end;

function alcCreateContext(device: PALCdevice; const attrlist: PALCint): PALCcontext;
begin
  Result := @DummyContext;
end;

function alcMakeContextCurrent(context: PALCcontext): ALCboolean;
begin
  Current := context;
  Result := True;
end;

procedure alcDestroyContext(context: PALCcontext);
begin
  Current := nil;
end;

function alcCloseDevice(device: PALCdevice): ALCboolean;
begin
  Result := True;
end;

function alcGetCurrentContext: PALCcontext;
begin
  Result := Current;
end;

function alcGetContextsDevice(context: PALCcontext): PALCdevice;
begin
  Result := @DummyDevice;
end;

end.
