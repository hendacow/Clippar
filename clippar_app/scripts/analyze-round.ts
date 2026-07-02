/**
 * analyze-round.ts — S11 field-walk / round scorecard (plan V13).
 *
 * Parses a Metro log file for the `[TRACER-V2]` NDJSON line
 * (hooks/useEditorState.ts, one JSON object per processed clip) and the
 * `[GPS-RING]` JSON lines (hooks/useGpsSession.ts / useCamera.ts /
 * useEditorState.ts's impact re-derivation pass), and prints the per-round
 * scorecard: render rate by rung, GPS tier distribution, median/p95 elapsed
 * time, and hard-veto counts.
 *
 * Usage:
 *   npx tsx scripts/analyze-round.ts [path/to/metro.log]
 *
 * Defaults to /tmp/metro-clippar.log (the target of `npm run metro:log`).
 * No native/Expo imports — plain node, runnable in CI or against a log
 * pulled off a device.
 */
import { readFileSync, existsSync } from 'node:fs';

interface TracerRecord {
  clipId: number;
  rung: string | null;
  tier: number | null;
  carrySource: string | null;
  effAccA: number | null;
  effAccB: number | null;
  sigmaD: number | null;
  handoffMs: number | null;
  visionPointCount: number | null;
  fitVy0: number | null;
  elapsedSec: number;
  thermalState?: string;
  outcome: string; // 'done' | `skipped:${reason}` | 'failed'
}

interface GpsRingRecord {
  // useGpsSession.ts health-tick shape
  acc?: number;
  spd?: number;
  effAcc?: number | null;
  state?: 'green' | 'yellow' | 'red' | 'locking';
  n?: number;
  // useCamera.ts / useEditorState.ts impact-anchor shapes
  call?: 'impact' | 'reDerive';
  ok?: boolean;
  reason?: string | null;
  hole?: number;
  shot?: number;
  source?: string;
}

function extractJsonAfterTag(line: string, tag: string): unknown | null {
  const idx = line.indexOf(tag);
  if (idx === -1) return null;
  const rest = line.slice(idx + tag.length).trim();
  const braceStart = rest.indexOf('{');
  if (braceStart === -1) return null;
  try {
    return JSON.parse(rest.slice(braceStart));
  } catch {
    return null;
  }
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

function pct(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function bar(n: number, total: number, width = 24): string {
  if (total === 0) return '';
  const filled = Math.round((n / total) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function parseLog(filePath: string): { tracer: TracerRecord[]; gpsRing: GpsRingRecord[] } {
  const text = readFileSync(filePath, 'utf8');
  const tracer: TracerRecord[] = [];
  const gpsRing: GpsRingRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.includes('[TRACER-V2]')) {
      const rec = extractJsonAfterTag(line, '[TRACER-V2]') as TracerRecord | null;
      if (rec && typeof rec.clipId === 'number' && typeof rec.outcome === 'string') {
        tracer.push(rec);
      }
    } else if (line.includes('[GPS-RING]')) {
      const rec = extractJsonAfterTag(line, '[GPS-RING]') as GpsRingRecord | null;
      if (rec) gpsRing.push(rec);
    }
  }
  return { tracer, gpsRing };
}

function printScorecard(tracer: TracerRecord[], gpsRing: GpsRingRecord[]): void {
  const total = tracer.length;
  if (total === 0) {
    console.log('No [TRACER-V2] lines found in this log — nothing to score.');
    return;
  }

  const done = tracer.filter((r) => r.outcome === 'done');
  const failed = tracer.filter((r) => r.outcome === 'failed');
  const skipped = tracer.filter((r) => r.outcome.startsWith('skipped:'));

  console.log('═'.repeat(60));
  console.log('  TRACER V2 — ROUND SCORECARD');
  console.log('═'.repeat(60));
  console.log(`  Clips processed: ${total}`);
  console.log(
    `  Rendered:  ${done.length}/${total}  (${pct(done.length, total)})  ${bar(done.length, total)}`
  );
  console.log(`  Skipped:   ${skipped.length}/${total}  (${pct(skipped.length, total)})`);
  console.log(`  Failed:    ${failed.length}/${total}  (${pct(failed.length, total)})`);

  // ── Render rate by rung (V13 gate: ≥95% of non-putt shots render at SOME
  //    rung — a 'skipped:putt' clip is excluded from this denominator since
  //    a putt was never expected to render). ──
  const puttSkips = skipped.filter((r) => r.outcome === 'skipped:putt').length;
  const renderEligible = total - puttSkips;
  console.log('\n  ── Render rate by rung (V13: ≥95% of non-putt shots) ──');
  console.log(
    `  Overall (excl. putts): ${done.length}/${renderEligible}  (${pct(done.length, renderEligible)})`
  );
  const rungOrder = ['R0', 'R1', 'R2', 'R3', 'R4'];
  for (const rung of rungOrder) {
    const n = done.filter((r) => r.rung === rung).length;
    console.log(`    ${rung}: ${String(n).padStart(4)}  (${pct(n, done.length)})  ${bar(n, done.length)}`);
  }

  // ── GPS tier distribution among rendered clips ──
  console.log('\n  ── GPS tier distribution (rendered clips) ──');
  for (const tier of [1, 2, 3] as const) {
    const n = done.filter((r) => r.tier === tier).length;
    console.log(`    Tier${tier}: ${String(n).padStart(4)}  (${pct(n, done.length)})`);
  }
  const tierNull = done.filter((r) => r.tier === null).length;
  console.log(`    n/a:   ${String(tierNull).padStart(4)}  (${pct(tierNull, done.length)})`);
  const labeled = done.filter((r) => r.tier === 1 || r.tier === 2).length;
  console.log(`    Tier1/2 label rate (V13: ≥70% of paired shots): ${pct(labeled, done.length)}`);

  // ── Carry source ──
  console.log('\n  ── Carry source (rendered clips) ──');
  for (const src of ['gps', 'user', 'prior']) {
    const n = done.filter((r) => r.carrySource === src).length;
    if (n > 0) console.log(`    ${src.padEnd(6)}: ${n}`);
  }

  // ── Veto counts ──
  console.log('\n  ── Hard veto counts ──');
  const vetoReasons = ['putt', 'no-impact', 'grounded', 'anim-too-short', 'no-anchor'];
  for (const reason of vetoReasons) {
    const n = skipped.filter((r) => r.outcome === `skipped:${reason}`).length;
    if (n > 0) console.log(`    ${reason.padEnd(16)}: ${n}`);
  }
  const otherSkips = skipped.filter((r) => !vetoReasons.includes(r.outcome.slice('skipped:'.length)));
  if (otherSkips.length > 0) console.log(`    other:            ${otherSkips.length}`);

  // ── Elapsed time (V13 gate: median ≤4s / p95 ≤8s) ──
  const elapsed = tracer.map((r) => r.elapsedSec).filter((n) => Number.isFinite(n));
  console.log('\n  ── Elapsed per clip (V13: median ≤4s / p95 ≤8s) ──');
  console.log(`    median: ${median(elapsed).toFixed(2)}s`);
  console.log(`    p95:    ${percentile(elapsed, 95).toFixed(2)}s`);
  console.log(`    max:    ${elapsed.length ? Math.max(...elapsed).toFixed(2) : '0.00'}s`);

  // ── Thermal state (when present — S13 acceptance-round instrumentation) ──
  const thermal = tracer.filter((r) => r.thermalState).map((r) => r.thermalState as string);
  if (thermal.length > 0) {
    console.log('\n  ── Thermal state ──');
    for (const state of ['nominal', 'fair', 'serious', 'critical']) {
      const n = thermal.filter((t) => t === state).length;
      if (n > 0) console.log(`    ${state.padEnd(10)}: ${n}`);
    }
  }

  // ── GPS ring health (from [GPS-RING] lines, if present) ──
  const healthTicks = gpsRing.filter((r) => r.state);
  if (healthTicks.length > 0) {
    console.log('\n  ── GPS health ticks (session-wide) ──');
    for (const state of ['green', 'yellow', 'red', 'locking'] as const) {
      const n = healthTicks.filter((r) => r.state === state).length;
      console.log(`    ${state.padEnd(8)}: ${n}  (${pct(n, healthTicks.length)})`);
    }
  }
  const reDerives = gpsRing.filter((r) => r.call === 'reDerive');
  if (reDerives.length > 0) {
    const effAccs = reDerives.map((r) => r.effAcc).filter((n): n is number => typeof n === 'number');
    console.log('\n  ── Impact-anchored GPS re-derivations ──');
    console.log(`    count:       ${reDerives.length}`);
    console.log(`    median effAcc: ${median(effAccs).toFixed(2)}m`);
  }
  const impactCalls = gpsRing.filter((r) => r.call === 'impact');
  if (impactCalls.length > 0) {
    const failed2 = impactCalls.filter((r) => !r.ok);
    console.log('\n  ── Live impact-anchor estimates ──');
    console.log(`    ok:     ${impactCalls.length - failed2.length}/${impactCalls.length}`);
    if (failed2.length > 0) {
      const reasons = new Map<string, number>();
      for (const r of failed2) reasons.set(r.reason ?? 'unknown', (reasons.get(r.reason ?? 'unknown') ?? 0) + 1);
      for (const [reason, n] of reasons) console.log(`    failed (${reason}): ${n}`);
    }
  }

  console.log('\n' + '═'.repeat(60));
}

function main(): void {
  const filePath = process.argv[2] ?? '/tmp/metro-clippar.log';
  if (!existsSync(filePath)) {
    console.error(`analyze-round: log file not found: ${filePath}`);
    console.error('Usage: npx tsx scripts/analyze-round.ts [path/to/metro.log]');
    process.exitCode = 1;
    return;
  }
  const { tracer, gpsRing } = parseLog(filePath);
  console.log(`analyze-round: parsed ${filePath}`);
  console.log(`  [TRACER-V2] lines: ${tracer.length}`);
  console.log(`  [GPS-RING] lines:  ${gpsRing.length}\n`);
  printScorecard(tracer, gpsRing);
}

main();
