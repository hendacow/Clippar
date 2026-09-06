#!/bin/bash
APP=~/projects/clippar/final_shipment/clippar_app
while IFS='|' read -r f ms; do
  name=$(basename "$f")
  dur=$(ffprobe -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null | head -1)
  ./harness "$f" "$ms" > "/tmp/det_$name.json" 2>/dev/null
  (cd "$APP" && npx tsx docs/tracer-v3/e2eHarness.ts "/tmp/det_$name.json" "$name" "" "${dur%%.*}" 2>/dev/null) \
    | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(f'  {'$name':<16} PIPELINE_ERROR'); raise SystemExit
mark='DREW ' if d['drew'] else 'none '
print(f\"  {d['label']:<16} {mark} nDet={d['nDet']:<3} K={d['K']:<3} rms={str(d['rmsPx'])[:5]:<6} {d['pill'][:26]:<26} {str(d['reason'] or '')[:44]}\")
"
done
