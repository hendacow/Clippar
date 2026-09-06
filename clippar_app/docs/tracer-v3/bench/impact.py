"""SUPERSEDED by truth.py (2026-09-06), which ranks the top three onsets AND
renders frames so the pick can be confirmed by eye. Audio alone was wrong by
more than a second on 4 of the 26 clips this bench now has truth for — see
bench.md, "Establishing a TRUE impact". Kept as the minimal version.
"""
"""Strongest audio transient = the strike. Same idea as the app's audio confirmation."""
import subprocess, sys, numpy as np
def impact_ms(path):
    raw = subprocess.run(['ffmpeg','-v','error','-i',path,'-ac','1','-ar','22050','-f','f32le','-'],
                         capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    if x.size < 4410: return None
    sr, hop = 22050, 256
    n = (x.size - hop) // hop
    e = np.array([np.abs(x[i*hop:(i+1)*hop]).max() for i in range(n)])
    # onset strength: rise over a short window
    d = np.maximum(0, e[2:] - e[:-2])
    t0 = int(1.0 * sr / hop)          # ignore the first second (handling noise)
    if d.size <= t0: return None
    d[:t0] = 0
    k = int(np.argmax(d))
    return round((k + 1) * hop / sr * 1000)
if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(f"{p}|{impact_ms(p)}")
