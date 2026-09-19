"""
Pipeline tests for Nokify hook detection and lo-fi rendering.

Synthesizes a structured fake song and verifies:
  1. detect_hook finds one of the two chorus sections (±2s tolerance)
  2. nokia_ify produces mono 8000 Hz audio that saves as a valid PCM_U8 WAV
"""
import sys
import os
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

# Allow imports from parent backend/ dir when run directly
sys.path.insert(0, str(Path(__file__).parent.parent))
from app import detect_hook, nokia_ify


def _tone(freq: float, duration: float, sr: int, amplitude: float = 0.3) -> np.ndarray:
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _make_fake_song(sr: int = 22050) -> np.ndarray:
    """
    Structure: intro(2s) | verse(5s,A3≈220Hz) | chorus(5s,E4≈330Hz,louder) |
               verse(5s) | chorus(5s) | outro(2s)
    Chorus sections start at t=7s and t=17s.
    """
    A3, E4, C5 = 220.0, 329.63, 523.25

    intro  = _tone(A3 * 0.5, 2.0, sr, amplitude=0.15)
    verse1 = _tone(A3,       5.0, sr, amplitude=0.25)
    chorus1 = (
        _tone(E4, 5.0, sr, amplitude=0.55)
        + _tone(C5, 5.0, sr, amplitude=0.35)
    )
    verse2  = _tone(A3, 5.0, sr, amplitude=0.25)
    chorus2 = (
        _tone(E4, 5.0, sr, amplitude=0.55)
        + _tone(C5, 5.0, sr, amplitude=0.35)
    )
    outro  = _tone(A3 * 0.5, 2.0, sr, amplitude=0.10)

    return np.concatenate([intro, verse1, chorus1, verse2, chorus2, outro])


def test_detect_hook():
    sr = 22050
    song = _make_fake_song(sr)
    duration = len(song) / sr
    print(f"  Synthetic song duration: {duration:.1f}s")

    chorus_starts = [7.0, 17.0]  # both chorus onsets
    hook_start, hook_end, confidence = detect_hook(song, sr, hook_seconds=4.8)

    print(f"  Detected hook: {hook_start:.2f}s -> {hook_end:.2f}s  (confidence {confidence:.3f})")

    within_tolerance = any(abs(hook_start - cs) <= 2.0 for cs in chorus_starts)
    assert within_tolerance, (
        f"Hook start {hook_start:.2f}s is not within ±2s of any chorus "
        f"({chorus_starts})"
    )
    print("  [OK] Hook detection within +-2s of a chorus")


def test_nokia_ify():
    sr = 22050
    song = _make_fake_song(sr)
    hook_start, hook_end, _ = detect_hook(song, sr, hook_seconds=4.8)

    y_hook = song[int(hook_start * sr): int(hook_end * sr)]
    y_lofi, sr_lofi = nokia_ify(y_hook, sr)

    assert y_lofi.ndim == 1, "Output must be mono (1-D)"
    assert sr_lofi == 8000, f"Expected 8000 Hz, got {sr_lofi}"

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        sf.write(tmp_path, y_lofi, sr_lofi, subtype="PCM_U8")
        data, file_sr = sf.read(tmp_path, dtype="float32")
        assert file_sr == 8000, f"Saved file has wrong SR: {file_sr}"
        assert data.ndim == 1, "Saved file is not mono"
        assert len(data) > 0, "Saved file is empty"

        info = sf.info(tmp_path)
        assert info.subtype == "PCM_U8", f"Expected PCM_U8, got {info.subtype}"
    finally:
        os.unlink(tmp_path)

    print(f"  [OK] nokia_ify: mono, 8000 Hz, PCM_U8, {len(y_lofi)} samples")


if __name__ == "__main__":
    print("\n=== Nokify Pipeline Tests ===\n")

    print("1. test_detect_hook")
    test_detect_hook()

    print("\n2. test_nokia_ify")
    test_nokia_ify()

    print("\n=== All tests passed ===\n")
