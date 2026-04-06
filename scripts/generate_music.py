"""
generate_music.py — Generate simple royalty-free background music tracks
using numpy and scipy. Outputs .mp3 files via pydub (requires ffmpeg).

Usage:
    pip install numpy scipy pydub
    python scripts/generate_music.py

Produces 3 tracks in assets/music/:
  - chill_vibes.mp3   (relaxed ambient, ~30s, loopable)
  - victory_lap.mp3   (upbeat celebratory, ~30s)
  - focus_mode.mp3     (calm minimal, ~30s)
"""

import os
import sys
from pathlib import Path

import numpy as np

# We use scipy.io.wavfile to write intermediate .wav, then pydub to export mp3.
from scipy.io import wavfile

try:
    from pydub import AudioSegment
except ImportError:
    print("pydub is required: pip install pydub")
    print("ffmpeg must also be installed for mp3 export.")
    sys.exit(1)

SAMPLE_RATE = 44100
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "assets" / "music"


def sine_wave(freq: float, duration: float, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Generate a sine wave at a given frequency and duration."""
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    return np.sin(2 * np.pi * freq * t)


def fade_in_out(signal: np.ndarray, fade_ms: int = 50, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Apply fade-in and fade-out to avoid clicks."""
    fade_samples = int(sr * fade_ms / 1000)
    out = signal.copy()
    if fade_samples > 0 and len(out) > 2 * fade_samples:
        out[:fade_samples] *= np.linspace(0, 1, fade_samples)
        out[-fade_samples:] *= np.linspace(1, 0, fade_samples)
    return out


def normalize(signal: np.ndarray, peak: float = 0.9) -> np.ndarray:
    """Normalize signal to a peak amplitude."""
    mx = np.max(np.abs(signal))
    if mx > 0:
        signal = signal * (peak / mx)
    return signal


def to_int16(signal: np.ndarray) -> np.ndarray:
    return (np.clip(signal, -1, 1) * 32767).astype(np.int16)


def save_track(signal: np.ndarray, path: Path):
    """Save float signal as wav (no ffmpeg needed) or mp3 if pydub available."""
    stereo = np.column_stack([signal, signal])
    int_data = to_int16(stereo)

    # Always save as .wav (works everywhere)
    wav_path = path.with_suffix(".wav")
    wavfile.write(str(wav_path), SAMPLE_RATE, int_data)
    print(f"  Saved: {wav_path} ({wav_path.stat().st_size / 1024:.0f} KB)")

    # Try to also save mp3 if ffmpeg is available
    try:
        from pydub import AudioSegment
        audio = AudioSegment.from_wav(str(wav_path))
        mp3_path = path.with_suffix(".mp3")
        audio.export(str(mp3_path), format="mp3", bitrate="192k")
        print(f"  Saved: {mp3_path} ({mp3_path.stat().st_size / 1024:.0f} KB)")
    except Exception:
        pass  # wav is fine


# ---------------------------------------------------------------------------
# Track 1: Chill Vibes — layered pads with slow LFO, loopable
# ---------------------------------------------------------------------------
def generate_chill_vibes(duration: float = 30.0) -> np.ndarray:
    t = np.linspace(0, duration, int(SAMPLE_RATE * duration), endpoint=False)

    # Warm pad: root C3 + fifth G3, detuned slightly for chorus effect
    pad1 = 0.25 * sine_wave(130.81, duration)  # C3
    pad2 = 0.20 * sine_wave(131.40, duration)  # C3 slightly sharp (chorus)
    pad3 = 0.18 * sine_wave(196.00, duration)  # G3
    pad4 = 0.12 * sine_wave(164.81, duration)  # E3 (major third)

    # Slow amplitude modulation (breathing feel)
    lfo = 0.5 + 0.5 * np.sin(2 * np.pi * 0.15 * t)

    # High shimmer overtone
    shimmer = 0.06 * sine_wave(523.25, duration)  # C5
    shimmer_lfo = 0.5 + 0.5 * np.sin(2 * np.pi * 0.08 * t + 1.0)

    mix = (pad1 + pad2 + pad3 + pad4) * lfo + shimmer * shimmer_lfo

    # Gentle crossfade at loop boundaries (first/last 2 seconds)
    xfade_len = int(SAMPLE_RATE * 2)
    ramp = np.linspace(0, 1, xfade_len)
    mix[:xfade_len] *= ramp
    mix[-xfade_len:] *= ramp[::-1]

    return normalize(mix, 0.85)


# ---------------------------------------------------------------------------
# Track 2: Victory Lap — upbeat arpeggiated pattern with driving pulse
# ---------------------------------------------------------------------------
def generate_victory_lap(duration: float = 30.0) -> np.ndarray:
    t = np.linspace(0, duration, int(SAMPLE_RATE * duration), endpoint=False)

    # Tempo: ~120 BPM -> beat = 0.5s
    beat = 0.5
    # C major arpeggio pattern: C4, E4, G4, C5 repeated
    arp_notes = [261.63, 329.63, 392.00, 523.25]
    note_dur = beat * 0.8  # slight gap between notes

    mix = np.zeros_like(t)

    # Build arpeggio pattern
    num_beats = int(duration / beat)
    for i in range(num_beats):
        freq = arp_notes[i % len(arp_notes)]
        start = int(i * beat * SAMPLE_RATE)
        length = int(note_dur * SAMPLE_RATE)
        end = min(start + length, len(t))
        if end <= start:
            continue
        note = sine_wave(freq, (end - start) / SAMPLE_RATE)
        # Add a harmonic for richness
        note += 0.3 * sine_wave(freq * 2, (end - start) / SAMPLE_RATE)
        note = fade_in_out(note, fade_ms=20)
        mix[start:end] += 0.35 * note[:end - start]

    # Bass pulse on every beat (C2)
    for i in range(num_beats):
        freq = 65.41  # C2
        start = int(i * beat * SAMPLE_RATE)
        length = int(beat * 0.6 * SAMPLE_RATE)
        end = min(start + length, len(t))
        if end <= start:
            continue
        bass = sine_wave(freq, (end - start) / SAMPLE_RATE)
        bass = fade_in_out(bass, fade_ms=15)
        mix[start:end] += 0.25 * bass[:end - start]

    # Subtle high-hat simulation (noise bursts on off-beats)
    for i in range(num_beats * 2):
        start = int(i * beat * 0.5 * SAMPLE_RATE)
        length = int(0.03 * SAMPLE_RATE)  # 30ms burst
        end = min(start + length, len(t))
        if end <= start:
            continue
        noise = np.random.randn(end - start) * 0.08
        noise = fade_in_out(noise, fade_ms=5)
        mix[start:end] += noise[:end - start]

    # Fade in first 1s, fade out last 2s
    fade_in = int(SAMPLE_RATE * 1)
    fade_out = int(SAMPLE_RATE * 2)
    mix[:fade_in] *= np.linspace(0, 1, fade_in)
    mix[-fade_out:] *= np.linspace(1, 0, fade_out)

    return normalize(mix, 0.85)


# ---------------------------------------------------------------------------
# Track 3: Focus Mode — minimal, calm, sparse tones
# ---------------------------------------------------------------------------
def generate_focus_mode(duration: float = 30.0) -> np.ndarray:
    t = np.linspace(0, duration, int(SAMPLE_RATE * duration), endpoint=False)

    # Very slow evolving drone on A2 + E3
    drone_a = 0.20 * sine_wave(110.00, duration)  # A2
    drone_e = 0.15 * sine_wave(164.81, duration)  # E3

    # Slow tremolo
    trem = 0.7 + 0.3 * np.sin(2 * np.pi * 0.1 * t)
    drone = (drone_a + drone_e) * trem

    # Sparse bell-like tones (pentatonic: A, C, D, E, G)
    bell_freqs = [440.0, 523.25, 587.33, 659.25, 783.99]
    mix = drone.copy()

    # Place a bell tone every ~3-5 seconds at random positions
    rng = np.random.RandomState(42)  # deterministic
    bell_times = np.arange(2.0, duration - 2.0, 3.5)
    for bt in bell_times:
        freq = rng.choice(bell_freqs)
        start = int(bt * SAMPLE_RATE)
        bell_dur = 2.0
        length = int(bell_dur * SAMPLE_RATE)
        end = min(start + length, len(t))
        if end <= start:
            continue

        bell_t = np.linspace(0, bell_dur, end - start, endpoint=False)
        # Bell = sine with exponential decay
        bell = np.sin(2 * np.pi * freq * bell_t) * np.exp(-bell_t * 2.0)
        # Add slight overtone
        bell += 0.3 * np.sin(2 * np.pi * freq * 2.01 * bell_t) * np.exp(-bell_t * 3.0)
        mix[start:end] += 0.15 * bell[:end - start]

    # Gentle fade in/out
    fade_len = int(SAMPLE_RATE * 2)
    mix[:fade_len] *= np.linspace(0, 1, fade_len)
    mix[-fade_len:] *= np.linspace(1, 0, fade_len)

    return normalize(mix, 0.80)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Generating background music tracks...")

    print("\n[1/3] Chill Vibes (relaxed ambient, 30s, loopable)")
    signal = generate_chill_vibes(30.0)
    save_track(signal, OUTPUT_DIR / "chill_vibes.mp3")

    print("\n[2/3] Victory Lap (upbeat celebratory, 30s)")
    signal = generate_victory_lap(30.0)
    save_track(signal, OUTPUT_DIR / "victory_lap.mp3")

    print("\n[3/3] Focus Mode (calm minimal, 30s)")
    signal = generate_focus_mode(30.0)
    save_track(signal, OUTPUT_DIR / "focus_mode.mp3")

    print(f"\nDone! Files saved to {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
