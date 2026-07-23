/**
 * Registry of clip ids whose live-record detectAndTrim pass is currently
 * running (or queued via InteractionManager). The mid-round editor
 * ("Review round so far") keeps the record screen mounted underneath, so
 * its processAllUntrimmed batch could otherwise start a SECOND detect+trim
 * on the same source file concurrently — producing duplicate trimmed files
 * (one orphaned on disk) and doubled native video load. The editor skips
 * any clip registered here; the live pass clears the id when it settles.
 *
 * Module-level state is intentional: useCamera (registrar) and
 * useEditorState (reader) live in different component trees.
 */
const inFlight = new Set<number>();

export function markTrimInFlight(clipId: number): void {
  inFlight.add(clipId);
}

export function clearTrimInFlight(clipId: number): void {
  inFlight.delete(clipId);
}

export function isTrimInFlight(clipId: number): boolean {
  return inFlight.has(clipId);
}
