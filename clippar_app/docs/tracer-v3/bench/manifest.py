#!/usr/bin/env python3
"""
manifest.py — assemble the bench corpus.

Globs the three sources, de-duplicates, probes each clip, and writes
$BENCH_WORK/manifest.json. Re-run it any time; Henry keeps adding clips to
~/Downloads and re-globbing picks them up.

DE-DUPLICATION is by CONTENT, not by name. "IMG_0601 2.MOV" is the obvious case
and a name rule would catch it, but a name rule would also merge two genuinely
different clips that happen to share a stem across two source directories, and
would miss a re-download saved under a new name. The key is
(size, sha256 of the first 1 MiB, sha256 of the last 1 MiB) — cheap on a 200 MB
file and, for video containers, effectively exact: the head covers the moov/ftyp
and the tail covers the last GOP.

The first path seen for a group wins, in source order henry > unseen > lab, so a
clip present in two corpora is attributed to the one whose result matters most.
CLASSIFICATION is not done here — see classify.py.
"""
import hashlib
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from glob import glob

HOME = os.path.expanduser("~")
WORK = os.environ.get("BENCH_WORK", os.path.join(HOME, ".cache/clippar-tracer-bench"))
FS = os.environ.get("FINAL_SHIPMENT", os.path.join(HOME, "projects/clippar/final_shipment"))

# (corpus name, glob). Order matters — it is the de-dup priority, and LAB IS
# FIRST on purpose. 28 of the 50 clips under jobs/*/inputs are byte-identical to
# clips in final_shipment/inputs, i.e. the "nobody tuned on these" corpus is more
# than half the lab set. Claiming those as unseen would inflate the honest
# generalisation number with clips the ladder was fitted against. Lab wins the
# tie, so `unseen` in the manifest means genuinely-not-lab.
SOURCES = [
    ("lab", os.path.join(FS, "inputs", "*.MOV")),
    ("henry", os.path.join(HOME, "Downloads", "IMG_0*.MOV")),
    ("unseen", os.path.join(FS, "jobs", "*", "inputs", "*.MOV")),
]

LABELS_DIR = os.path.join(HOME, "projects/clippar/tracer-lab/data/labels")
IMPACT_CSV = os.path.join(HOME, "projects/clippar/tracer-lab/data/impact_sounds.csv")


def ground_truth_ids():
    try:
        return {os.path.splitext(f)[0] for f in os.listdir(LABELS_DIR) if f.endswith(".json")}
    except OSError:
        return set()


def audio_impacts():
    """clip stem -> [clip_time_sec, ...] from the lab's audio transient table.
    A clip can have several strikes recorded; the bench uses them only where a
    single strong one exists and it has been confirmed by eye."""
    out = {}
    try:
        with open(IMPACT_CSV) as f:
            head = f.readline().strip().split(",")
            i_name, i_t = head.index("clip_name"), head.index("clip_time_sec")
            i_s = head.index("strength") if "strength" in head else None
            for line in f:
                c = line.strip().split(",")
                if len(c) <= max(i_name, i_t):
                    continue
                stem = os.path.splitext(c[i_name])[0]
                out.setdefault(stem, []).append(
                    {"t": float(c[i_t]), "strength": c[i_s] if i_s is not None else None})
    except OSError:
        pass
    return out

CHUNK = 1 << 20


def content_key(path):
    st = os.stat(path)
    h1 = hashlib.sha256()
    h2 = hashlib.sha256()
    with open(path, "rb") as f:
        h1.update(f.read(CHUNK))
        if st.st_size > CHUNK:
            f.seek(max(0, st.st_size - CHUNK))
            h2.update(f.read(CHUNK))
    return f"{st.st_size}-{h1.hexdigest()[:16]}-{h2.hexdigest()[:16]}"


def probe(path):
    """Display-oriented width/height, fps, duration, audio presence."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_streams", "-show_format", path],
            capture_output=True, text=True, timeout=120).stdout
        d = json.loads(out)
    except Exception as e:
        return {"probe_error": str(e)}
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in d.get("streams", []) if s.get("codec_type") == "audio"), None)
    if v is None:
        return {"probe_error": "no video stream"}
    w, h = int(v.get("width", 0)), int(v.get("height", 0))
    # ROTATION METADATA. iPhone video reports the STREAM size, which is not the
    # size the app sees — the detector applies preferredTransform. A portrait
    # clip probes as 1920x1080 with rotate=90. Swap so the manifest carries the
    # DISPLAY size, which is what the detector's coordinates are in.
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(abs(float(sd["rotation"]))) % 360
    if rot == 0 and "rotate" in (v.get("tags") or {}):
        rot = int(abs(float(v["tags"]["rotate"]))) % 360
    if rot in (90, 270):
        w, h = h, w
    num, den = (v.get("avg_frame_rate") or "0/1").split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    dur = float(d.get("format", {}).get("duration") or v.get("duration") or 0.0)
    return {
        "width": w, "height": h, "rotationDeg": rot,
        "fps": round(fps, 4), "durationSec": round(dur, 3),
        "hasAudio": a is not None,
        "bytes": int(d.get("format", {}).get("size") or 0),
        "codec": v.get("codec_name"),
    }


def main():
    seen = {}
    order = []
    for corpus, pattern in SOURCES:
        for p in sorted(glob(pattern)):
            if not os.path.isfile(p):
                continue
            try:
                k = content_key(p)
            except OSError as e:
                print(f"[manifest] unreadable {p}: {e}", file=sys.stderr)
                continue
            if k in seen:
                seen[k]["duplicatePaths"].append(p)
                continue
            rec = {
                "id": os.path.splitext(os.path.basename(p))[0].replace(" ", "_"),
                "path": p,
                "corpus": corpus,
                "contentKey": k,
                "duplicatePaths": [],
            }
            seen[k] = rec
            order.append(rec)

    # ids must be unique — two corpora can hold different clips with the same stem
    used = {}
    for rec in order:
        base = rec["id"]
        n = used.get(base, 0)
        used[base] = n + 1
        if n:
            rec["id"] = f"{base}__{rec['corpus']}{n}"

    with ThreadPoolExecutor(max_workers=8) as ex:
        for rec, meta in zip(order, ex.map(lambda r: probe(r["path"]), order)):
            rec.update(meta)

    # ── STAGE EVERY CLIP AS A HARDLINK, and this is not tidiness. ────────────
    # `xcrun simctl spawn` cannot read ~/Downloads: macOS TCC blocks the
    # simulator process, and it does not fail — it HANGS FOREVER with the
    # process at 0% CPU, so a parallel run just stops with no error anywhere.
    # A hardlink into $BENCH_WORK costs no disk and no time and is readable.
    # It also removes the space in "IMG_0601 2.MOV" from every command line.
    stage = os.path.join(WORK, "clips")
    os.makedirs(stage, exist_ok=True)
    for rec in order:
        dst = os.path.join(stage, rec["id"] + os.path.splitext(rec["path"])[1])
        try:
            if os.path.exists(dst):
                if os.path.samefile(dst, rec["path"]):
                    rec["stagedPath"] = dst
                    continue
                os.remove(dst)
            os.link(rec["path"], dst)
        except OSError:
            try:
                import shutil
                shutil.copy2(rec["path"], dst)
            except OSError as e:
                print(f"[manifest] cannot stage {rec['id']}: {e}", file=sys.stderr)
                rec["stagedPath"] = rec["path"]
                continue
        rec["stagedPath"] = dst

    gt = ground_truth_ids()
    ai = audio_impacts()
    for rec in order:
        stem = os.path.splitext(os.path.basename(rec["path"]))[0]
        rec["hasHandLabels"] = stem in gt
        rec["audioImpacts"] = ai.get(stem, [])

    os.makedirs(WORK, exist_ok=True)
    out = os.path.join(WORK, "manifest.json")
    with open(out, "w") as f:
        json.dump({"clips": order}, f, indent=1)

    dups = sum(len(r["duplicatePaths"]) for r in order)
    by = {}
    for r in order:
        by[r["corpus"]] = by.get(r["corpus"], 0) + 1
    print(f"[manifest] {len(order)} unique clips ({dups} duplicate files collapsed) -> {out}")
    for k, v in by.items():
        print(f"           {k:8s} {v}")
    print(f"           hand-labelled: {sum(1 for r in order if r['hasHandLabels'])}"
          f"   with audio impacts: {sum(1 for r in order if r['audioImpacts'])}")
    bad = [r for r in order if r.get("probe_error")]
    if bad:
        print(f"[manifest] {len(bad)} unprobeable: " + ", ".join(r["id"] for r in bad[:10]))


if __name__ == "__main__":
    main()
