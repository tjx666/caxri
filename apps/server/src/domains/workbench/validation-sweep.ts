/**
 * How long a finished all-Session sweep answers the next request. Desktop asks for a sweep on both `activate` and
 * `browser-window-focus`, and one click into the app fires both, so about half the sweeps in a day of use arrived under
 * a second after the previous one, each re-running `git worktree list` and `git rev-parse` for every owning Project. A
 * root removed in the meantime is still caught by the next focus after this window, or sooner by the shell-hook
 * validation that follows an Agent's commands.
 */
const SWEEP_REUSE_MS = 5_000;

/**
 * Coalesces focus-driven Workbench Root sweeps: a request while one runs joins it, and a request shortly after one
 * finished reuses its result. A failed sweep answers nobody after it settles, so the next request retries.
 */
export class ValidationSweep {
    private running?: Promise<void>;
    private settledAt = -Infinity;

    constructor(
        private readonly sweep: () => Promise<void>,
        private readonly now: () => number = () => performance.now(),
    ) {}

    async run(): Promise<void> {
        if (this.running) return this.running;
        if (this.now() - this.settledAt < SWEEP_REUSE_MS) return;
        const running = this.sweep();
        this.running = running;
        try {
            await running;
            this.settledAt = this.now();
        } finally {
            this.running = undefined;
        }
    }
}
