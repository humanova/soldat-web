// OpenAL subset used by Sound.pas, on top of WebAudio. Positions only drive
// stereo panning (the game uses AL_NONE distance model).

const AL_PITCH = 0x1003, AL_POSITION = 0x1004, AL_LOOPING = 0x1007, AL_BUFFER = 0x1009,
  AL_GAIN = 0x100A, AL_SOURCE_STATE = 0x1010, AL_INITIAL = 0x1011, AL_PLAYING = 0x1012,
  AL_PAUSED = 0x1013, AL_STOPPED = 0x1014, AL_BUFFERS_QUEUED = 0x1015,
  AL_BUFFERS_PROCESSED = 0x1016;
const AL_FORMAT_MONO8 = 0x1100, AL_FORMAT_MONO16 = 0x1101, AL_FORMAT_STEREO8 = 0x1102,
  AL_FORMAT_STEREO16 = 0x1103, AL_FORMAT_MONO_FLOAT32 = 0x10010, AL_FORMAT_STEREO_FLOAT32 = 0x10011;

export function createAL(rt) {
  let ctx = null;
  let master = null;
  const buffers = [null];
  const sources = [null];
  let held = false;  // a paused replay: every sound stands still where it is

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    return ctx;
  }

  function decode(format, ptr, size, freq) {
    const a = audio();
    const u8 = rt.u8().subarray(ptr, ptr + size);
    const dv = new DataView(u8.slice().buffer);
    let channels = 1, bytes = 1, kind = 'u8';
    switch (format) {
      case AL_FORMAT_MONO8: break;
      case AL_FORMAT_STEREO8: channels = 2; break;
      case AL_FORMAT_MONO16: bytes = 2; kind = 's16'; break;
      case AL_FORMAT_STEREO16: channels = 2; bytes = 2; kind = 's16'; break;
      case AL_FORMAT_MONO_FLOAT32: bytes = 4; kind = 'f32'; break;
      case AL_FORMAT_STEREO_FLOAT32: channels = 2; bytes = 4; kind = 'f32'; break;
    }
    const frames = Math.floor(size / (bytes * channels));
    if (frames <= 0) return null;
    const buf = a.createBuffer(channels, frames, Math.min(Math.max(freq, 8000), 96000));
    for (let c = 0; c < channels; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) {
        const o = (i * channels + c) * bytes;
        out[i] = kind === 'u8' ? (dv.getUint8(o) - 128) / 128
          : kind === 's16' ? dv.getInt16(o, true) / 32768 : dv.getFloat32(o, true);
      }
    }
    return buf;
  }

  function stopNode(s) {
    if (s.node) {
      s.node.onended = null;
      try { s.node.stop(); } catch (_) {}
      s.node.disconnect();
      s.node = null;
    }
  }

  function play(s) {
    const a = audio();
    stopNode(s);
    const buf = buffers[s.buffer];
    if (!a || !buf) { s.state = AL_STOPPED; return; }
    const node = a.createBufferSource();
    node.buffer = buf;
    node.loop = s.looping;
    node.playbackRate.value = s.pitch;
    node.connect(s.gainNode);
    const offset = s.state === AL_PAUSED ? s.offset % buf.duration : 0;
    node.onended = () => {
      if (s.node === node) { s.node = null; s.state = AL_STOPPED; node.disconnect(); }
    };
    node.start(0, offset);
    s.node = node;
    s.startTime = a.currentTime - offset;
    s.state = AL_PLAYING;
  }

  function source(id) { return sources[id]; }

  function updatePan(s) {
    const [x, y, z] = s.position;
    const len = Math.sqrt(x * x + y * y + z * z);
    const pan = len > 1e-6 ? Math.max(-1, Math.min(1, x / len)) : 0;
    if (s.panner) s.panner.pan.value = pan;
  }

  return {
    alInit: () => (audio() ? 1 : 0),
    alGetError: () => 0,
    alDistanceModel: () => {},
    alGenBuffers: (n, ptr) => {
      for (let i = 0; i < n; i++) {
        buffers.push(null);
        rt.dv().setUint32(ptr + i * 4, buffers.length - 1, true);
      }
    },
    alDeleteBuffers: (n, ptr) => {
      for (let i = 0; i < n; i++) buffers[rt.dv().getUint32(ptr + i * 4, true)] = null;
    },
    alBufferData: (bid, format, ptr, size, freq) => {
      if (bid > 0 && bid < buffers.length) buffers[bid] = decode(format, ptr, size, freq);
    },
    alGenSources: (n, ptr) => {
      const a = audio();
      for (let i = 0; i < n; i++) {
        const s = { buffer: 0, looping: false, pitch: 1, gain: 1, position: [0, 0, 0],
          state: AL_INITIAL, node: null, offset: 0, startTime: 0, gainNode: null, panner: null };
        if (a) {
          s.gainNode = a.createGain();
          s.panner = a.createStereoPanner ? a.createStereoPanner() : null;
          if (s.panner) { s.gainNode.connect(s.panner); s.panner.connect(master); }
          else s.gainNode.connect(master);
        }
        sources.push(s);
        rt.dv().setUint32(ptr + i * 4, sources.length - 1, true);
      }
    },
    alDeleteSources: (n, ptr) => {
      for (let i = 0; i < n; i++) {
        const id = rt.dv().getUint32(ptr + i * 4, true);
        const s = sources[id];
        if (s) { stopNode(s); sources[id] = null; }
      }
    },
    alSourcei: (id, param, value) => {
      const s = source(id);
      if (!s) return;
      if (param === AL_BUFFER) s.buffer = value;
      else if (param === AL_LOOPING) { s.looping = !!value; if (s.node) s.node.loop = s.looping; }
    },
    alSourcef: (id, param, value) => {
      const s = source(id);
      if (!s) return;
      if (param === AL_GAIN) {
        s.gain = Math.max(0, value);
        if (s.gainNode) s.gainNode.gain.value = s.gain;
      } else if (param === AL_PITCH) {
        s.pitch = value > 0 ? value : 1;
        if (s.node) s.node.playbackRate.value = s.pitch;
      }
    },
    alSource3f: (id, param, x, y, z) => {
      const s = source(id);
      if (!s || param !== AL_POSITION) return;
      s.position = [x, y, z];
      updatePan(s);
    },
    alGetSourcei: (id, param, ptr) => {
      const s = source(id);
      let v = 0;
      if (s) {
        if (param === AL_SOURCE_STATE) v = s.state;
        else if (param === AL_BUFFER) v = s.buffer;
        else if (param === AL_LOOPING) v = s.looping ? 1 : 0;
        else if (param === AL_BUFFERS_QUEUED || param === AL_BUFFERS_PROCESSED) v = 0;
      }
      rt.dv().setInt32(ptr, v, true);
    },
    alSourcePlay: (id) => { const s = source(id); if (s) play(s); },
    alSourcePause: (id) => {
      const s = source(id);
      if (!s || s.state !== AL_PLAYING) return;
      s.offset = ctx ? ctx.currentTime - s.startTime : 0;
      stopNode(s);
      s.state = AL_PAUSED;
    },
    alSourceStop: (id) => {
      const s = source(id);
      if (!s) return;
      stopNode(s);
      s.offset = 0;
      s.state = AL_STOPPED;
    },
    alSourceQueueBuffers: () => {},
    alSourceUnqueueBuffers: () => {},

    // not part of OpenAL: used by the page
    resume: () => { const a = audio(); if (a && !held && a.state !== 'running') a.resume().catch(() => {}); },
    hold: (on) => {
      held = !!on;
      const a = audio();
      if (!a) return;
      if (held) a.suspend().catch(() => {});
      else if (a.state !== 'running') a.resume().catch(() => {});
    },
    setMasterVolume: (v) => { audio(); if (master) master.gain.value = v; },
  };
}
