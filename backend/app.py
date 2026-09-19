import os
import uuid
import tempfile
import logging
import subprocess
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf
import yt_dlp
import imageio_ffmpeg
from scipy.signal import butter, lfilter
from scipy.ndimage import median_filter
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# ── Bundled ffmpeg ────────────────────────────────────────────────────────────
_FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()
_FFMPEG_DIR = str(Path(_FFMPEG_EXE).parent)
os.environ["PATH"] = _FFMPEG_DIR + os.pathsep + os.environ.get("PATH", "")
log.info("ffmpeg: %s", _FFMPEG_EXE)

app = Flask(__name__)
CORS(app)

WORK_DIR = Path(tempfile.gettempdir()) / "nokify"
WORK_DIR.mkdir(parents=True, exist_ok=True)


# ── Hook detection ────────────────────────────────────────────────────────────

def detect_hook(y: np.ndarray, sr: int, hook_seconds: float = 20.0):
    """
    Finds the most repeating, energetic section (the chorus).
    Recurrence matrix (structural repetition) + RMS energy + beat-snap.
    """
    hop = 512
    duration = len(y) / sr
    frame_sr = sr / hop

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]

    n_frames = min(chroma.shape[1], len(rms))
    chroma = chroma[:, :n_frames]
    rms = rms[:n_frames]

    try:
        R = librosa.segment.recurrence_matrix(chroma, mode="affinity", sym=True)
        repeat_score = R.mean(axis=1)
        if repeat_score.max() > 0:
            repeat_score = repeat_score / repeat_score.max()
        else:
            repeat_score = np.zeros(n_frames)
    except Exception:
        log.warning("Recurrence matrix failed — energy-only fallback")
        repeat_score = np.zeros(n_frames)

    energy_norm = rms / rms.max() if rms.max() > 0 else rms
    combined = 0.55 * repeat_score + 0.45 * energy_norm

    intro_frames = int(min(duration * 0.10, 15.0) * frame_sr)
    outro_frames = int(min(duration * 0.10, 15.0) * frame_sr)
    combined[:intro_frames] *= 0.6
    if outro_frames > 0:
        combined[-outro_frames:] *= 0.7

    hook_frames = min(int(hook_seconds * frame_sr), n_frames)
    cs = np.cumsum(np.concatenate([[0], combined]))
    window_sums = cs[hook_frames:] - cs[:n_frames - hook_frames + 1]
    best_start_frame = int(np.argmax(window_sums))

    try:
        _, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
        if len(beats) > 0:
            best_start_frame = int(beats[np.argmin(np.abs(beats - best_start_frame))])
    except Exception:
        pass

    start_sec = best_start_frame / frame_sr
    end_sec = min(start_sec + hook_seconds, duration)

    peak = float(window_sums.max()) if window_sums.max() > 0 else 0.0
    total = float(window_sums.sum())
    confidence = min(1.0, (peak / (total / len(window_sums)) if total > 0 else 0.0) / 5.0)

    return start_sec, end_sec, confidence


# ── Nokia synthesis ───────────────────────────────────────────────────────────

def nokia_melody_synth(y: np.ndarray, sr: int, target_sr: int = 8000):
    """
    True Nokia-style synthesis:
      1. pyin pitch detection → per-frame fundamental frequency
      2. Quantize to nearest chromatic MIDI note, median-filter to kill glitches
      3. Segment into held notes (merge consecutive equal-pitch frames)
      4. Synthesize each note as a square wave with per-note micro-envelope
      5. Resample to 8 kHz, normalize, bit-crush to 8-bit unsigned PCM

    Raises ValueError("too_sparse") if < 20 % of frames are voiced —
    caller can fall back to nokia_ify for percussion-heavy or ambient audio.
    """
    y = librosa.to_mono(y)
    hop = 512

    # ── Pitch detection (probabilistic YIN) ──────────────────────────────────
    f0, voiced, _ = librosa.pyin(
        y, sr=sr,
        fmin=librosa.note_to_hz("C2"),   # ~65 Hz  — low bass
        fmax=librosa.note_to_hz("C7"),   # ~2093 Hz — above this Nokia can't play
        hop_length=hop,
        fill_na=0.0,
    )

    voiced_ratio = float(voiced.mean()) if len(voiced) > 0 else 0.0
    log.info("pyin voiced ratio: %.2f", voiced_ratio)
    if voiced_ratio < 0.20:
        raise ValueError("too_sparse")

    # ── Chromatic quantization ────────────────────────────────────────────────
    # Convert voiced frames to MIDI note number (integer semitone), rest → -1
    safe_f0 = np.where(voiced & (f0 > 0), f0, 1.0)
    midi_raw = np.where(voiced & (f0 > 0), np.round(librosa.hz_to_midi(safe_f0)), -1).astype(int)

    # Median filter (window=7 frames ≈ 80 ms) removes single-frame pitch jumps
    voiced_midi = np.where(midi_raw >= 0, midi_raw, 0)
    smoothed = median_filter(voiced_midi, size=7)
    midi = np.where(midi_raw >= 0, smoothed, -1)

    # ── Note segmentation: runs of equal note ─────────────────────────────────
    segments = []
    prev, seg_start = int(midi[0]), 0
    for i in range(1, len(midi)):
        cur = int(midi[i])
        if cur != prev:
            segments.append((seg_start, i, prev))
            prev, seg_start = cur, i
    segments.append((seg_start, len(midi), prev))

    # ── Square-wave synthesis ─────────────────────────────────────────────────
    out = np.zeros(len(y), dtype=np.float32)
    min_frames = max(4, int(sr * 0.045 / hop))  # 45 ms floor — kills micro-blips

    for sf_, ef, note in segments:
        if note < 0 or (ef - sf_) < min_frames:
            continue
        s0 = sf_ * hop
        s1 = min(ef * hop, len(out))
        n = s1 - s0
        if n <= 0:
            continue

        freq = float(librosa.midi_to_hz(note))
        t = np.arange(n, dtype=np.float32) / sr

        # Square wave — the Nokia oscillator sound
        sq = np.sign(np.sin(2.0 * np.pi * freq * t)).astype(np.float32)

        # Per-note micro-envelope: 8 ms attack → full sustain → 20 ms decay
        att = min(int(sr * 0.008), n // 3)
        dec = min(int(sr * 0.020), n // 3)
        if att > 0:
            sq[:att] *= np.linspace(0.0, 1.0, att)
        if dec > 0:
            sq[-dec:] *= np.linspace(1.0, 0.0, dec)

        out[s0:s1] += sq * 0.85

    # ── Post-process ──────────────────────────────────────────────────────────
    # Light LP before downsampling to tame square-wave aliasing
    nyq = sr / 2.0
    b, a = butter(2, min(3800.0, nyq * 0.85) / nyq, btype="low")
    out = lfilter(b, a, out).astype(np.float32)

    out = librosa.resample(out, orig_sr=sr, target_sr=target_sr)

    peak = np.abs(out).max()
    if peak > 0:
        out *= 0.92 / peak

    # Bit-crush: 8-bit quantization grid
    out = (np.round(out * 128) / 128).astype(np.float32)

    return out, target_sr


def nokia_ify(y: np.ndarray, sr: int, target_sr: int = 8000):
    """
    Fallback lo-fi renderer for when melody extraction yields sparse results
    (percussion-heavy, ambient, or very short audio).
    Low-pass 3.5 kHz → resample 8 kHz → normalize → 8-bit crush.
    """
    y = librosa.to_mono(y)
    nyq = sr / 2.0
    b, a = butter(4, min(3500.0, nyq * 0.95) / nyq, btype="low")
    y = lfilter(b, a, y).astype(np.float32)
    y = librosa.resample(y, orig_sr=sr, target_sr=target_sr)
    peak = np.abs(y).max()
    if peak > 0:
        y *= 0.95 / peak
    y = (np.round(y * 128) / 128).astype(np.float32)
    return y, target_sr


def render_nokia(y: np.ndarray, sr: int) -> tuple:
    """Try melody synthesis; fall back to lo-fi if audio is not pitched enough."""
    try:
        return nokia_melody_synth(y, sr)
    except ValueError:
        log.warning("Melody too sparse — falling back to lo-fi nokia_ify")
        return nokia_ify(y, sr)


# ── Shared helpers ────────────────────────────────────────────────────────────

def _apply_fades(y: np.ndarray, sr: int, fade_ms: int = 40) -> np.ndarray:
    fade_samples = min(int(sr * fade_ms / 1000), len(y) // 2)
    y = y.copy()
    y[:fade_samples] *= np.linspace(0.0, 1.0, fade_samples)
    y[-fade_samples:] *= np.linspace(1.0, 0.0, fade_samples)
    return y


def _analyze_audio(y: np.ndarray, sr: int, job_id: str) -> dict:
    """Detect hook → save raw WAV → synthesize Nokia preview."""
    duration = len(y) / sr
    if duration < 8.0:
        raise ValueError("Track must be at least 8 seconds long")

    hook_start, hook_end, confidence = detect_hook(y, sr, hook_seconds=20.0)
    y_hook = y[int(hook_start * sr): int(hook_end * sr)]

    sf.write(str(WORK_DIR / f"{job_id}_raw.wav"), y_hook, sr)

    y_preview, sr_preview = render_nokia(y_hook, sr)
    sf.write(str(WORK_DIR / f"{job_id}_preview.wav"), y_preview, sr_preview, subtype="PCM_U8")

    return {
        "job_id": job_id,
        "duration": round(duration, 2),
        "hook_start": round(hook_start, 2),
        "hook_end": round(hook_end, 2),
        "hook_length": round(hook_end - hook_start, 2),
        "confidence": round(confidence, 3),
        "preview_url": f"/api/preview/{job_id}",
        "sample_rate_preview": sr_preview,
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return jsonify({"ok": True})


@app.post("/api/analyze")
def analyze():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    f = request.files["audio"]
    job_id = uuid.uuid4().hex
    suffix = Path(f.filename).suffix or ".mp3"
    upload_path = WORK_DIR / f"{job_id}_upload{suffix}"
    f.save(upload_path)

    try:
        y, sr = librosa.load(str(upload_path), sr=None, mono=True)
    except Exception as e:
        return jsonify({"error": f"Could not decode audio: {e}"}), 400
    finally:
        upload_path.unlink(missing_ok=True)

    try:
        return jsonify(_analyze_audio(y, sr, job_id))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"error": "No query provided"}), 400

    ydl_opts = {"quiet": True, "no_warnings": True, "extract_flat": True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch5:{q}", download=False)
    except Exception as e:
        return jsonify({"error": f"Search failed: {e}"}), 500

    results = []
    for entry in info.get("entries") or []:
        if not entry:
            continue
        vid_id = entry.get("id", "")
        results.append({
            "id": vid_id,
            "title": entry.get("title", "Unknown"),
            "duration": entry.get("duration"),
            "uploader": entry.get("uploader") or entry.get("channel", ""),
            "url": f"https://www.youtube.com/watch?v={vid_id}",
        })

    return jsonify({"results": results})


@app.post("/api/import")
def import_youtube():
    data = request.get_json(force=True)
    url = data.get("url")
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    job_id = uuid.uuid4().hex

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": str(WORK_DIR / f"{job_id}_dl.%(ext)s"),
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            meta = ydl.extract_info(url, download=True)
    except Exception as e:
        return jsonify({"error": f"Download failed: {e}"}), 500

    candidates = sorted(WORK_DIR.glob(f"{job_id}_dl.*"))
    if not candidates:
        return jsonify({"error": "Downloaded file not found"}), 500
    dl_path = candidates[0]

    # Convert to WAV with bundled ffmpeg — avoids any soundfile/audioread codec issues
    wav_path = WORK_DIR / f"{job_id}_dl.wav"
    try:
        result = subprocess.run(
            [_FFMPEG_EXE, "-y", "-i", str(dl_path),
             "-ac", "1", "-ar", "44100", str(wav_path)],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode(errors="replace")[-300:])
    except Exception as e:
        return jsonify({"error": f"Audio conversion failed: {e}"}), 500
    finally:
        dl_path.unlink(missing_ok=True)

    try:
        y, sr = librosa.load(str(wav_path), sr=None, mono=True)
    except Exception as e:
        return jsonify({"error": f"Could not decode audio: {e}"}), 400
    finally:
        wav_path.unlink(missing_ok=True)

    try:
        result = _analyze_audio(y, sr, job_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    result["title"] = meta.get("title", "")
    result["uploader"] = meta.get("uploader") or meta.get("channel", "")
    return jsonify(result)


@app.get("/api/preview/<job_id>")
def preview(job_id: str):
    path = WORK_DIR / f"{job_id}_preview.wav"
    if not path.exists():
        return jsonify({"error": "Not found"}), 404
    return send_file(str(path), mimetype="audio/wav")


@app.post("/api/render")
def render():
    data = request.get_json(force=True)
    job_id = data.get("job_id")
    mode = data.get("mode", "ringtone")
    start_offset = float(data.get("start_offset", 0.0))

    raw_path = WORK_DIR / f"{job_id}_raw.wav"
    if not raw_path.exists():
        return jsonify({"error": "Job not found"}), 404

    y, sr = librosa.load(str(raw_path), sr=None, mono=True)

    target_length = 3.0 if mode == "notification" else 20.0
    offset_samples = int(start_offset * sr)
    y_slice = y[offset_samples: offset_samples + int(target_length * sr)]

    y_slice = _apply_fades(y_slice, sr, fade_ms=40)
    y_lofi, sr_lofi = render_nokia(y_slice, sr)

    out_path = WORK_DIR / f"{job_id}_{mode}.wav"
    sf.write(str(out_path), y_lofi, sr_lofi, subtype="PCM_U8")

    return jsonify({"download_url": f"/api/download/{job_id}/{mode}"})


@app.get("/api/download/<job_id>/<mode>")
def download(job_id: str, mode: str):
    path = WORK_DIR / f"{job_id}_{mode}.wav"
    if not path.exists():
        return jsonify({"error": "Not found"}), 404
    return send_file(
        str(path), mimetype="audio/wav",
        as_attachment=True, download_name=f"nokify_{mode}.wav",
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
