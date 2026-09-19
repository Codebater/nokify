# Nokify

Nokify turns any uploaded song into a lo-fi, Nokia-era ringtone or notification tone using only open-source audio tooling — no paid APIs, no GPU, no model weights to download. Upload an MP3, review the detected chorus, and download a crunchy 8-bit WAV that sounds like it came straight from 1999.

---

## Pipeline

```
upload MP3/WAV/M4A
        │
        ▼
librosa.load  ──►  detect_hook()
                   ├─ chroma_cqt features
                   ├─ recurrence matrix (affinity)
                   ├─ RMS energy
                   ├─ combined score (0.55 repeat + 0.45 energy)
                   ├─ intro/outro soft bias
                   └─ beat-snap start time
        │
        ▼
   user reviews 20s hook preview
        │
        ▼
nokia_ify() DSP chain
   ├─ force mono
   ├─ 4th-order Butterworth low-pass @ 3.5 kHz
   ├─ resample to 8000 Hz
   ├─ normalize to 0.95 peak
   ├─ bit-crush: round to 8-bit grid
   └─ 40ms linear fade-in / fade-out
        │
        ▼
  PCM_U8 WAV  ──►  download
```

---

## How hook detection works

1. **Chroma features** (`librosa.feature.chroma_cqt`) encode the pitch-class content of each frame — a proxy for harmonic similarity between frames.
2. **Recurrence matrix** (`librosa.segment.recurrence_matrix`, affinity mode) measures how similar each frame is to every other frame. Choruses repeat, so their rows have high mean affinity.
3. **RMS energy** weights toward louder, more energetic sections.
4. The two signals are normalized to `[0,1]` and blended `0.55 × repeat + 0.45 × energy`.
5. A soft bias multiplies intro frames by 0.6 and outro frames by 0.7 to avoid selecting instrumental bookends.
6. A sliding window finds the 20-second span with the highest cumulative score.
7. The start time is **snapped to the nearest beat** from `librosa.beat.beat_track` so the cut feels musical rather than mid-beat.

---

## Lo-fi DSP chain

| Step | What it does |
|------|-------------|
| `librosa.to_mono` | Collapse stereo to mono |
| `scipy.signal.butter(4, 3500/nyq, 'low')` | Roll off frequencies above 3.5 kHz — the bandwidth of a 1990s phone earpiece |
| `librosa.resample → 8000 Hz` | Halve the sample rate; destroys high-frequency content the filter missed |
| Normalize to 0.95 peak | Maximize loudness without clipping |
| `round(y × 128) / 128` | Quantize to 8-bit resolution — the signature crunch |
| 40ms linear fades | Prevent clicks on phone speakers |
| `soundfile.write(..., subtype="PCM_U8")` | Write unsigned 8-bit PCM — the format old Nokias actually stored in flash |

---

## Run locally

Requires Python 3.10+ and **ffmpeg** on your PATH (needed by librosa for MP3/M4A decoding).

**Terminal 1 — backend:**
```bash
cd nokify/backend
pip install -r requirements.txt
python app.py
# Flask running on http://localhost:5000
```

**Terminal 2 — frontend:**
```bash
cd nokify/frontend
python -m http.server 8080
# Open http://localhost:8080
```

Open `http://localhost:8080` in a browser. The frontend auto-discovers the API at `localhost:5000`. To point it at a different host: `http://localhost:8080?api=http://your-host:5000`.

**Run the pipeline test:**
```bash
cd nokify/backend
python tests/test_pipeline.py
```

---

## PWA install & Capacitor wrapping

The frontend ships a `manifest.json`, so modern browsers will offer an "Add to Home Screen" prompt when served over HTTPS (or localhost on Android). Tap it to install Nokify as a standalone app with the green LCD icon.

To wrap it as a real iOS/Android binary with Capacitor:

```bash
npm init @capacitor/app nokify-cap
cd nokify-cap
npm install @capacitor/core @capacitor/ios @capacitor/android
# Copy frontend/ into www/
cp -r ../nokify/frontend/* www/
npx cap add ios
npx cap add android
npx cap open ios     # opens Xcode
npx cap open android # opens Android Studio
```

Point the `server.url` in `capacitor.config.json` at your running Flask backend, or bundle the Python backend as a sidecar using BeeWare/Briefcase for a truly self-contained app.

---

## Roadmap

- **Better segmentation** — swap the hand-rolled recurrence matrix for [`msaf`](https://github.com/urinieto/msaf) or [`essentia`](https://essentia.upf.edu/)'s structural segmentation algorithms for more reliable verse/chorus boundary detection on complex arrangements.

- **More output formats** — add `.m4r` (iPhone ringtone) and `.ogg` (Android) output via an ffmpeg subprocess call in `/api/render`.

- **Polyphonic-MIDI mode** — use Spotify's [`basic-pitch`](https://github.com/spotify/basic-pitch) (open source, runs on CPU) to transcribe the detected hook to MIDI, then render with a square-wave synthesizer. That's the *true* Nokia 3310 sound: no audio sample, just a monophonic melody sequence in flash memory.

- **Auto-EQ for tiny speakers** — boost 2–4 kHz by +4–6 dB after the low-pass step; this frequency range projects through small phone speakers and makes ringtones more intelligible in noisy environments.

- **Trim slider** — the review screen already receives `hook_start`/`hook_end` from the backend, and `/api/render` already accepts a `start_offset` parameter. Wiring up a drag handle on the timeline bar to pass `start_offset` to the render call is a one-afternoon feature.
