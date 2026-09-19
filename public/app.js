/* NOKIFY — YouTube part -> Nokia monophonic ringtone */
'use strict';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const urlInput = $('urlInput'), loadBtn = $('loadBtn');
const segmentPanel = $('segmentPanel'), startSlider = $('startSlider'), startLabel = $('startLabel');
const nokifyBtn = $('nokifyBtn'), resultPanel = $('resultPanel');
const playToneBtn = $('playToneBtn'), playOrigBtn = $('playOrigBtn'), stopBtn = $('stopBtn'), copyBtn = $('copyBtn');
const rtttlOut = $('rtttlOut');
const ticker = $('lcdTitleTicker'), tickerText = $('lcdTickerText');
const softLeft = $('softLeft'), softRight = $('softRight');
const canvas = $('lcdCanvas'), ctx = canvas.getContext('2d');

// ---------- State ----------
const state = {
  video: null,          // { id, title, duration, thumbnail }
  clipDur: 10,
  clipStart: 0,
  clipBuffer: null,     // decoded AudioBuffer of the original part
  notes: null,          // [{ midi|null, cells }]  (null midi = rest)
  playing: null,        // { kind: 'tone'|'orig', startedAt, total, nodes:[] }
  busy: false,
};

const CELL_SEC = 0.125; // 16th note @ 120 BPM
let audioCtx = null;
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ---------- LCD ----------
const LCD_DARK = '#26301f', LCD_DIM = '#66754f', LCD_BG = '#9ead86';

function setTicker(text, scroll = false) {
  tickerText.textContent = text;
  ticker.classList.toggle('scroll', scroll);
}

function lcdClear() {
  ctx.fillStyle = LCD_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function lcdMessage(lines, opts = {}) {
  lcdClear();
  ctx.fillStyle = LCD_DARK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const arr = Array.isArray(lines) ? lines : [lines];
  const lineH = 26;
  const y0 = canvas.height / 2 - ((arr.length - 1) * lineH) / 2;
  arr.forEach((line, i) => {
    ctx.font = (i === 0 && !opts.uniform ? 'bold 20px' : 'bold 15px') + ' "Courier New", monospace';
    ctx.fillText(line, canvas.width / 2, y0 + i * lineH);
  });
}

function lcdIdle() {
  lcdClear();
  ctx.fillStyle = LCD_DARK;
  ctx.textAlign = 'center';
  ctx.font = 'bold 22px "Courier New", monospace';
  ctx.fillText('NOKIFY', canvas.width / 2, 58);
  ctx.font = 'bold 13px "Courier New", monospace';
  ctx.fillText('paste a link below', canvas.width / 2, 92);
  // little phone icon
  ctx.font = '28px "Courier New", monospace';
  ctx.fillText('☎', canvas.width / 2, 138);
}

// piano-roll of extracted notes, with optional playhead progress [0..1]
function lcdNotes(progress = -1) {
  const notes = state.notes;
  if (!notes || !notes.length) return;
  lcdClear();
  const totalCells = notes.reduce((s, n) => s + n.cells, 0);
  const w = canvas.width - 12, x0 = 6, top = 14, bottom = canvas.height - 34;
  const midis = notes.filter((n) => n.midi != null).map((n) => n.midi);
  const lo = Math.min(...midis) - 1, hi = Math.max(...midis) + 1;
  const yFor = (m) => bottom - ((m - lo) / Math.max(1, hi - lo)) * (bottom - top);
  const rowH = Math.max(4, Math.min(10, (bottom - top) / (hi - lo + 1)));

  // grid baseline
  ctx.fillStyle = LCD_DIM;
  for (let gx = 0; gx <= 8; gx++) ctx.fillRect(x0 + (w * gx) / 8, top, 1, bottom - top);

  let cell = 0;
  for (const n of notes) {
    const x = x0 + (cell / totalCells) * w;
    const nw = Math.max(2, (n.cells / totalCells) * w - 2);
    if (n.midi != null) {
      ctx.fillStyle = LCD_DARK;
      ctx.fillRect(x, yFor(n.midi) - rowH / 2, nw, rowH);
    }
    cell += n.cells;
  }
  // playhead
  if (progress >= 0) {
    ctx.fillStyle = LCD_DARK;
    ctx.fillRect(x0 + progress * w - 1, top - 8, 3, bottom - top + 12);
  }
  // caption: current note name
  ctx.fillStyle = LCD_DARK;
  ctx.font = 'bold 16px "Courier New", monospace';
  ctx.textAlign = 'center';
  let caption = `${midis.length ? notes.filter((n) => n.midi != null).length : 0} notes · ${(totalCells * CELL_SEC).toFixed(1)}s`;
  if (progress >= 0) {
    const cur = noteAtProgress(progress);
    caption = cur ? `♪ ${midiName(cur)}` : '· · ·';
  }
  ctx.fillText(caption, canvas.width / 2, canvas.height - 14);
}

function noteAtProgress(p) {
  const notes = state.notes;
  const totalCells = notes.reduce((s, n) => s + n.cells, 0);
  let cell = 0;
  for (const n of notes) {
    if (p * totalCells < cell + n.cells) return n.midi;
    cell += n.cells;
  }
  return null;
}

// ---------- helpers ----------
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
const midiFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function setBusy(b, label) {
  state.busy = b;
  loadBtn.disabled = b;
  nokifyBtn.disabled = b;
  nokifyBtn.textContent = b ? label || '…' : '☎ NOKIFY THIS PART';
}

// ---------- Step 1: load video info ----------
loadBtn.addEventListener('click', loadVideo);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadVideo(); });

async function loadVideo() {
  const url = urlInput.value.trim();
  if (!url) return;
  getCtx(); // unlock audio on user gesture
  setBusy(true);
  stopPlayback();
  resultPanel.classList.add('hidden');
  state.notes = null;
  setTicker('Connecting…');
  lcdMessage(['Connecting…', '', 'YouTube']);
  try {
    const r = await fetch('/api/info?url=' + encodeURIComponent(url));
    const info = await r.json();
    if (!r.ok) throw new Error(info.error || 'failed');
    state.video = info;
    state.clipStart = Math.min(state.clipStart, Math.max(0, info.duration - state.clipDur));
    startSlider.max = Math.max(0, Math.floor(info.duration - state.clipDur));
    startSlider.value = Math.floor(info.duration * 0.3); // songs usually get going ~1/3 in
    state.clipStart = Number(startSlider.value);
    startLabel.textContent = fmtTime(state.clipStart);
    setTicker(`${info.title} — ${info.channel}`, true);
    softRight.textContent = fmtTime(info.duration);
    segmentPanel.classList.remove('hidden');
    lcdMessage(['TRACK LOADED', '', 'pick a part', 'then NOKIFY'], { uniform: false });
  } catch (e) {
    setTicker('Error');
    lcdMessage(['ERROR', '', String(e.message).slice(0, 26)]);
  } finally {
    setBusy(false);
  }
}

// ---------- Step 2: segment picking ----------
startSlider.addEventListener('input', () => {
  state.clipStart = Number(startSlider.value);
  startLabel.textContent = fmtTime(state.clipStart);
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.clipDur = Number(chip.dataset.dur);
    if (state.video) {
      startSlider.max = Math.max(0, Math.floor(state.video.duration - state.clipDur));
      if (Number(startSlider.value) > Number(startSlider.max)) {
        startSlider.value = startSlider.max;
        state.clipStart = Number(startSlider.value);
        startLabel.textContent = fmtTime(state.clipStart);
      }
    }
  });
});

// ---------- Step 3: nokify ----------
nokifyBtn.addEventListener('click', nokify);

async function nokify() {
  if (!state.video || state.busy) return;
  getCtx();
  stopPlayback();
  setBusy(true, 'FETCHING…');
  lcdMessage(['Downloading', 'audio…', '', 'first time can', 'take a moment'], { uniform: true });
  setTicker('Downloading…');
  try {
    const r = await fetch(`/api/clip?id=${state.video.id}&start=${state.clipStart}&dur=${state.clipDur}`);
    if (!r.ok) throw new Error('audio fetch failed');
    const bytes = await r.arrayBuffer();
    setBusy(true, 'ANALYZING…');
    lcdMessage(['Analyzing', 'melody…'], { uniform: true });
    setTicker('Analyzing melody…');
    await new Promise((res) => setTimeout(res, 30)); // let LCD paint
    const ac = getCtx();
    state.clipBuffer = await ac.decodeAudioData(bytes.slice(0));
    const notes = await extractMelody(state.clipBuffer);
    if (!notes.some((n) => n.midi != null)) throw new Error('no melody found - try another part');
    state.notes = notes;
    rtttlOut.value = toRTTTL(notes, state.video.title);
    resultPanel.classList.remove('hidden');
    setTicker(`${state.video.title}`, true);
    lcdNotes();
    playTone();
  } catch (e) {
    lcdMessage(['ERROR', '', String(e.message).slice(0, 24), String(e.message).slice(24, 48)]);
    setTicker('Error');
  } finally {
    setBusy(false);
  }
}

// ---------- Melody extraction ----------
async function extractMelody(buffer) {
  // 1) bandpass to the melody range via offline render
  const off = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const src = off.createBufferSource();
  src.buffer = buffer;
  const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 170; hp.Q.value = 0.7;
  const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600; lp.Q.value = 0.7;
  const comp = off.createDynamicsCompressor();
  comp.threshold.value = -35; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.1;
  src.connect(hp).connect(lp).connect(comp).connect(off.destination);
  src.start();
  const filtered = (await off.startRendering()).getChannelData(0);
  const sr = buffer.sampleRate;

  // 2) frame-wise YIN pitch track
  const FRAME = 1024, HOP = 256;
  const nFrames = Math.max(0, Math.floor((filtered.length - FRAME) / HOP));
  const track = new Array(nFrames).fill(null);
  let rmsAll = 0;
  const rms = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let s = 0;
    const o = i * HOP;
    for (let j = 0; j < FRAME; j++) s += filtered[o + j] * filtered[o + j];
    rms[i] = Math.sqrt(s / FRAME);
    rmsAll += rms[i];
  }
  const rmsGate = Math.max(0.004, (rmsAll / nFrames) * 0.35);
  const frame = new Float32Array(FRAME);
  for (let i = 0; i < nFrames; i++) {
    if (rms[i] < rmsGate) continue;
    frame.set(filtered.subarray(i * HOP, i * HOP + FRAME));
    const f0 = yin(frame, sr, 100, 1100, 0.15);
    if (f0) track[i] = Math.round(69 + 12 * Math.log2(f0 / 440));
  }

  // 3) median filter (width 5) to kill octave/neighbor glitches
  const smooth = track.map((_, i) => {
    const win = [];
    for (let k = -2; k <= 2; k++) {
      const v = track[i + k];
      if (v != null) win.push(v);
    }
    if (track[i] == null || win.length < 3) return track[i] == null ? null : track[i];
    win.sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });

  // 4) quantize to a 16th-note grid (125 ms cells), majority vote per cell
  const framesPerCell = (CELL_SEC * sr) / HOP;
  const nCells = Math.floor(nFrames / framesPerCell);
  const cells = [];
  for (let c = 0; c < nCells; c++) {
    const a = Math.floor(c * framesPerCell), b = Math.floor((c + 1) * framesPerCell);
    const counts = new Map();
    let voiced = 0, total = 0;
    for (let i = a; i < b && i < nFrames; i++) {
      total++;
      const m = smooth[i];
      if (m == null) continue;
      voiced++;
      counts.set(m, (counts.get(m) || 0) + 1);
    }
    if (!total || voiced / total < 0.4) { cells.push(null); continue; }
    let best = null, bestN = 0;
    for (const [m, n] of counts) if (n > bestN) { best = m; bestN = n; }
    cells.push(best);
  }

  // 5) merge runs into notes, drop 1-cell blips surrounded by same pitch
  for (let i = 1; i < cells.length - 1; i++) {
    if (cells[i] !== cells[i - 1] && cells[i - 1] === cells[i + 1] && cells[i - 1] != null) cells[i] = cells[i - 1];
  }
  let notes = [];
  for (const m of cells) {
    const last = notes[notes.length - 1];
    if (last && last.midi === m) last.cells++;
    else notes.push({ midi: m, cells: 1 });
  }
  // trim leading/trailing rests
  while (notes.length && notes[0].midi == null) notes.shift();
  while (notes.length && notes[notes.length - 1].midi == null) notes.pop();

  // 6) transpose to Nokia's happy register (median ≈ A5) and clamp octaves 4..7
  const voicedNotes = notes.filter((n) => n.midi != null).map((n) => n.midi).sort((a, b) => a - b);
  if (voicedNotes.length) {
    const median = voicedNotes[Math.floor(voicedNotes.length / 2)];
    const shift = Math.round((81 - median) / 12) * 12;
    notes = notes.map((n) => {
      if (n.midi == null) return n;
      let m = n.midi + shift;
      while (m < 57) m += 12;   // A3 floor
      while (m > 100) m -= 12;  // E7 ceiling
      return { midi: m, cells: n.cells };
    });
  }
  return notes;
}

// YIN pitch detector -> frequency in Hz or null
function yin(frame, sr, fmin, fmax, threshold) {
  const tauMin = Math.floor(sr / fmax);
  const tauMax = Math.min(Math.floor(sr / fmin), frame.length >> 1);
  const N = frame.length;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < N - tauMax; i++) {
      const diff = frame[i] - frame[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running ? (d[tau] * tau) / running : 1;
  }
  let tauEst = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEst = tau;
      break;
    }
  }
  if (tauEst < 0) {
    let best = tauMin;
    for (let tau = tauMin; tau <= tauMax; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
    if (cmnd[best] > 0.32) return null;
    tauEst = best;
  }
  // parabolic interpolation around the dip
  const t = tauEst;
  const x0 = t > 1 ? cmnd[t - 1] : cmnd[t];
  const x2 = t < tauMax ? cmnd[t + 1] : cmnd[t];
  const denom = x0 + x2 - 2 * cmnd[t];
  const tBetter = denom !== 0 ? t + (x0 - x2) / (2 * denom) : t;
  return sr / tBetter;
}

// ---------- RTTTL export ----------
function toRTTTL(notes, title) {
  const name = (title || 'nokify').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 10) || 'nokify';
  const parts = [];
  for (const n of notes) {
    let cells = n.cells;
    // decompose runs into RTTTL durations: cells of 16ths
    const chunks = [];
    const table = [[16, '1'], [12, '2.'], [8, '2'], [6, '4.'], [4, '4'], [3, '8.'], [2, '8'], [1, '16']];
    while (cells > 0) {
      for (const [c, dur] of table) {
        if (cells >= c) { chunks.push(dur); cells -= c; break; }
      }
    }
    for (const dur of chunks) {
      if (n.midi == null) { parts.push(`${dur}p`); continue; }
      const nm = NOTE_NAMES[n.midi % 12].toLowerCase().replace('#', '#');
      const oct = Math.floor(n.midi / 12) - 1;
      parts.push(`${dur}${nm}${Math.min(7, Math.max(4, oct))}`);
    }
  }
  return `${name}:d=16,o=5,b=120:${parts.join(',')}`;
}

// ---------- Playback ----------
playToneBtn.addEventListener('click', playTone);
playOrigBtn.addEventListener('click', playOriginal);
stopBtn.addEventListener('click', stopPlayback);
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(rtttlOut.value);
    softLeft.textContent = 'Copied!';
    setTimeout(() => (softLeft.textContent = 'Menu'), 1500);
  } catch {
    rtttlOut.select();
    document.execCommand('copy');
  }
});

function stopPlayback() {
  if (!state.playing) return;
  for (const node of state.playing.nodes) {
    try { node.stop ? node.stop() : node.disconnect(); } catch {}
  }
  state.playing = null;
  if (state.notes) lcdNotes();
}

function playTone() {
  if (!state.notes) return;
  stopPlayback();
  const ac = getCtx();
  const t0 = ac.currentTime + 0.08;

  // Nokia voice: square wave -> tiny-speaker bandpass -> master gain
  const master = ac.createGain();
  master.gain.value = 0.16;
  const speaker = ac.createBiquadFilter();
  speaker.type = 'lowpass'; speaker.frequency.value = 5200; speaker.Q.value = 0.5;
  master.connect(speaker).connect(ac.destination);

  const osc = ac.createOscillator();
  osc.type = 'square';
  const env = ac.createGain();
  env.gain.value = 0;
  osc.connect(env).connect(master);

  let t = t0;
  for (const n of state.notes) {
    const dur = n.cells * CELL_SEC;
    if (n.midi != null) {
      osc.frequency.setValueAtTime(midiFreq(n.midi), t);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(1, t + 0.004);
      env.gain.setValueAtTime(1, t + dur - 0.028); // Nokia staccato gap between notes
      env.gain.linearRampToValueAtTime(0, t + dur - 0.012);
    }
    t += dur;
  }
  osc.start(t0);
  osc.stop(t + 0.05);
  state.playing = { kind: 'tone', startedAt: t0, total: t - t0, nodes: [osc, env, master] };
  osc.onended = () => { if (state.playing && state.playing.kind === 'tone') stopPlayback(); };
  animatePlayhead();
}

function playOriginal() {
  if (!state.clipBuffer) return;
  stopPlayback();
  const ac = getCtx();
  const src = ac.createBufferSource();
  src.buffer = state.clipBuffer;
  const g = ac.createGain();
  g.gain.value = 0.9;
  src.connect(g).connect(ac.destination);
  const t0 = ac.currentTime + 0.05;
  src.start(t0);
  state.playing = { kind: 'orig', startedAt: t0, total: state.clipBuffer.duration, nodes: [src, g] };
  src.onended = () => { if (state.playing && state.playing.kind === 'orig') stopPlayback(); };
  animatePlayhead();
}

function animatePlayhead() {
  if (!state.playing || !state.notes) return;
  const { startedAt, total } = state.playing;
  const p = (getCtx().currentTime - startedAt) / total;
  if (p >= 1) return;
  lcdNotes(Math.max(0, Math.min(1, p)));
  requestAnimationFrame(animatePlayhead);
}

// ---------- boot ----------
lcdIdle();
