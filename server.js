const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3990;
const CACHE_DIR = path.join(__dirname, 'cache');
const MAX_VIDEO_SECONDS = 15 * 60;
const MAX_CLIP_SECONDS = 20;

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
    });
  });
}

function extractVideoId(url) {
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

// GET /api/info?url=...  -> { id, title, duration, thumbnail, channel }
app.get('/api/info', async (req, res) => {
  const id = extractVideoId(req.query.url || '');
  if (!id) return res.status(400).json({ error: 'That does not look like a YouTube link.' });
  try {
    const out = await run('python', [
      '-m', 'yt_dlp',
      '--dump-single-json', '--no-playlist', '--skip-download',
      `https://www.youtube.com/watch?v=${id}`,
    ]);
    const info = JSON.parse(out);
    if (info.duration > MAX_VIDEO_SECONDS) {
      return res.status(400).json({ error: 'Video is too long (max 15 min).' });
    }
    res.json({
      id,
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
      channel: info.channel || info.uploader || '',
    });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Could not read video info. Is the link valid?' });
  }
});

// One download at a time per video id
const downloads = new Map();

function findCached(id) {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith(id + '.'));
  return files.length ? path.join(CACHE_DIR, files[0]) : null;
}

function ensureAudio(id) {
  const cached = findCached(id);
  if (cached) return Promise.resolve(cached);
  if (downloads.has(id)) return downloads.get(id);
  const p = run('python', [
    '-m', 'yt_dlp',
    '-f', 'bestaudio/best',
    '--no-playlist', '--no-progress',
    '-o', path.join(CACHE_DIR, `${id}.%(ext)s`),
    `https://www.youtube.com/watch?v=${id}`,
  ])
    .then(() => {
      const file = findCached(id);
      if (!file) throw new Error('download finished but file missing');
      return file;
    })
    .finally(() => downloads.delete(id));
  downloads.set(id, p);
  return p;
}

// GET /api/clip?id=...&start=...&dur=...  -> mono 22050 Hz WAV
app.get('/api/clip', async (req, res) => {
  const id = String(req.query.id || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: 'bad id' });
  const start = Math.max(0, Number(req.query.start) || 0);
  const dur = Math.min(MAX_CLIP_SECONDS, Math.max(2, Number(req.query.dur) || 10));
  try {
    const audioFile = await ensureAudio(id);
    res.setHeader('Content-Type', 'audio/wav');
    const ff = spawn(
      'ffmpeg',
      ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', audioFile,
       '-ac', '1', '-ar', '22050', '-f', 'wav', 'pipe:1'],
      { windowsHide: true }
    );
    ff.stdout.pipe(res);
    let ffErr = '';
    ff.stderr.on('data', (d) => (ffErr += d));
    ff.on('close', (code) => {
      if (code !== 0) {
        console.error('ffmpeg:', ffErr.slice(-500));
        if (!res.headersSent) res.status(500).end();
        else res.end();
      }
    });
    req.on('close', () => ff.kill());
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Could not fetch audio for this video.' });
  }
});

app.listen(PORT, () => console.log(`Nokify running on http://localhost:${PORT}`));
