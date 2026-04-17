/**
 * Round reachability smoke test. Answers: "if the user reinstalled and signed
 * back in right now, would this round play?"
 *
 * Used by the debug button in Profile and (optionally) by any health-check
 * we surface in the library. Does not mutate state.
 */
import { supabase } from '@/lib/supabase';
import { getClipUrl, getReelUrl } from '@/lib/r2';

export type ReachabilityIssue =
  | 'round-missing'
  | 'no-scores'
  | 'no-shots'
  | 'shots-missing-clip-url'
  | 'clip-url-failed-to-sign'
  | 'reel-url-failed-to-sign';

export interface RoundReachabilityReport {
  roundId: string;
  courseName: string | null;
  ok: boolean;
  issues: ReachabilityIssue[];
  /** Structured details for each issue. */
  details: {
    roundExists: boolean;
    scoresCount: number;
    shotsCount: number;
    shotsWithClipUrl: number;
    shotsSignable: number;
    reelStoragePath: string | null;
    reelSignable: boolean;
    sampleSignedClipUrl: string | null;
  };
  summary: string;
}

/**
 * Run the reachability check end-to-end. Returns a report rather than
 * throwing so the caller can render each issue individually.
 */
export async function verifyRoundReachable(
  roundId: string
): Promise<RoundReachabilityReport> {
  const issues: ReachabilityIssue[] = [];
  const details: RoundReachabilityReport['details'] = {
    roundExists: false,
    scoresCount: 0,
    shotsCount: 0,
    shotsWithClipUrl: 0,
    shotsSignable: 0,
    reelStoragePath: null,
    reelSignable: false,
    sampleSignedClipUrl: null,
  };

  // 1. Round row exists
  const { data: round, error: roundErr } = await supabase
    .from('rounds')
    .select('id, course_name, reel_url, status')
    .eq('id', roundId)
    .single();

  if (roundErr || !round) {
    issues.push('round-missing');
    return {
      roundId,
      courseName: null,
      ok: false,
      issues,
      details,
      summary: `Round ${roundId} not found in Supabase.`,
    };
  }
  details.roundExists = true;
  details.reelStoragePath = round.reel_url ?? null;

  // 2. Scores
  try {
    const { data: scores } = await supabase
      .from('scores')
      .select('hole_number')
      .eq('round_id', roundId);
    details.scoresCount = scores?.length ?? 0;
    if (details.scoresCount === 0) issues.push('no-scores');
  } catch {
    issues.push('no-scores');
  }

  // 3. Shots
  let shots: Array<{ id: string; hole_number: number; shot_number: number; clip_url: string | null }> = [];
  try {
    const { data } = await supabase
      .from('shots')
      .select('id, hole_number, shot_number, clip_url')
      .eq('round_id', roundId);
    shots = data ?? [];
  } catch {}
  details.shotsCount = shots.length;

  if (shots.length === 0) {
    issues.push('no-shots');
  } else {
    const withClipUrl = shots.filter(
      (s) => s.clip_url && s.clip_url.trim() !== ''
    );
    details.shotsWithClipUrl = withClipUrl.length;
    if (withClipUrl.length < shots.length) {
      issues.push('shots-missing-clip-url');
    }

    // Sign a sample of clips (cap at 5 so we don't burn API quota)
    const sample = withClipUrl.slice(0, 5);
    let signable = 0;
    let firstSignedUrl: string | null = null;
    for (const shot of sample) {
      try {
        const signed = await getClipUrl(shot.clip_url!);
        if (signed) {
          signable++;
          if (!firstSignedUrl) firstSignedUrl = signed;
        }
      } catch {}
    }
    details.shotsSignable = signable;
    details.sampleSignedClipUrl = firstSignedUrl;
    if (signable < sample.length) {
      issues.push('clip-url-failed-to-sign');
    }
  }

  // 4. Reel URL
  if (round.reel_url) {
    try {
      const reelUrl = await getReelUrl(roundId);
      details.reelSignable = !!reelUrl;
      if (!reelUrl) issues.push('reel-url-failed-to-sign');
    } catch {
      issues.push('reel-url-failed-to-sign');
    }
  }

  const ok = issues.length === 0;
  const summary = ok
    ? `Round reachable: ${details.shotsCount} shots (${details.shotsSignable}/${Math.min(details.shotsWithClipUrl, 5)} sample signed), ${details.scoresCount} scores${details.reelSignable ? ', reel signable' : ''}.`
    : `Round has issues: ${issues.join(', ')}`;

  return {
    roundId,
    courseName: round.course_name ?? null,
    ok,
    issues,
    details,
    summary,
  };
}

/**
 * Convenience: run reachability on every round owned by the signed-in user.
 * Returns the reports sorted worst-first. Useful for the profile debug button.
 */
export async function verifyAllRoundsReachable(): Promise<RoundReachabilityReport[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: rounds } = await supabase
    .from('rounds')
    .select('id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20); // last 20 rounds is plenty for a smoke test

  if (!rounds) return [];

  const reports: RoundReachabilityReport[] = [];
  for (const r of rounds) {
    try {
      reports.push(await verifyRoundReachable(r.id));
    } catch (err) {
      console.warn(`[verifyRound] failed for ${r.id}:`, err);
    }
  }

  // Sort: failing rounds first, then by number of issues descending
  return reports.sort((a, b) => {
    if (a.ok === b.ok) return b.issues.length - a.issues.length;
    return a.ok ? 1 : -1;
  });
}
