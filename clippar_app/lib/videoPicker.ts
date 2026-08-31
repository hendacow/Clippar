/**
 * Video picking that always ENDS.
 *
 * Third round of the iCloud fight (field, 31 Aug): with the fetch genuinely
 * downloading (picker patch round 1), a big video over a slow link spun the
 * import forever — no progress, no timeout, no way to tell hung from slow.
 * An error at least ends; an infinite spinner is the worst state we shipped.
 *
 * This wrapper guarantees an ending: the native call is raced against a
 * deadline, so the await ALWAYS resolves — picked / cancelled / timeout /
 * error — and the caller can show elapsed time while it runs. The silent
 * automatic retry from round 1 is gone: if attempt one hangs, a hidden retry
 * never fires anyway, and after a timeout a hidden retry would double the
 * wait invisibly. Retry is the user's explicit button, and iCloud downloads
 * resume where they left off, so retrying is genuinely cheap.
 *
 * Byte-level progress is not surfaced yet (the vendored patch logs it
 * natively; bridging it to JS is the next step if timeouts recur) — elapsed
 * time plus a hard cap plus honest outcomes is this round's contract.
 */
import * as ImagePicker from 'expo-image-picker';

export const PICK_TIMEOUT_MS = 120_000;

export type PickOutcome =
  | { kind: 'picked'; result: ImagePicker.ImagePickerResult }
  | { kind: 'cancelled' }
  | { kind: 'timeout'; elapsedMs: number }
  | { kind: 'error'; message: string };

export async function pickVideosWithDeadline(
  options: ImagePicker.ImagePickerOptions,
  timeoutMs: number = PICK_TIMEOUT_MS
): Promise<PickOutcome> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const raced = await Promise.race([ImagePicker.launchImageLibraryAsync(options), deadline]);
    if (raced === 'timeout') {
      // The native task may still finish later; its temp file is harmless.
      return { kind: 'timeout', elapsedMs: Date.now() - startedAt };
    }
    if (raced.canceled || raced.assets.length === 0) return { kind: 'cancelled' };
    return { kind: 'picked', result: raced };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error && err.message ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Copy the user should see when a fetch times out. One voice, both screens. */
export const ICLOUD_TIMEOUT_TITLE = 'Still downloading from iCloud';
export const ICLOUD_TIMEOUT_BODY =
  'That video is large and the download did not finish in 2 minutes. ' +
  'iCloud downloads resume where they left off — tap Choose videos to pick it again and it will continue.';
