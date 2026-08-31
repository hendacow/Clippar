/**
 * A one-at-a-time queue for read-modify-write sequences.
 *
 * `local_settings` is a plain key/value table and `getSetting`/`setSetting` are
 * a bare SELECT and a bare INSERT OR REPLACE — there is no transaction, no
 * compare-and-swap and no row lock between them. So any module that keeps a
 * LIST under one settings key (the clip bin, the training registry) is doing
 * read → mutate in JS → write, and two of those overlapping means the second
 * write is computed from a snapshot taken before the first one landed. The
 * first mutation is then gone.
 *
 * For the clip bin that is not a cosmetic loss: `deleteClipToBin` removes the
 * row from SQLite FIRST and records the recovery entry SECOND, so a lost bin
 * write leaves a clip deleted with nothing to restore it from — while the UI
 * has just told the golfer "you can put it back from Recently deleted".
 *
 * This is deliberately not a general lock: no timeouts, no reentrancy, no
 * cancellation. It is a promise chain, which is all a single-threaded JS
 * runtime needs to make "read, decide, write" atomic with respect to other
 * work queued through the same instance.
 */

export interface SerialQueue {
  /** Run `fn` once every previously queued job has settled. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  // The tail always settles — a rejected job must not wedge the queue for
  // every caller after it, which is exactly the failure mode that would turn
  // one failed delete into a permanently broken bin.
  let tail: Promise<void> = Promise.resolve();

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn);
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
}
