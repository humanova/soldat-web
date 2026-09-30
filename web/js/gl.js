// OpenGL subset used by Gfx.pas, implemented on WebGL2.
// GL object names are small integers mapped to WebGL objects.

const GL_VERSION = 0x1F02, GL_VENDOR = 0x1F00, GL_RENDERER = 0x1F01, GL_EXTENSIONS = 0x1F03,
  GL_SHADING_LANGUAGE_VERSION = 0x8B8C;
const GL_COMPILE_STATUS = 0x8B81, GL_LINK_STATUS = 0x8B82, GL_INFO_LOG_LENGTH = 0x8B84;
const GL_MAX_TEXTURE_SIZE = 0x0D33, GL_SAMPLES = 0x80A9, GL_VIEWPORT = 0x0BA2;
const GL_ALPHA = 0x1906, GL_RGB = 0x1907, GL_RGBA = 0x1908, GL_LUMINANCE = 0x1909,
  GL_LUMINANCE_ALPHA = 0x190A;
const GL_UNSIGNED_BYTE = 0x1401;

// capabilities that exist in WebGL; everything else (TEXTURE_2D, MULTISAMPLE, ...) is ignored
const WEBGL_CAPS = new Set([0x0BE2 /*BLEND*/, 0x0B44 /*CULL_FACE*/, 0x0B71 /*DEPTH_TEST*/,
  0x0BD0 /*DITHER*/, 0x8037 /*POLYGON_OFFSET_FILL*/, 0x809E /*SAMPLE_ALPHA_TO_COVERAGE*/,
  0x80A0 /*SAMPLE_COVERAGE*/, 0x0C11 /*SCISSOR_TEST*/, 0x0B90 /*STENCIL_TEST*/]);

function bytesPerPixel(format) {
  switch (format) {
    case GL_ALPHA: case GL_LUMINANCE: return 1;
    case GL_LUMINANCE_ALPHA: return 2;
    case GL_RGB: return 3;
    default: return 4;
  }
}

// GLSL 1.20 (desktop) -> GLSL ES 1.00
function translateShader(src, type) {
  let s = src.replace(/^\s*#version\s+\d+[^\n]*\n?/m, '');
  const header = type === 0x8B30 /*FRAGMENT*/
    ? '#version 100\nprecision mediump float;\n'
    : '#version 100\nprecision highp float;\n';
  return header + s;
}

export function createGL(rt, getContext) {
  let gl = null;
  const textures = [null], buffers = [null], framebuffers = [null], programs = [null], shaders = [null];
  const uniforms = [null];
  const strings = new Map();
  const shaderInfo = new Map();
  let pixelUnpackAlignment = 4, pixelPackAlignment = 4;

  function ctx() {
    if (!gl) gl = getContext();
    return gl;
  }

  function add(table, obj) {
    for (let i = 1; i < table.length; i++) if (table[i] === null) { table[i] = obj; return i; }
    table.push(obj);
    return table.length - 1;
  }

  function gen(table, factory) {
    return (n, ptr) => {
      const dv = rt.dv();
      for (let i = 0; i < n; i++) dv.setUint32(ptr + i * 4, add(table, factory()), true);
    };
  }

  function del(table, deleter) {
    return (n, ptr) => {
      const dv = rt.dv();
      for (let i = 0; i < n; i++) {
        const id = dv.getUint32(ptr + i * 4, true);
        if (id && table[id]) { deleter(table[id]); table[id] = null; }
      }
    };
  }

  function imageData(width, height, format, type, ptr) {
    if (!ptr) return null;
    const bpp = bytesPerPixel(format);
    const rowLen = width * bpp;
    const align = pixelUnpackAlignment;
    const stride = Math.ceil(rowLen / align) * align;
    const size = stride * (height - 1) + rowLen;
    return rt.u8().subarray(ptr, ptr + size);
  }

  function writeString(ptr, maxLen, lenPtr, text) {
    const b = new TextEncoder().encode(text);
    const n = Math.max(0, Math.min(b.length, maxLen - 1));
    if (ptr && maxLen > 0) {
      rt.u8().set(b.subarray(0, n), ptr);
      rt.u8()[ptr + n] = 0;
    }
    if (lenPtr) rt.dv().setInt32(lenPtr, n, true);
  }

  const noop = () => {};

  const api = {
    glActiveTexture: (t) => ctx().activeTexture(t),
    glAttachShader: (p, s) => ctx().attachShader(programs[p], shaders[s]),
    glBindAttribLocation: (p, index, namePtr) => ctx().bindAttribLocation(programs[p], index, rt.cstr(namePtr)),
    glBindBuffer: (target, id) => ctx().bindBuffer(target, buffers[id] || null),
    glBindFramebuffer: (target, id) => ctx().bindFramebuffer(target, framebuffers[id] || null),
    glBindTexture: (target, id) => {
      if (target !== 0x0DE1 /*TEXTURE_2D*/) return;
      ctx().bindTexture(target, textures[id] || null);
    },
    glBlendFunc: (s, d) => ctx().blendFunc(s, d),
    glBlitFramebuffer: (x0, y0, x1, y1, dx0, dy0, dx1, dy1, mask, filter) =>
      ctx().blitFramebuffer(x0, y0, x1, y1, dx0, dy0, dx1, dy1, mask, filter),
    glBufferData: (target, size, ptr, usage) => {
      if (ptr) ctx().bufferData(target, rt.u8().subarray(ptr, ptr + size), usage);
      else ctx().bufferData(target, size, usage);
    },
    glBufferSubData: (target, offset, size, ptr) =>
      ctx().bufferSubData(target, offset, rt.u8().subarray(ptr, ptr + size)),
    glClear: (mask) => ctx().clear(mask),
    glClearColor: (r, g, b, a) => ctx().clearColor(r, g, b, a),
    glColorPointer: noop,
    glCompileShader: (s) => {
      const g = ctx();
      g.compileShader(shaders[s]);
      if (!g.getShaderParameter(shaders[s], g.COMPILE_STATUS))
        console.error('[gl] shader compile error:', g.getShaderInfoLog(shaders[s]));
    },
    glCreateProgram: () => add(programs, ctx().createProgram()),
    glCreateShader: (type) => {
      const id = add(shaders, ctx().createShader(type));
      shaderInfo.set(id, type);
      return id;
    },
    glDeleteBuffers: del(buffers, (b) => ctx().deleteBuffer(b)),
    glDeleteFramebuffers: del(framebuffers, (f) => ctx().deleteFramebuffer(f)),
    glDeleteProgram: (p) => { if (programs[p]) { ctx().deleteProgram(programs[p]); programs[p] = null; } },
    glDeleteShader: (s) => { if (shaders[s]) { ctx().deleteShader(shaders[s]); shaders[s] = null; } },
    glDeleteTextures: del(textures, (t) => ctx().deleteTexture(t)),
    glDetachShader: (p, s) => ctx().detachShader(programs[p], shaders[s]),
    glDisable: (cap) => { if (WEBGL_CAPS.has(cap)) ctx().disable(cap); },
    glDrawArrays: (mode, first, count) => ctx().drawArrays(mode, first, count),
    glDrawElements: (mode, count, type, offset) => ctx().drawElements(mode, count, type, offset),
    glEnable: (cap) => { if (WEBGL_CAPS.has(cap)) ctx().enable(cap); },
    glEnableClientState: noop,
    glEnableVertexAttribArray: (i) => ctx().enableVertexAttribArray(i),
    glFinish: () => ctx().finish(),
    glFramebufferTexture2D: (target, attachment, textarget, tex, level) =>
      ctx().framebufferTexture2D(target, attachment, textarget, textures[tex] || null, level),
    glGenBuffers: gen(buffers, () => ctx().createBuffer()),
    glGenFramebuffers: gen(framebuffers, () => ctx().createFramebuffer()),
    glGenTextures: gen(textures, () => ctx().createTexture()),
    glGenerateMipmap: (target) => ctx().generateMipmap(target),
    glGetIntegerv: (pname, ptr) => {
      const g = ctx();
      const dv = rt.dv();
      if (pname === GL_SAMPLES) { dv.setInt32(ptr, 0, true); return; }
      const v = g.getParameter(pname);
      if (v && typeof v === 'object' && 'length' in v) {
        for (let i = 0; i < v.length; i++) dv.setInt32(ptr + i * 4, v[i], true);
      } else dv.setInt32(ptr, typeof v === 'boolean' ? (v ? 1 : 0) : (v | 0), true);
    },
    glGetProgramInfoLog: (p, maxLen, lenPtr, logPtr) =>
      writeString(logPtr, maxLen, lenPtr, ctx().getProgramInfoLog(programs[p]) || ''),
    glGetProgramiv: (p, pname, ptr) => {
      const g = ctx();
      let v;
      if (pname === GL_INFO_LOG_LENGTH) v = (g.getProgramInfoLog(programs[p]) || '').length + 1;
      else v = g.getProgramParameter(programs[p], pname);
      rt.dv().setInt32(ptr, typeof v === 'boolean' ? (v ? 1 : 0) : (v | 0), true);
    },
    glGetShaderInfoLog: (s, maxLen, lenPtr, logPtr) =>
      writeString(logPtr, maxLen, lenPtr, ctx().getShaderInfoLog(shaders[s]) || ''),
    glGetShaderiv: (s, pname, ptr) => {
      const g = ctx();
      let v;
      if (pname === GL_INFO_LOG_LENGTH) v = (g.getShaderInfoLog(shaders[s]) || '').length + 1;
      else v = g.getShaderParameter(shaders[s], pname);
      rt.dv().setInt32(ptr, typeof v === 'boolean' ? (v ? 1 : 0) : (v | 0), true);
    },
    glGetString: (name) => {
      if (strings.has(name)) return strings.get(name);
      const g = ctx();
      let s = '';
      switch (name) {
        case GL_VERSION: s = '2.1 (WebGL 2.0 ' + (g.getParameter(g.VERSION) || '') + ')'; break;
        case GL_VENDOR: s = String(g.getParameter(g.VENDOR)); break;
        case GL_RENDERER: s = String(g.getParameter(g.RENDERER)); break;
        case GL_SHADING_LANGUAGE_VERSION: s = '1.20'; break;
        case GL_EXTENSIONS: s = 'GL_ARB_framebuffer_object GL_ARB_texture_non_power_of_two'; break;
      }
      const p = rt.allocCString(s);
      strings.set(name, p);
      return p;
    },
    glGetUniformLocation: (p, namePtr) => {
      const loc = ctx().getUniformLocation(programs[p], rt.cstr(namePtr));
      return loc ? add(uniforms, loc) : -1;
    },
    glHint: (target, mode) => {
      if (target === 0x8192 /*GENERATE_MIPMAP_HINT*/) ctx().hint(target, mode);
    },
    glLinkProgram: (p) => {
      const g = ctx();
      g.linkProgram(programs[p]);
      if (!g.getProgramParameter(programs[p], g.LINK_STATUS))
        console.error('[gl] program link error:', g.getProgramInfoLog(programs[p]));
    },
    glLoadMatrixf: noop,
    glPixelStorei: (pname, param) => {
      if (pname === 0x0CF5) pixelUnpackAlignment = param;
      if (pname === 0x0D05) pixelPackAlignment = param;
      ctx().pixelStorei(pname, param);
    },
    glReadPixels: (x, y, w, h, format, type, ptr) => {
      const bpp = bytesPerPixel(format);
      const stride = Math.ceil(w * bpp / pixelPackAlignment) * pixelPackAlignment;
      ctx().readPixels(x, y, w, h, format, type, rt.u8().subarray(ptr, ptr + stride * h));
    },
    glShaderSource: (s, count, stringsPtr, lengthsPtr) => {
      const dv = rt.dv();
      let src = '';
      for (let i = 0; i < count; i++) {
        const p = dv.getUint32(stringsPtr + i * 4, true);
        const len = lengthsPtr ? dv.getInt32(lengthsPtr + i * 4, true) : -1;
        src += len >= 0 ? new TextDecoder().decode(rt.u8().subarray(p, p + len)) : rt.cstr(p);
      }
      ctx().shaderSource(shaders[s], translateShader(src, shaderInfo.get(s)));
    },
    glTexCoordPointer: noop,
    glTexEnvf: noop,
    glTexImage2D: (target, level, internal, w, h, border, format, type, ptr) => {
      ctx().texImage2D(target, level, internal, w, h, 0, format, type,
        imageData(w, h, format, type, ptr));
    },
    glTexImage2DMultisample: noop,
    glTexParameteri: (target, pname, param) => ctx().texParameteri(target, pname, param),
    glTexSubImage2D: (target, level, x, y, w, h, format, type, ptr) => {
      ctx().texSubImage2D(target, level, x, y, w, h, format, type,
        imageData(w, h, format, type, ptr));
    },
    glUniform1i: (loc, v) => { if (loc > 0) ctx().uniform1i(uniforms[loc], v); },
    glUniformMatrix3fv: (loc, count, transpose, ptr) => {
      if (loc <= 0) return;
      const f = new Float32Array(rt.u8().slice(ptr, ptr + 36 * count).buffer);
      ctx().uniformMatrix3fv(uniforms[loc], !!transpose, f);
    },
    glUseProgram: (p) => ctx().useProgram(programs[p] || null),
    glVertexAttribPointer: (index, size, type, normalized, stride, offset) =>
      ctx().vertexAttribPointer(index, size, type, !!normalized, stride, offset),
    glVertexPointer: noop,
    glViewport: (x, y, w, h) => ctx().viewport(x, y, w, h),
  };
  return api;
}
