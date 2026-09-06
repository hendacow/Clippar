#!/bin/bash
#
# SUPERSEDED by bench.py / bench.sh (2026-09-06). Kept only because it is the
# smallest possible reproduction of one clip. NOTE: it calls `./harness`, which
# build.sh no longer produces — the binary is now $BENCH_WORK/tracerdet/tracerdet.
#
while IFS='|' read -r clip job ms; do
  f=$(ls "$HOME/projects/clippar/final_shipment/jobs/$job/inputs/$clip".* 2>/dev/null | head -1)
  [ -z "$f" ] && { echo "$clip NOPATH"; continue; }
  out=$(./harness "$f" "$ms" 2>/dev/null)
  python3 - "$clip" <<PY
import json,sys
try: d=json.loads('''$out''')
except Exception: print(f"{sys.argv[1]:<10} PARSE_FAIL"); raise SystemExit
a=d.get('address'); n=d.get('notes',{})
addr=f"({a['x']:.0f},{a['y']:.0f}) r{a['r']:.1f}" if a else "NONE"
print(f"{sys.argv[1]:<10} dets={d.get('nDetections',0):<4} addr={addr:<22} {str(n.get('address_path',''))[:26]:<26} {str(n.get('reason',''))[:40]}")
PY
done
