# Nokify

Turn any YouTube song into a **monophonic Nokia ringtone** — a real RTTTL string you
can paste into a ringtone editor, a dumbphone, or an Arduino buzzer.

Paste a link, scrub to the hook, hit **NOKIFY**. The melody is transcribed in your
browser and comes back as the one-line format Nokia shipped in 1998:

```
Take On Me:d=16,o=5,b=120:f#,f#,d,8b4,8p,8b4,8p,8e,8p,8e,8p,8e,8g#,8g#,8a,8b
```

No API keys, no model weights, no upload of your own files. The pitch detection runs
entirely client-side in Web Audio.

---

## How it works

```
YouTube URL
     │
     ▼  server: python -m yt_dlp        (metadata + cached audio, ≤15 min videos)
     │
     ▼  you scrub a start point, pick 2–20s
     │
     ▼  server: ffmpeg -ss/-t → mono 22.05 kHz WAV, streamed (never written to disk)
     │
     ▼  browser: decodeAudioData → OfflineAudioContext
     │
     ▼  YIN pitch tracking, 100–1100 Hz, threshold 0.15
     │
     ▼  quantize to a 16th-note grid (125 ms cells @ 120 BPM)
     │    majority vote per cell, cell is a rest if <40% of frames are voiced
     │
     ▼  merge equal-pitch runs into notes, drop 1-cell blips between identical pitches
     │
     ▼  RTTTL string  +  A/B playback (square-wave tone vs. the original clip)
```

The server is 126 lines and does exactly two things: fetch and cut. Everything musical
happens in [`public/app.js`](public/app.js).

### Why YIN

Autocorrelation alone octave-errors badly on real mixes. YIN's cumulative mean
normalized difference function suppresses the sub-harmonic dip that makes a melody jump
down an octave mid-phrase. It is still monophonic — it tracks the loudest periodic
component, so it locks onto a lead vocal or lead synth and ignores the pad underneath.
That limitation is the point: a Nokia ringtone *is* monophonic.

### Why a 16th grid at 120 BPM

RTTTL only encodes durations as fractions of a beat. Snapping to fixed 125 ms cells
means every detected note lands on a legal RTTTL duration without a tempo-estimation
step that would be wrong half the time on a 10-second excerpt. Songs far from 120 BPM
still transcribe — the note *lengths* quantize, the *pitches* don't care.

---

## Running it

**Requirements**

- Node 18+
- Python with `yt-dlp` — `pip install yt-dlp` (called as `python -m yt_dlp`)
- `ffmpeg` on your `PATH`

```bash
npm install
npm start
```

Open <http://localhost:3990>.

Downloaded audio is cached in `cache/` keyed by video ID, so re-scrubbing the same song
doesn't re-download it.

---

## The interface

It's a Nokia. Dot-matrix LCD, signal bars, battery meter, scrolling title ticker, two
soft keys. This is not a theme layer over a normal form — the LCD is a canvas that draws
the detected melody as a piano-roll and sweeps a playhead across it during playback.

**Play tone** renders the notes through an oscillator. **Play original** plays the same
clip back. Toggling between them is the honest test of whether the transcription is any
good.

---

## Limits

- **Monophonic only.** Chords, harmonies and dense mixes transcribe as whichever voice
  is loudest, which is often not the tune you wanted.
- **Best on clear leads.** Solo vocal, whistle, lead synth, brass. Worst on distorted
  guitar and anything with heavy reverb tails.
- Videos longer than 15 minutes are rejected; clips are capped at 20 seconds.
- RTTTL has no concept of velocity, overlap or tempo change. A transcription is a
  caricature — that's the aesthetic.

---

## Repo layout

```
server.js        Express (3990): /api/info, /api/clip. yt-dlp + ffmpeg.
public/
  index.html     the phone
  app.js         YIN, quantizer, RTTTL encoder, playback, LCD renderer
  style.css
cache/           downloaded audio, gitignored
```

That is the whole project. The server fetches and cuts; everything musical happens in
the browser.

---

## License

MIT. See [LICENSE](LICENSE).

`yt-dlp` and `ffmpeg` are separate projects with their own licenses; this repo does not
bundle them. You are responsible for whether your use of a given video is permitted.
