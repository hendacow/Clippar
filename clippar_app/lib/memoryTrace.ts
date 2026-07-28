/**
 * TEMPORARY DIAGNOSTIC — memory tracer for the jetsam hunt.
 *
 * The device logs prove ClipparDev is being killed with `per-process-limit` at
 * ~3.1 GB, with `purgeable = 0` (none of it reclaimable). That is roughly 93
 * full-resolution 4K frames held live, so something allocates in the
 * gigabytes rather than leaking slowly — an earlier event had the app peak at
 * 441 MB and survive.
 *
 * Two rounds of fixes aimed at plausible-looking suspects did not stop it, so
 * this stops guessing and measures. It samples the process footprint on a
 * timer and lets call sites drop labelled breadcrumbs, so the Metro console
 * shows WHEN the climb happens and what was running at the time.
 *
 * DEV ONLY, and deliberately cheap to delete: one file plus a start() call in
 * app/_layout.tsx and a handful of mark() calls. Remove the lot once the
 * source is found.
 */
import { getMemoryStats } from 'shot-detector';

/** A jump at least this large between samples is worth shouting about. */
const JUMP_MB = 75;
const SAMPLE_MS = 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastUsed = -1;
let peak = 0;
let inFlight = false;

function fmt(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

async function sample(label?: string): Promise<void> {
  // getMemoryStats hops to a native queue; overlapping calls would queue up
  // behind each other and report stale numbers during exactly the spike we
  // care about.
  if (inFlight) return;
  inFlight = true;
  try {
    const s = await getMemoryStats();
    const used = s?.usedMemoryMB ?? -1;
    const avail = s?.availableMemoryMB ?? -1;
    if (used < 0) return;
    if (used > peak) peak = used;
    const delta = lastUsed < 0 ? 0 : used - lastUsed;
    lastUsed = used;

    const big = Math.abs(delta) >= JUMP_MB;
    const tag = label ? ` <${label}>` : '';
    const arrow = delta > 0 ? '+' : '';
    if (big || label) {
      console.log(
        `[MEM]${tag} used=${fmt(used)} avail=${fmt(avail)} ` +
          `${arrow}${delta.toFixed(0)}MB peak=${fmt(peak)}` +
          (big ? '   <<<< JUMP' : ''),
      );
    } else {
      console.log(`[MEM] used=${fmt(used)} avail=${fmt(avail)} peak=${fmt(peak)}`);
    }
  } catch {
    // Native module missing (Expo Go / web) — tracing is best-effort.
  } finally {
    inFlight = false;
  }
}

/** Drop a labelled sample. Safe to call from anywhere, never throws. */
export function memMark(label: string): void {
  if (!__DEV__) return;
  void sample(label);
}

export function startMemoryTrace(): void {
  if (!__DEV__ || timer) return;
  console.log('[MEM] tracer started — watching for the 3GB spike');
  timer = setInterval(() => void sample(), SAMPLE_MS);
}

export function stopMemoryTrace(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
