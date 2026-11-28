import { spawn } from 'node:child_process';

/** What became of the started program: its exit code, the signal that ended it, or why it could not start. */
export interface ChildResult {
  code: number | null;
  signal: string | null;
  /** Set when the program could not be started; `errno` is the system code (ENOENT, EACCES, ...). */
  error?: { message: string; errno: string };
}

export interface ChildOptions {
  cwd: string;
  env: Record<string, string>;
  /** True when this process reads a terminal: the terminal then sends Ctrl-C and Ctrl-\ to the program itself. */
  terminal: boolean;
}

export type StartChild = (file: string, args: readonly string[], options: ChildOptions) => Promise<ChildResult>;

/** Sent on to the program while it runs. SIGINT and SIGQUIT only when no terminal sends them to it already. */
export const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

/**
 * Starts the program from an argument vector, never through a shell, with this process's standard input, output and
 * error, and waits for it. While it runs, the signals above do not end this process: they are passed to the program, so
 * the run card can still be printed when it ends. A terminal already sends Ctrl-C (SIGINT) and Ctrl-\ (SIGQUIT) to every
 * program in its foreground group, so those two are passed on only when there is no terminal; passing them again would
 * give an interactive host two of each.
 */
export const startChild: StartChild = (file, args, options) => startChildWith(spawn, process)(file, args, options);

/** What `startChildWith` needs of `child_process.spawn` and of this process: injected by tests, never a shell. */
export type SpawnFn = (file: string, args: string[], options: { cwd: string; env: Record<string, string>; stdio: 'inherit'; shell: false; windowsHide: false }) => {
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (e: NodeJS.ErrnoException) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (e: NodeJS.ErrnoException) => void): unknown;
};
export interface SignalTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * `startChild` with the spawner and the signal source given. An 'error' after the program started (a failed kill, for
 * one) is not a failure to start: the program still runs, so this waits for its exit and keeps passing signals on.
 */
export function startChildWith(spawnFn: SpawnFn, proc: SignalTarget): StartChild {
  return (file, args, options) =>
    new Promise((resolve) => {
      const handlers = new Map<NodeJS.Signals, () => void>();
      let started = false;
      const done = (r: ChildResult): void => {
        for (const [sig, h] of handlers) proc.removeListener(sig, h);
        resolve(r);
      };
      let child: ReturnType<SpawnFn>;
      try {
        child = spawnFn(file, [...args], { cwd: options.cwd, env: options.env, stdio: 'inherit', shell: false, windowsHide: false });
      } catch (e: unknown) {
        const errno = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
        done({ code: null, signal: null, error: { message: e instanceof Error ? e.message : String(e), errno } });
        return;
      }
      for (const sig of FORWARDED_SIGNALS) {
        const h = (): void => {
          if (options.terminal && (sig === 'SIGINT' || sig === 'SIGQUIT')) return;
          try {
            child.kill(sig);
          } catch {
            // the program has already ended
          }
        };
        handlers.set(sig, h);
        proc.on(sig, h);
      }
      child.once('spawn', () => {
        started = true;
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (!started) done({ code: null, signal: null, error: { message: e.message, errno: e.code ?? '' } });
      });
      child.once('exit', (code, signal) => done({ code, signal }));
    });
}
