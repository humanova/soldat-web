{
  Soldat 1.7.1 network obfuscation primitives.

  - PacketHash: 16-bit check value stored in bytes 1..2 of every message.
  - TNetCipher: DCPcrypt-compatible TDCP_blowfish in CBC mode keyed with
    InitStr(Key, TDCP_ripemd160). Partial blocks follow DCPcrypt's CBC behaviour
    (CV := E(CV); Data := Data xor CV), which the 1.7.1 server relies on.
  - SessionKey: key string derived from the per-map session id sent in PlayersList.
}
unit NetCrypt;

{$mode delphi}
{$Q-}{$R-}

interface

uses
  SysUtils, BlowFish;

type
  TRipeMD160Digest = array[0..19] of Byte;

  TNetCipher = class
  private
    FBF: TBlowFish;
    FIV, FCV: array[0..7] of Byte;
    FReady: Boolean;
    procedure EncryptECB(var Block: array of Byte);
    procedure DecryptECB(var Block: array of Byte);
  public
    destructor Destroy; override;
    procedure InitStr(const Key: AnsiString);
    procedure Reset;
    procedure Encrypt(var Data; Size: Integer);
    procedure Decrypt(var Data; Size: Integer);
    property Ready: Boolean read FReady;
  end;

function PacketHash(Data: PByte; Size: Integer): Word;
procedure SetPacketHash(Data: PByte; Size: Integer);
function CheckPacketHash(Data: PByte; Size: Integer): Boolean;
function RipeMD160(const Data; Len: Integer): TRipeMD160Digest;
function SessionKey(SessionID: Word): AnsiString;

implementation

function PacketHash(Data: PByte; Size: Integer): Word;
var
  i: Integer;
  h: Word;
begin
  h := Word(Data[0] + $B5A5);
  for i := 3 to Size - 1 do
    h := Word(h * 33 + Data[i]);
  Result := h;
end;

procedure SetPacketHash(Data: PByte; Size: Integer);
var
  h: Word;
begin
  h := PacketHash(Data, Size);
  Data[1] := h and $FF;
  Data[2] := h shr 8;
end;

function CheckPacketHash(Data: PByte; Size: Integer): Boolean;
begin
  Result := (Size >= 3) and (PacketHash(Data, Size) = (Data[1] or (Word(Data[2]) shl 8)));
end;

function SessionKey(SessionID: Word): AnsiString;
begin
  Result := #$A7 + IntToStr(Integer(SessionID) + $25B3B1);
end;

{ RIPEMD-160 }

function ROL(x: LongWord; n: Integer): LongWord; inline;
begin
  Result := (x shl n) or (x shr (32 - n));
end;

const
  RL: array[0..79] of Byte = (
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
    3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
    1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
    4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13);
  RR: array[0..79] of Byte = (
    5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
    6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
    15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
    8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
    12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11);
  SL: array[0..79] of Byte = (
    11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
    7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
    11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
    11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
    9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6);
  SR: array[0..79] of Byte = (
    8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
    9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
    9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
    15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
    8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11);
  KL: array[0..4] of LongWord = ($00000000, $5A827999, $6ED9EBA1, $8F1BBCDC, $A953FD4E);
  KR: array[0..4] of LongWord = ($50A28BE6, $5C4DD124, $6D703EF3, $7A6D76E9, $00000000);

function RF(j: Integer; x, y, z: LongWord): LongWord; inline;
begin
  case j div 16 of
    0: Result := x xor y xor z;
    1: Result := (x and y) or ((not x) and z);
    2: Result := (x or (not y)) xor z;
    3: Result := (x and z) or (y and (not z));
  else
    Result := x xor (y or (not z));
  end;
end;

procedure RipeCompress(var H: array of LongWord; const X: array of LongWord);
var
  al, bl, cl, dl, el, ar, br, cr, dr, er, t: LongWord;
  j: Integer;
begin
  al := H[0]; bl := H[1]; cl := H[2]; dl := H[3]; el := H[4];
  ar := al; br := bl; cr := cl; dr := dl; er := el;
  for j := 0 to 79 do
  begin
    t := ROL(al + RF(j, bl, cl, dl) + X[RL[j]] + KL[j div 16], SL[j]) + el;
    al := el; el := dl; dl := ROL(cl, 10); cl := bl; bl := t;
    t := ROL(ar + RF(79 - j, br, cr, dr) + X[RR[j]] + KR[j div 16], SR[j]) + er;
    ar := er; er := dr; dr := ROL(cr, 10); cr := br; br := t;
  end;
  t := H[1] + cl + dr;
  H[1] := H[2] + dl + er;
  H[2] := H[3] + el + ar;
  H[3] := H[4] + al + br;
  H[4] := H[0] + bl + cr;
  H[0] := t;
end;

function RipeMD160(const Data; Len: Integer): TRipeMD160Digest;
var
  H: array[0..4] of LongWord;
  X: array[0..15] of LongWord;
  Buf: array[0..127] of Byte;
  p: PByte;
  i, Rem, Blocks: Integer;
  BitLen: QWord;
begin
  H[0] := $67452301; H[1] := $EFCDAB89; H[2] := $98BADCFE; H[3] := $10325476; H[4] := $C3D2E1F0;
  p := @Data;
  Blocks := Len div 64;
  for i := 0 to Blocks - 1 do
  begin
    Move(p[i * 64], X, 64);
    RipeCompress(H, X);
  end;
  Rem := Len - Blocks * 64;
  FillChar(Buf, SizeOf(Buf), 0);
  if Rem > 0 then
    Move(p[Blocks * 64], Buf, Rem);
  Buf[Rem] := $80;
  BitLen := QWord(Len) * 8;
  if Rem >= 56 then
  begin
    Move(Buf, X, 64);
    RipeCompress(H, X);
    FillChar(Buf, 64, 0);
  end;
  Move(BitLen, Buf[56], 8);
  Move(Buf, X, 64);
  RipeCompress(H, X);
  Move(H, Result, 20);
end;

{ TNetCipher }

destructor TNetCipher.Destroy;
begin
  FBF.Free;
  inherited;
end;

procedure TNetCipher.EncryptECB(var Block: array of Byte);
var
  B: TBFBlock;
begin
  B[0] := LongInt((LongWord(Block[0]) shl 24) or (LongWord(Block[1]) shl 16) or
    (LongWord(Block[2]) shl 8) or Block[3]);
  B[1] := LongInt((LongWord(Block[4]) shl 24) or (LongWord(Block[5]) shl 16) or
    (LongWord(Block[6]) shl 8) or Block[7]);
  FBF.Encrypt(B);
  Block[0] := LongWord(B[0]) shr 24; Block[1] := (LongWord(B[0]) shr 16) and $FF;
  Block[2] := (LongWord(B[0]) shr 8) and $FF; Block[3] := LongWord(B[0]) and $FF;
  Block[4] := LongWord(B[1]) shr 24; Block[5] := (LongWord(B[1]) shr 16) and $FF;
  Block[6] := (LongWord(B[1]) shr 8) and $FF; Block[7] := LongWord(B[1]) and $FF;
end;

procedure TNetCipher.DecryptECB(var Block: array of Byte);
var
  B: TBFBlock;
begin
  B[0] := LongInt((LongWord(Block[0]) shl 24) or (LongWord(Block[1]) shl 16) or
    (LongWord(Block[2]) shl 8) or Block[3]);
  B[1] := LongInt((LongWord(Block[4]) shl 24) or (LongWord(Block[5]) shl 16) or
    (LongWord(Block[6]) shl 8) or Block[7]);
  FBF.Decrypt(B);
  Block[0] := LongWord(B[0]) shr 24; Block[1] := (LongWord(B[0]) shr 16) and $FF;
  Block[2] := (LongWord(B[0]) shr 8) and $FF; Block[3] := LongWord(B[0]) and $FF;
  Block[4] := LongWord(B[1]) shr 24; Block[5] := (LongWord(B[1]) shr 16) and $FF;
  Block[6] := (LongWord(B[1]) shr 8) and $FF; Block[7] := LongWord(B[1]) and $FF;
end;

procedure TNetCipher.InitStr(const Key: AnsiString);
var
  Digest: TRipeMD160Digest;
  BFKey: TBlowFishKey;
begin
  if Key <> '' then
    Digest := RipeMD160(Key[1], Length(Key))
  else
    Digest := RipeMD160(Digest, 0);
  FillChar(BFKey, SizeOf(BFKey), 0);
  Move(Digest, BFKey, SizeOf(Digest));
  FBF.Free;
  FBF := TBlowFish.Create(BFKey, SizeOf(Digest));
  FillChar(FIV, SizeOf(FIV), 0);
  EncryptECB(FIV);
  FReady := True;
  Reset;
end;

procedure TNetCipher.Reset;
begin
  Move(FIV, FCV, SizeOf(FCV));
end;

procedure TNetCipher.Encrypt(var Data; Size: Integer);
var
  p: PByte;
  i, j, Rem: Integer;
begin
  if not FReady then
    Exit;
  p := @Data;
  for i := 1 to Size div 8 do
  begin
    for j := 0 to 7 do
      p[j] := p[j] xor FCV[j];
    EncryptECB(PByteArray(p)^[0..7]);
    Move(p^, FCV, 8);
    Inc(p, 8);
  end;
  Rem := Size mod 8;
  if Rem <> 0 then
  begin
    EncryptECB(FCV);
    for j := 0 to Rem - 1 do
      p[j] := p[j] xor FCV[j];
  end;
end;

procedure TNetCipher.Decrypt(var Data; Size: Integer);
var
  p: PByte;
  i, j, Rem: Integer;
  Temp: array[0..7] of Byte;
begin
  if not FReady then
    Exit;
  p := @Data;
  for i := 1 to Size div 8 do
  begin
    Move(p^, Temp, 8);
    DecryptECB(PByteArray(p)^[0..7]);
    for j := 0 to 7 do
      p[j] := p[j] xor FCV[j];
    Move(Temp, FCV, 8);
    Inc(p, 8);
  end;
  Rem := Size mod 8;
  if Rem <> 0 then
  begin
    EncryptECB(FCV);
    for j := 0 to Rem - 1 do
      p[j] := p[j] xor FCV[j];
  end;
end;

end.
