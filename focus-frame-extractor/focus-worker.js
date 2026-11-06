/* Focus Frame Extractor — decoding and scoring worker.
 * Runs ffmpeg (WebAssembly build) to decode any video ffmpeg understands,
 * streams raw grayscale frames into JavaScript through a virtual device,
 * and scores each frame for sharpness. */
'use strict';

let core = null;          // ffmpeg core module
let FS = null;
let inputPath = null;     // path of the mounted video
let info = null;          // probe result
let sink = null;          // receives bytes written to /dev/frames
let logLines = [];

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

/* ---------- engine ---------- */

async function loadEngine(base) {
  importScripts(new URL('ffmpeg-core.js', base).href);
  const res = await fetch(new URL('ffmpeg-core.gz.wasm', base).href);
  if (!res.ok) throw new Error('Could not download the video decoder (HTTP ' + res.status + ').');
  const total = Number(res.headers.get('content-length')) || 10220341;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    post({ type: 'engine-progress', loaded: got, total });
  }
  let bytes = concat(chunks, got);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  core = await self.createFFmpegCore({ wasmBinary: bytes.buffer });
  FS = core.FS;
  core.setLogger(({ message }) => { logLines.push(message); if (logLines.length > 400) logLines.shift(); });
  core.setProgress(() => {});
  // A character device: everything ffmpeg writes to /dev/frames lands in `sink`.
  const dev = FS.makedev(64, 0);
  FS.registerDevice(dev, {
    open() {}, close() {},
    read() { return 0; },
    write(stream, buffer, offset, length) { if (sink) sink(buffer.subarray(offset, offset + length)); return length; },
    llseek(stream, offset) { return offset; },
  });
  FS.mkdev('/dev/frames', 0o666, dev);
  FS.mkdir('/work');
}

function concat(chunks, len) {
  const out = new Uint8Array(len); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function ffmpeg(args) {
  logLines = [];
  core.setTimeout(-1);
  core.exec(...args);
  const ret = core.ret;
  core.reset();
  return ret;
}

function lastLog(n = 6) {
  return logLines.filter((l) => l && !/^\s*(built with|configuration:|lib\w+\s+\d)/.test(l)).slice(-n).join('\n');
}

/* ---------- open + probe ---------- */

function mountFile(file) {
  try { FS.unmount('/in'); } catch (e) {}
  try { FS.rmdir('/in'); } catch (e) {}
  FS.mkdir('/in');
  const safeName = 'input' + (/\.[a-z0-9]{1,5}$/i.exec(file.name) || [''])[0].toLowerCase();
  const f = new File([file], safeName, { type: file.type });
  FS.mount(FS.filesystems.WORKERFS, { files: [f] }, '/in');
  inputPath = '/in/' + safeName;
}

function parseRate(s) {
  if (!s || s === '0/0') return 0;
  const [a, b] = String(s).split('/').map(Number);
  return b ? a / b : a;
}

function probe(fileName, fileSize) {
  try { FS.unlink('/work/probe.json'); } catch (e) {}
  logLines = [];
  core.ffprobe('-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
    '-select_streams', 'v:0', '-o', '/work/probe.json', inputPath);
  core.reset();
  let j;
  try { j = JSON.parse(FS.readFile('/work/probe.json', { encoding: 'utf8' })); }
  catch (e) { throw new Error('This file could not be read as a video. ' + lastLog(3)); }
  const s = (j.streams || [])[0];
  if (!s) throw new Error('No video stream was found in this file.');
  const fmt = j.format || {};
  let rotation = 0;
  for (const sd of s.side_data_list || []) if (sd.rotation != null) rotation = Number(sd.rotation);
  if (s.tags && s.tags.rotate) rotation = Number(s.tags.rotate);
  let w = s.width, h = s.height;
  if (Math.abs(rotation) % 180 === 90) [w, h] = [h, w];
  const rFps = parseRate(s.r_frame_rate), aFps = parseRate(s.avg_frame_rate);
  const fps = aFps || rFps || 30;
  const duration = Number(s.duration) || Number(fmt.duration) || 0;
  let frames = Number(s.nb_frames) || 0;
  let frameCountSource = 'header';
  if (!frames) { frames = Math.round(duration * fps); frameCountSource = 'estimate'; }
  const startTime = Number(s.start_time) || 0;
  info = {
    name: fileName, size: fileSize, width: w, height: h, codedWidth: s.width, codedHeight: s.height,
    codec: s.codec_long_name || s.codec_name, codecName: s.codec_name, tag: s.codec_tag_string,
    pixFmt: s.pix_fmt, container: fmt.format_long_name || fmt.format_name,
    fps, rFps, aFps, rRate: s.r_frame_rate, aRate: s.avg_frame_rate, timeBase: s.time_base,
    vfr: rFps && aFps ? Math.abs(rFps - aFps) / rFps > 0.01 : false,
    duration, frames, frameCountSource, startTime, bitRate: Number(s.bit_rate) || Number(fmt.bit_rate) || 0,
    rotation,
  };
  return info;
}

/* ---------- streaming helper ---------- */

// Run ffmpeg with output to /dev/frames and hand back each complete frame.
function streamFrames(preInput, filters, pixFmt, bytesPerFrame, onFrame, outArgs) {
  const buf = new Uint8Array(bytesPerFrame); let fill = 0; let count = 0;
  sink = (chunk) => {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(bytesPerFrame - fill, chunk.length - off);
      buf.set(chunk.subarray(off, off + n), fill);
      fill += n; off += n;
      if (fill === bytesPerFrame) { onFrame(buf, count++); fill = 0; }
    }
  };
  const args = [...preInput, '-i', inputPath, '-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough'];
  if (filters) args.push('-vf', filters);
  if (outArgs) args.push(...outArgs);
  args.push('-f', 'rawvideo', '-pix_fmt', pixFmt, '-y', '/dev/frames');
  const ret = ffmpeg(args);
  sink = null;
  if (ret !== 0 && count === 0) throw new Error('The decoder stopped with an error.\n' + lastLog());
  return count;
}

/* ---------- single frame preview ---------- */

function grabFrame(index) {
  const W = info.width, H = info.height;
  const t = Math.max(0, info.startTime + (index - 0.25) / info.fps);
  let out = null;
  const pre = ['-ss', t.toFixed(6)];
  const n = streamFrames(pre, null, 'rgba', W * H * 4, (b) => { if (!out) out = b.slice(); }, ['-frames:v', '1']);
  // Fall back to the last frame if seeking past the end.
  if (!out || n === 0) {
    const t2 = Math.max(0, info.startTime + info.duration - 2 / info.fps);
    streamFrames(['-ss', t2.toFixed(6)], null, 'rgba', W * H * 4, (b) => { out = b.slice(); }, ['-frames:v', '1']);
  }
  if (!out) throw new Error('Could not decode that frame.');
  return out;
}

/* ---------- background model ---------- */

function buildBackground(onProgress) {
  const W = info.width, H = info.height, N = W * H;
  const MAX = 48;
  let samples = []; let stride = 1; let seen = 0;
  const keep = (b) => {
    if (seen % stride === 0) {
      samples.push(b.slice());
      if (samples.length > MAX) { samples = samples.filter((_, i) => i % 2 === 0); stride *= 2; }
    }
    seen++;
    if (seen % 10 === 0) onProgress(seen);
  };
  streamFrames(['-skip_frame', 'nokey'], null, 'gray', N, keep);
  if (samples.length < 12) {
    // Few keyframes: sample evenly from the full decode instead.
    samples = []; stride = 1; seen = 0;
    const step = Math.max(1, Math.floor(info.frames / MAX));
    streamFrames([], `select='not(mod(n\\,${step}))'`, 'gray', N, keep);
  }
  const k = samples.length;
  const bg = new Uint8Array(N);
  const col = new Uint8Array(k);
  const mid = k >> 1;
  for (let p = 0; p < N; p++) {
    for (let s = 0; s < k; s++) col[s] = samples[s][p];
    col.sort();
    bg[p] = col[mid];
  }
  return { bg, count: k };
}

/* ---------- sharpness scoring ---------- */

function makeScorer(W, H, roi, bg, kFrac) {
  const x0 = Math.max(1, roi ? roi.x : 1), y0 = Math.max(1, roi ? roi.y : 1);
  const x1 = Math.min(W - 1, roi ? roi.x + roi.w : W - 1), y1 = Math.min(H - 1, roi ? roi.y + roi.h : H - 1);
  const px = Math.max(1, (x1 - x0) * (y1 - y0));
  const K = Math.max(32, Math.round(px * kFrac));
  const D = new Int16Array(W * H);
  const LA = new Uint16Array(W * H);   // |Laplacian| per pixel, reused for subject tracking
  const histL = new Uint32Array(4096), histS = new Uint32Array(4096);
  const topMean = (hist) => {
    let need = K, sum = 0;
    for (let v = 4095; v >= 0 && need > 0; v--) {
      const c = hist[v]; if (!c) continue;
      const take = c < need ? c : need; sum += take * v; need -= take;
    }
    return sum / (K - need);
  };
  // Strong-edge pixels of the current frame, used to locate the subject.
  const MAXP = Math.max(4096, K * 8);
  const PX = new Uint16Array(MAXP), PY = new Uint16Array(MAXP), PW = new Uint16Array(MAXP);
  const CELL = 16, GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL);
  const grid = new Float64Array(GW * GH);
  const R = Math.max(48, Math.round(0.08 * Math.max(x1 - x0, y1 - y0)));
  // Find the densest 5x5-cell cluster of strong edges, then take the weighted centroid of
  // edge pixels within R of it (twice, re-centering). Stray edges elsewhere are ignored.
  const locate = (np) => {
    if (!np) return [NaN, NaN];
    grid.fill(0);
    for (let k = 0; k < np; k++) grid[((PY[k] / CELL) | 0) * GW + ((PX[k] / CELL) | 0)] += PW[k];
    let best = -1, bx = 0, by = 0;
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) { const yy = gy + dy; if (yy < 0 || yy >= GH) continue;
        for (let dx = -2; dx <= 2; dx++) { const xx = gx + dx; if (xx >= 0 && xx < GW) sum += grid[yy * GW + xx]; } }
      if (sum > best) { best = sum; bx = gx; by = gy; }
    }
    let cx = (bx + .5) * CELL, cy = (by + .5) * CELL;
    for (let it = 0; it < 2; it++) {
      let sw = 0, sx = 0, sy = 0; const r2 = R * R;
      for (let k = 0; k < np; k++) { const dx = PX[k] - cx, dy = PY[k] - cy;
        if (dx * dx + dy * dy <= r2) { const w = PW[k]; sw += w; sx += w * PX[k]; sy += w * PY[k]; } }
      if (!sw) break; cx = sx / sw; cy = sy / sw;
    }
    return [cx, cy];
  };
  return (g) => {
    const ya = y0 - 1, yb = y1 + 1, xa = x0 - 1, xb = x1 + 1;
    for (let y = ya; y < yb; y++) {
      let i = y * W + xa; const e = y * W + xb;
      if (bg) for (; i < e; i++) D[i] = g[i] - bg[i];
      else for (; i < e; i++) D[i] = g[i];
    }
    histL.fill(0); histS.fill(0);
    for (let y = y0; y < y1; y++) {
      const r = y * W;
      for (let i = r + x0, e = r + x1; i < e; i++) {
        const c = D[i], l = D[i - 1], rr = D[i + 1], u = D[i - W], d = D[i + W];
        let lap = l + rr + u + d - 4 * c; if (lap < 0) lap = -lap;
        LA[i] = lap; histL[lap > 4095 ? 4095 : lap]++;
        const ul = D[i - W - 1], ur = D[i - W + 1], dl = D[i + W - 1], dr = D[i + W + 1];
        let gx = (ur + 2 * rr + dr) - (ul + 2 * l + dl); if (gx < 0) gx = -gx;
        let gy = (dl + 2 * d + dr) - (ul + 2 * u + ur); if (gy < 0) gy = -gy;
        const s = gx + gy;
        histS[s > 4095 ? 4095 : s]++;
      }
    }
    // Subject position: |Laplacian|-weighted centroid of the same strongest pixels that set the score.
    let need = K, cut = 0;
    for (let v = 4095; v >= 0; v--) { need -= histL[v]; if (need <= 0) { cut = v; break; } }
    if (cut < 1) cut = 1;
    let np = 0;
    for (let y = y0; y < y1 && np < MAXP; y++) {
      const r = y * W;
      for (let x = x0, i = r + x0; x < x1; x++, i++) {
        const a = LA[i];
        if (a >= cut) { PX[np] = x; PY[np] = y; PW[np] = a; if (++np >= MAXP) break; }
      }
    }
    const [cx, cy] = locate(np);
    return [topMean(histL), topMean(histS) / 4, cx, cy];
  };
}

function analyze({ roi, bgSub, kFrac }) {
  const W = info.width, H = info.height, N = W * H;
  const t0 = performance.now();
  let bg = null, bgCount = 0;
  if (bgSub) {
    post({ type: 'progress', phase: 'background', done: 0, total: 0 });
    const r = buildBackground((n) => post({ type: 'progress', phase: 'background', done: n, total: 0 }));
    bg = r.bg; bgCount = r.count;
  }
  const scorer = makeScorer(W, H, roi, bg, kFrac);
  let cap = Math.max(16, Math.ceil(info.frames * 1.05) + 16);
  let lap = new Float32Array(cap), sob = new Float32Array(cap), cx = new Float32Array(cap), cy = new Float32Array(cap);
  const grow = (arr) => { const a = new Float32Array(cap); a.set(arr); return a; };
  let lastPost = 0;
  const t1 = performance.now();
  const n = streamFrames([], null, 'gray', N, (g, i) => {
    if (i >= cap) {
      cap *= 2;
      lap = grow(lap); sob = grow(sob); cx = grow(cx); cy = grow(cy);
    }
    const s = scorer(g); lap[i] = s[0]; sob[i] = s[1]; cx[i] = s[2]; cy[i] = s[3];
    const now = performance.now();
    if (now - lastPost > 120) {
      lastPost = now;
      post({ type: 'progress', phase: 'score', done: i + 1, total: info.frames, elapsed: (now - t1) / 1000 });
    }
  });
  if (n === 0) throw new Error('No frames could be decoded.\n' + lastLog());
  const lapOut = lap.slice(0, n), sobOut = sob.slice(0, n), cxOut = cx.slice(0, n), cyOut = cy.slice(0, n);
  const msg = { type: 'scores', lap: lapOut, sob: sobOut, cx: cxOut, cy: cyOut, frames: n, seconds: (performance.now() - t0) / 1000,
    bgCount, bg: bg ? bg.slice() : null };
  post(msg, [lapOut.buffer, sobOut.buffer, cxOut.buffer, cyOut.buffer].concat(msg.bg ? [msg.bg.buffer] : []));
}

/* ---------- export ---------- */

function rangesOf(indices) {
  const out = []; let s = indices[0], p = indices[0];
  for (let k = 1; k <= indices.length; k++) {
    const v = indices[k];
    if (v === p + 1) { p = v; continue; }
    out.push([s, p]); s = p = v;
  }
  return out;
}

function selectExpr(indices) {
  return rangesOf(indices).map(([a, b]) => (a === b ? `eq(n\\,${a})` : `between(n\\,${a}\\,${b})`)).join('+');
}

function clearWork() {
  for (const name of FS.readdir('/work')) if (name !== '.' && name !== '..') { try { FS.unlink('/work/' + name); } catch (e) {} }
}

function exportFrames({ indices, format, quality, csv, extraFiles, baseName, fps }) {
  clearWork();
  const sel = selectExpr(indices);
  const total = indices.length;
  // Count progress by watching files appear (images) or via frame messages from ffmpeg's log.
  let lastPost = 0;
  core.setLogger(({ message }) => {
    logLines.push(message); if (logLines.length > 400) logLines.shift();
    const m = /frame=\s*(\d+)/.exec(message);
    const now = performance.now();
    if (m && now - lastPost > 150) { lastPost = now; post({ type: 'progress', phase: 'export', done: Math.min(total, +m[1]), total }); }
  });
  try {
    post({ type: 'progress', phase: 'export', done: 0, total });
    if (format === 'mp4') {
      const out = '/work/out.mp4';
      const outFps = fps || info.fps;
      const ret = ffmpeg(['-i', inputPath, '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', `select='${sel}',setpts=N/(${outFps.toFixed(6)}*TB),scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
        '-fps_mode', 'passthrough', '-r', String(outFps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(quality || 18),
        '-movflags', '+faststart', '-stats_period', '0.25', '-y', out]);
      let data;
      try { data = FS.readFile(out); } catch (e) { throw new Error('The video could not be encoded.\n' + lastLog()); }
      if (ret !== 0 && data.length < 1000) throw new Error('The video could not be encoded.\n' + lastLog());
      FS.unlink(out);
      return { name: baseName + '_in_focus.mp4', data };
    }
    const ext = format === 'png' ? 'png' : 'jpg';
    const codecArgs = ext === 'png' ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', String(quality || 2), '-pix_fmt', 'yuvj444p'];
    ffmpeg(['-i', inputPath, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `select='${sel}'`,
      '-fps_mode', 'passthrough', ...codecArgs, '-stats_period', '0.25', '-start_number', '0', '-y', `/work/f_%07d.${ext}`]);
    const files = FS.readdir('/work').filter((n) => n.startsWith('f_')).sort();
    if (!files.length) throw new Error('No frames were written.\n' + lastLog());
    const zip = new ZipWriter();
    const fpsv = info.fps;
    files.forEach((fname, k) => {
      const idx = k < indices.length ? indices[k] : -1;
      const label = idx >= 0 ? `frame_${String(idx).padStart(6, '0')}_t${(idx / fpsv).toFixed(3)}s` : `extra_${k}`;
      zip.add(`${baseName}_in_focus/${label}.${ext}`, FS.readFile('/work/' + fname));
      FS.unlink('/work/' + fname);
      if (k % 20 === 0) post({ type: 'progress', phase: 'zip', done: k + 1, total: files.length });
    });
    if (csv) zip.add(`${baseName}_in_focus/focus_scores.csv`, new TextEncoder().encode(csv));
    for (const f of extraFiles || []) zip.add(`${baseName}_in_focus/${f.name}`, new TextEncoder().encode(f.text));
    return { name: baseName + '_in_focus.zip', data: zip.finish(), count: files.length };
  } finally {
    core.setLogger(({ message }) => { logLines.push(message); if (logLines.length > 400) logLines.shift(); });
  }
}

/* ---------- one clip per in-focus block ---------- */

// Encode frames a..b as an H.264 MP4 using a fast seek to the block start.
function encodeClip(a, b, outFps, crf) {
  const out = '/work/clip.mp4';
  try { FS.unlink(out); } catch (e) {}
  const t = Math.max(0, info.startTime + (a - 0.25) / info.fps);
  const n = b - a + 1;
  const ret = ffmpeg(['-ss', t.toFixed(6), '-i', inputPath, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', String(n),
    '-vf', `setpts=N/(${outFps.toFixed(6)}*TB),scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
    '-fps_mode', 'passthrough', '-r', String(outFps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf || 18),
    '-movflags', '+faststart', '-y', out]);
  let data;
  try { data = FS.readFile(out); } catch (e) { data = null; }
  if (!data || (ret !== 0 && data.length < 1000)) throw new Error(`Block starting at frame ${a} could not be encoded.\n` + lastLog());
  FS.unlink(out);
  return data;
}

function exportClips({ blocks, speed, crf, extraFiles, baseName, single }) {
  clearWork();
  const outFps = info.fps * (speed || 1);
  if (single) {
    const g = blocks[0];
    return { name: g.name, data: encodeClip(g.a, g.b, outFps, crf), count: 1 };
  }
  // One decode + one encoder for every block: select the block frames, force a keyframe at
  // the first frame of each block, and let the segment muxer cut a new file there.
  const indices = [];
  for (const g of blocks) for (let i = g.a; i <= g.b; i++) indices.push(i);
  const starts = []; let acc = 0;
  for (const g of blocks) { starts.push(acc); acc += g.b - g.a + 1; }
  const total = acc;
  let lastPost = 0;
  core.setLogger(({ message }) => {
    logLines.push(message); if (logLines.length > 400) logLines.shift();
    const m = /frame=\s*(\d+)/.exec(message); const now = performance.now();
    if (m && now - lastPost > 150) { lastPost = now; post({ type: 'progress', phase: 'export', done: Math.min(total, +m[1]), total }); }
  });
  try {
    post({ type: 'progress', phase: 'export', done: 0, total });
    ffmpeg(['-i', inputPath, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', `select='${selectExpr(indices)}',setpts=N/(${outFps.toFixed(6)}*TB),scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
      '-fps_mode', 'passthrough', '-r', String(outFps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf || 18),
      '-force_key_frames', 'expr:' + starts.map((n) => `eq(n,${n})`).join('+'),
      '-f', 'segment', '-segment_frames', starts.slice(1).join(',') || String(total + 1), '-reset_timestamps', '1',
      '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart', '-stats_period', '0.25',
      '-y', '/work/seg_%04d.mp4']);
  } finally {
    core.setLogger(({ message }) => { logLines.push(message); if (logLines.length > 400) logLines.shift(); });
  }
  const files = FS.readdir('/work').filter((n) => n.startsWith('seg_')).sort();
  if (files.length !== blocks.length) throw new Error(`Expected ${blocks.length} clips but the encoder produced ${files.length}.\n` + lastLog());
  const zip = new ZipWriter();
  files.forEach((f, k) => {
    zip.add(`${baseName}_block_clips/${blocks[k].name}`, FS.readFile('/work/' + f));
    FS.unlink('/work/' + f);
    post({ type: 'progress', phase: 'zip', done: k + 1, total: files.length });
  });
  for (const f of extraFiles || []) zip.add(`${baseName}_block_clips/${f.name}`, new TextEncoder().encode(f.text));
  return { name: baseName + '_block_clips.zip', data: zip.finish(), count: blocks.length };
}

/* ---------- minimal ZIP (stored) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(d) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; this.count = 0; }
  add(name, data) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, this.offset, true);
    this.parts.push(new Uint8Array(lh.buffer), nameBytes, data);
    this.central.push(new Uint8Array(ch.buffer), nameBytes);
    this.offset += 30 + nameBytes.length + data.length; this.count++;
  }
  finish() {
    const cdSize = this.central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, this.count, true); end.setUint16(10, this.count, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
}

/* ---------- message loop ---------- */

let queue = Promise.resolve();
self.onmessage = (ev) => {
  const m = ev.data;
  queue = queue.then(async () => {
    try {
      if (m.type === 'init') { await loadEngine(m.base); post({ type: 'ready' }); }
      else if (m.type === 'open') { mountFile(m.file); post({ type: 'info', info: probe(m.file.name, m.file.size) }); }
      else if (m.type === 'frame') {
        const rgba = grabFrame(m.index);
        post({ type: 'frame', id: m.id, index: m.index, width: info.width, height: info.height, rgba }, [rgba.buffer]);
      }
      else if (m.type === 'analyze') analyze(m);
      else if (m.type === 'export') {
        const r = m.format === 'clips' || m.format === 'clip' ? exportClips({ ...m, single: m.format === 'clip' }) : exportFrames(m);
        const blob = r.data instanceof Blob ? r.data : new Blob([r.data]);
        post({ type: 'exported', name: r.name, blob, size: blob.size, count: r.count || m.indices.length, format: m.format, heap: core.HEAPU8 ? core.HEAPU8.length : 0 });
      }
    } catch (e) {
      post({ type: 'error', op: m.type, id: m.id, message: (e && e.message) || String(e) });
    }
  });
};
