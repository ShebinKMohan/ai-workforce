/**
 * Getting the terminal back, from anywhere.
 *
 * A view that leaves a terminal with a hidden cursor, an alternate screen
 * buffer and a raw-mode stdin is worse than no view at all — the user's next
 * command comes back to a shell that looks broken. So restoration is not the
 * responsibility of the happy path: it is registered once and reached from
 * every way this process can end.
 *
 * `SIGKILL` is the accepted residual risk, the same one `less`, `htop` and
 * `vim` take. The cure for that one is `reset`.
 *
 * The registry is a module-level list because signal handlers have no
 * arguments. It stays small, it is idempotent, and `leaveActiveViews` is safe
 * to call twice — which matters, because on an interrupt it is called from the
 * signal handler AND from the run's own `finally`.
 */

export interface Restorable {
  leave(reason?: string): void;
}

const active = new Set<Restorable>();
let installed = false;

export function registerActiveView(view: Restorable): () => void {
  active.add(view);
  return () => active.delete(view);
}

/**
 * Restore every live view. Idempotent per view, because `leave()` is.
 *
 * On an interrupt this MUST run before the CLI writes its "interrupting"
 * line: otherwise that line is painted into an alternate buffer that is about
 * to be discarded, and the user watches a five-minute run vanish with no
 * explanation of what happened to it.
 */
export function leaveActiveViews(reason?: string): void {
  for (const view of [...active]) {
    active.delete(view);
    try {
      view.leave(reason);
    } catch {
      // A restore that throws must not stop the next view from restoring, and
      // must never turn an interrupt into a crash.
    }
  }
}

/**
 * Wire restoration to the ways this process ends.
 *
 * `exit` is the workhorse: Node emits it after a normal return, after
 * `process.exit`, and after the default fatal handler for an uncaught
 * exception or an unhandled rejection — so one listener covers all four
 * without a handler that would *suppress* the crash it is meant to survive.
 * Registering an `uncaughtException` listener would do exactly that, which is
 * why there is not one here.
 *
 * `SIGTERM` needs its own listener because adding one prevents the default
 * termination, so the handler restores and then re-raises with the default
 * disposition rather than deciding an exit code of its own.
 *
 * `SIGINT` is deliberately absent: the CLI already owns it, with a two-strike
 * policy this must not duplicate. `cli/index.ts` calls `leaveActiveViews()` as
 * the first statement of that handler.
 *
 * Installed at most once.
 */
export function installRestoreHandlers(target: NodeJS.Process = process): void {
  if (installed) return;
  installed = true;
  target.once('exit', () => leaveActiveViews());
  const onTerm = (): void => {
    leaveActiveViews();
    target.removeListener('SIGTERM', onTerm);
    target.kill(target.pid, 'SIGTERM');
  };
  target.on('SIGTERM', onTerm);
}
