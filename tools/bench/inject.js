// Injected before the page's scripts by bench.mjs. Counts the wasm module's
// import calls and records every animation frame: timestamp, time spent in the
// callback (the game's frame), draw calls, GL calls and, when the browser offers
// EXT_disjoint_timer_query_webgl2, the GPU time of the frame.
(() => {
  try {
    localStorage.setItem('soldat.settings', JSON.stringify({ name: 'Bench', fullscreen: false }));
  } catch (_) {}
  const P = window.__bench = { calls: Object.create(null), frames: [], gpu: [], draws: 0, glCalls: 0, rec: false };

  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (mod, imports) {
    if (imports && mod instanceof WebAssembly.Module) {
      for (const m of Object.keys(imports)) {
        const obj = imports[m];
        for (const n of Object.keys(obj)) {
          const f = obj[n];
          if (typeof f !== 'function') continue;
          const key = m + '.' + n;
          const isDraw = n === 'glDrawArrays' || n === 'glDrawElements';
          const isGL = m === 'gl';
          obj[n] = function () {
            if (P.rec) P.calls[key] = (P.calls[key] || 0) + 1;
            if (isDraw) P.draws++;
            if (isGL) P.glCalls++;
            return f.apply(this, arguments);
          };
        }
      }
    }
    return instantiate.apply(this, arguments);
  };

  let gl = null, ext = null;
  const pool = [], inflight = [];
  function gpuBegin() {
    if (!P.rec) return null;
    if (!gl) {
      gl = window.soldat && window.soldat.sdl && window.soldat.sdl.getContext();
      if (gl) { ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); P.gpuExt = !!ext; }
    }
    if (!gl || !ext) return null;
    const q = pool.pop() || gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    return q;
  }
  function gpuEnd(q) {
    if (!q) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    inflight.push(q);
    while (inflight.length && gl.getQueryParameter(inflight[0], gl.QUERY_RESULT_AVAILABLE)) {
      const h = inflight.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) P.gpu.push(gl.getQueryParameter(h, gl.QUERY_RESULT) / 1e6);
      pool.push(h);
    }
  }

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return raf(function (ts) {
      const d0 = P.draws, g0 = P.glCalls;
      const q = gpuBegin();
      const t0 = performance.now();
      cb(ts);
      const t1 = performance.now();
      gpuEnd(q);
      if (P.rec) P.frames.push([ts, t1 - t0, P.draws - d0, P.glCalls - g0]);
      if (P.joinAt && !P.mapAt && P.draws - d0 >= 10) P.mapAt = performance.now();
    });
  };
})();
