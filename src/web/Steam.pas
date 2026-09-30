{
  Minimal stand-in for the Steam/GameNetworkingSockets bindings in the WebAssembly build.

  The 1.7.1 protocol runs over plain UDP (relayed through a WebSocket bridge), so only the
  message record type used by the network handlers and a few constants remain.
}
unit Steam;

{$mode delphi}

interface

const
  k_nSteamNetworkingSend_Unreliable = 0;
  k_nSteamNetworkingSend_NoNagle = 1;
  k_nSteamNetworkingSend_NoDelay = 4;
  k_nSteamNetworkingSend_Reliable = 8;
  k_nSteamNetworkingSend_UnreliableNoDelay = k_nSteamNetworkingSend_Unreliable or
    k_nSteamNetworkingSend_NoDelay or k_nSteamNetworkingSend_NoNagle;

type
  PSteamNetworkingMessage_t = ^SteamNetworkingMessage_t;
  SteamNetworkingMessage_t = record
    m_pData: Pointer;
    m_cbSize: LongInt;
    procedure Release;
  end;

  // Connection statistics shown by the network stats overlay.
  SteamNetConnectionRealTimeStatus_t = record
    m_nPing: LongInt;
    m_flConnectionQualityLocal: Single;
    m_flConnectionQualityRemote: Single;
    m_flOutPacketsPerSec: Single;
    m_flOutBytesPerSec: Single;
    m_flInPacketsPerSec: Single;
    m_flInBytesPerSec: Single;
    m_nSendRateBytesPerSecond: LongInt;
    m_cbPendingUnreliable: LongInt;
    m_cbPendingReliable: LongInt;
    m_cbSentUnackedReliable: LongInt;
    m_usecQueueTime: Int64;
  end;

implementation

procedure SteamNetworkingMessage_t.Release;
begin
end;

end.
