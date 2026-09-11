import type { AgentProvider } from '@caxri/protocol';

import type { ShellPromotionCandidate } from './shell-promotion';

const MAX_PROCESS_PROBES = 5;
const MISSES_TO_CONFIRM_EXIT = 2;
const PROCESS_PROBE_INTERVAL_MS = 1_000;

interface ShellProcessProbeOptions {
    detect: (shellPid: number) => Promise<AgentProvider | undefined>;
    intervalMs?: number;
    isCurrent: (terminalId: string, candidate: ShellPromotionCandidate) => boolean;
    isWatchCurrent: (terminalId: string, provider: AgentProvider) => boolean;
    onConfirmed: (
        terminalId: string,
        provider: AgentProvider,
        candidate: ShellPromotionCandidate,
    ) => boolean;
    onError: (terminalId: string, error: unknown) => void;
    onExhausted: (terminalId: string, candidate: ShellPromotionCandidate) => void;
    onInactive: (terminalId: string, provider: AgentProvider) => void;
}

interface ForegroundAgentWatch {
    misses: number;
    provider: AgentProvider;
    shellPid: number;
    timer?: NodeJS.Timeout;
}

/**
 * Runs bounded, spaced foreground-process probes. Shell command echo can arrive before the submitted child owns the
 * foreground group, so a timer retries even when a quiet Agent emits no second output chunk.
 */
export class ShellProcessProbe {
    private readonly inFlight = new Map<string, ShellPromotionCandidate>();
    private readonly intervalMs: number;
    private readonly timers = new Map<
        string,
        { candidate: ShellPromotionCandidate; timer: NodeJS.Timeout }
    >();
    private readonly watches = new Map<string, ForegroundAgentWatch>();

    constructor(private readonly options: ShellProcessProbeOptions) {
        this.intervalMs = options.intervalMs ?? PROCESS_PROBE_INTERVAL_MS;
    }

    private schedule(
        terminalId: string,
        shellPid: number,
        candidate: ShellPromotionCandidate,
    ): void {
        const existing = this.timers.get(terminalId);
        if (existing?.candidate === candidate) return;
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(
            () => {
                if (this.timers.get(terminalId)?.timer !== timer) return;
                this.timers.delete(terminalId);
                if (this.options.isCurrent(terminalId, candidate))
                    this.observe(terminalId, shellPid, candidate);
            },
            Math.max(0, candidate.nextProcessProbeAt - Date.now()),
        );
        timer.unref();
        this.timers.set(terminalId, { candidate, timer });
    }

    private async detect(
        terminalId: string,
        shellPid: number,
        candidate: ShellPromotionCandidate,
    ): Promise<void> {
        try {
            const provider = await this.options.detect(shellPid);
            if (!this.options.isCurrent(terminalId, candidate)) return;
            const confirmed =
                provider !== undefined &&
                (!candidate.provider || candidate.provider === provider) &&
                this.options.onConfirmed(terminalId, provider, candidate);
            if (confirmed) {
                this.watch(terminalId, shellPid, provider);
            } else {
                this.schedule(terminalId, shellPid, candidate);
            }
        } catch (error) {
            this.options.onError(terminalId, error);
            if (this.options.isCurrent(terminalId, candidate))
                this.schedule(terminalId, shellPid, candidate);
        } finally {
            if (this.inFlight.get(terminalId) === candidate) this.inFlight.delete(terminalId);
        }
    }

    /**
     * Keeps only interactive availability in sync for an unmanaged foreground Agent. Two consecutive identity misses
     * avoid revoking availability during a transient process-list race; no process ID or signal authority is retained.
     */
    private watch(terminalId: string, shellPid: number, provider: AgentProvider): void {
        const existing = this.watches.get(terminalId);
        if (existing?.timer) clearTimeout(existing.timer);
        const watch: ForegroundAgentWatch = { misses: 0, provider, shellPid };
        this.watches.set(terminalId, watch);
        this.scheduleWatch(terminalId, watch);
    }

    private scheduleWatch(terminalId: string, watch: ForegroundAgentWatch): void {
        if (
            this.watches.get(terminalId) !== watch ||
            !this.options.isWatchCurrent(terminalId, watch.provider)
        ) {
            this.watches.delete(terminalId);
            return;
        }
        const timer = setTimeout(() => {
            if (this.watches.get(terminalId) !== watch || watch.timer !== timer) return;
            watch.timer = undefined;
            // eslint-disable-next-line no-void -- the bounded observer owns and logs its asynchronous failures
            void this.inspectWatch(terminalId, watch);
        }, this.intervalMs);
        timer.unref();
        watch.timer = timer;
    }

    private async inspectWatch(terminalId: string, watch: ForegroundAgentWatch): Promise<void> {
        try {
            const provider = await this.options.detect(watch.shellPid);
            if (this.watches.get(terminalId) !== watch) return;
            watch.misses = provider === watch.provider ? 0 : watch.misses + 1;
            if (watch.misses >= MISSES_TO_CONFIRM_EXIT) {
                this.watches.delete(terminalId);
                this.options.onInactive(terminalId, watch.provider);
                return;
            }
        } catch (error) {
            this.options.onError(terminalId, error);
            if (this.watches.get(terminalId) !== watch) return;
        }
        this.scheduleWatch(terminalId, watch);
    }

    observe(terminalId: string, shellPid: number, candidate: ShellPromotionCandidate): void {
        if (this.inFlight.get(terminalId) === candidate) return;
        const now = Date.now();
        if (now < candidate.nextProcessProbeAt) {
            /**
             * Timer delivery and wall-clock deadlines can differ slightly. Keep the retry armed when an early callback
             * has already removed its timer, otherwise a quiet Agent is never detected.
             */
            this.schedule(terminalId, shellPid, candidate);
            return;
        }
        if (candidate.processProbes >= MAX_PROCESS_PROBES) {
            this.options.onExhausted(terminalId, candidate);
            return;
        }
        candidate.processProbes += 1;
        candidate.nextProcessProbeAt = now + this.intervalMs;
        this.inFlight.set(terminalId, candidate);
        /**
         * Detection owns its recoverable error path; synchronous output observers cannot await it.
         */
        // eslint-disable-next-line no-void -- see comment above
        void this.detect(terminalId, shellPid, candidate);
    }

    cancel(terminalId: string): void {
        const scheduled = this.timers.get(terminalId);
        if (scheduled) clearTimeout(scheduled.timer);
        this.timers.delete(terminalId);
        this.inFlight.delete(terminalId);
        const watch = this.watches.get(terminalId);
        if (watch?.timer) clearTimeout(watch.timer);
        this.watches.delete(terminalId);
    }

    close(): void {
        for (const { timer } of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.inFlight.clear();
        for (const watch of this.watches.values()) if (watch.timer) clearTimeout(watch.timer);
        this.watches.clear();
    }
}
