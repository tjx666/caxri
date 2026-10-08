import type { AgentActivityState } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

interface HookTurn {
    launchId: string;
    startedAt: number;
    lastEvidenceAt: number;
    unknownSince?: number;
    unknownCount: number;
    timer?: NodeJS.Timeout;
}

interface HookAuthority {
    launchId: string;
    settledTurnId?: string;
}

/**
 * Final bound for a hook-reported turn whose completion never arrives. Repeated unknown probes also have a shorter
 * evidence-based recovery path; neither expiry fabricates a completed turn or interrupts the process.
 */
export const HOOK_TURN_PRESERVE_MS = 30 * 60_000;
/**
 * Production window of missing evidence a hook turn survives before recovery releases it. Focused Electron coverage may
 * shorten it through `e2e-options.ts`; nothing else overrides it.
 */
export const UNKNOWN_RECOVERY_MS = 2 * 60_000;
export const UNKNOWN_RECOVERY_PROBES = 3;

interface HookTurnExpiry {
    reason: 'unknownEvidence' | 'hardTimeout';
    unknownCount: number;
    durationMs: number;
}

export function createRecoveringHookLaunchTracker(
    isCurrent: (terminalId: string, launchId: string) => boolean,
    probe: (terminalId: string) => void,
    logger: StructuredLogger,
    unknownRecoveryMs?: number,
): HookLaunchTracker {
    return new HookLaunchTracker(
        () => Date.now(),
        (terminalId, launchId) => {
            if (isCurrent(terminalId, launchId)) probe(terminalId);
        },
        (terminalId, launchId, expiry) => {
            if (!isCurrent(terminalId, launchId)) return;
            logger.write('info', logEventCatalog.agent.hookTurnExpired, {
                durationMs: expiry.durationMs,
                fields: { terminalId, reason: expiry.reason, unknownCount: expiry.unknownCount },
            });
        },
        (terminalId, launchId, reason) => {
            if (isCurrent(terminalId, launchId))
                logger.write('info', logEventCatalog.agent.hookTurnInterrupted, {
                    fields: { terminalId, reason },
                });
        },
        unknownRecoveryMs,
    );
}

/**
 * Tracks, per Terminal, which launch the hook bridge last spoke for so probes can defer to it.
 *
 * Two facts are kept per Terminal, both scoped to a launch id so a relaunch of the same Terminal never inherits them:
 *
 * - **authoritative**: the hook reported a turn boundary or an attention request. A probe then preserves the current
 *   activity state instead of re-deriving it from provider metadata. Settled boundaries retain their opaque turn ID so
 *   a later ordered Codex turn can recover a missing start hook without weakening attention authority.
 * - **turn in flight**: the hook reported `turnStarted` and no `turnFinished` has been applied yet. A probe that only
 *   proves the process is alive (`unknown`) preserves running until three unknown observations and two minutes without
 *   evidence. A real, silent generation with no hooks or readable metadata can also lose its running cue: unknown is
 *   deliberately uncertainty, never a completion claim. A probed `completed`/`waiting` ends the turn as the lost-Stop
 *   fallback; {@link HOOK_TURN_PRESERVE_MS} remains the hard bound.
 */
export class HookLaunchTracker {
    private readonly authorities = new Map<string, HookAuthority>();
    private readonly turns = new Map<string, HookTurn>();

    constructor(
        private readonly now: () => number = () => Date.now(),
        private readonly onProbe?: (terminalId: string, launchId: string) => void,
        private readonly onExpired?: (
            terminalId: string,
            launchId: string,
            expiry: HookTurnExpiry,
        ) => void,
        private readonly onInterrupted?: (
            terminalId: string,
            launchId: string,
            reason: 'escape' | 'signal',
        ) => void,
        /**
         * Production window; focused Electron coverage shortens it so the recovery wiring is provable in seconds. The
         * production value and its three-probe rule are pinned by `__tests__/hook-launch-tracker.test.ts`.
         */
        private readonly unknownRecoveryMs: number = UNKNOWN_RECOVERY_MS,
    ) {}

    private clearTurn(terminalId: string): void {
        clearTimeout(this.turns.get(terminalId)?.timer);
        this.turns.delete(terminalId);
    }

    private expire(terminalId: string, turn: HookTurn, reason: HookTurnExpiry['reason']): void {
        this.clearTurn(terminalId);
        this.onExpired?.(terminalId, turn.launchId, {
            reason,
            unknownCount: turn.unknownCount,
            durationMs: this.now() - turn.startedAt,
        });
    }

    private arm(terminalId: string, turn: HookTurn): void {
        clearTimeout(turn.timer);
        if (!this.onProbe && !this.onExpired) return;
        const hardDeadline = turn.startedAt + HOOK_TURN_PRESERVE_MS + 1;
        const recoveryDeadline =
            turn.unknownSince === undefined
                ? Infinity
                : Math.max(turn.lastEvidenceAt, turn.unknownSince) + this.unknownRecoveryMs;
        const nextProbe =
            turn.unknownCount > 0 && turn.unknownCount < UNKNOWN_RECOVERY_PROBES
                ? this.now() + this.unknownRecoveryMs / (UNKNOWN_RECOVERY_PROBES - 1)
                : Infinity;
        const deadline = Math.min(
            hardDeadline,
            nextProbe,
            turn.unknownCount >= UNKNOWN_RECOVERY_PROBES ? recoveryDeadline : Infinity,
        );
        turn.timer = setTimeout(
            () => {
                if (this.turns.get(terminalId) !== turn) return;
                const reason =
                    this.now() >= hardDeadline
                        ? 'hardTimeout'
                        : turn.unknownCount >= UNKNOWN_RECOVERY_PROBES &&
                            this.now() >= recoveryDeadline
                          ? 'unknownEvidence'
                          : undefined;
                if (reason) this.expire(terminalId, turn, reason);
                else this.arm(terminalId, turn);
                this.onProbe?.(terminalId, turn.launchId);
            },
            Math.max(0, deadline - this.now()),
        );
        turn.timer.unref();
    }

    /**
     * Any accepted hook or trustworthy running probe breaks a sequence of missing evidence.
     */
    observeEvidence(terminalId: string, launchId: string | undefined): void {
        const turn = this.turns.get(terminalId);
        if (!turn || turn.launchId !== launchId) return;
        turn.lastEvidenceAt = this.now();
        turn.unknownCount = 0;
        turn.unknownSince = undefined;
        this.arm(terminalId, turn);
    }

    /**
     * Quiet turns need scheduled observations too; Terminal output is not a recovery clock.
     */
    observeUnknown(terminalId: string, launchId: string | undefined): void {
        const turn = this.turns.get(terminalId);
        if (!turn || turn.launchId !== launchId) return;
        turn.unknownSince ??= this.now();
        turn.unknownCount += 1;
        if (
            turn.unknownCount >= UNKNOWN_RECOVERY_PROBES &&
            this.now() >= Math.max(turn.lastEvidenceAt, turn.unknownSince) + this.unknownRecoveryMs
        )
            this.expire(terminalId, turn, 'unknownEvidence');
        else this.arm(terminalId, turn);
    }

    observeSettled(terminalId: string, launchId: string | undefined): void {
        if (this.turns.get(terminalId)?.launchId === launchId) this.clearTurn(terminalId);
    }

    /**
     * Preserve hook boundaries while missing metadata alone cannot disprove an active turn (issue #568).
     */
    ownsProbe(
        terminalId: string,
        launchId: string | undefined,
        status: AgentActivityState,
        latestTurnId?: string,
    ): boolean {
        if (status === 'unknown') this.observeUnknown(terminalId, launchId);
        else if (status === 'running') this.observeEvidence(terminalId, launchId);
        else this.observeSettled(terminalId, launchId);
        const authority = this.authorities.get(terminalId);
        /**
         * Codex's latest durable turn can prove that work advanced beyond an earlier hooked completion even when the
         * next `turnStarted` was lost. Exact hook turn probes never take this path, and other providers do not expose
         * the same ordered turn history.
         */
        if (
            latestTurnId !== undefined &&
            status === 'running' &&
            authority?.settledTurnId !== undefined &&
            authority.settledTurnId !== latestTurnId &&
            authority.launchId === launchId
        )
            this.authorities.delete(terminalId);
        return (
            this.isAuthoritative(terminalId, launchId) ||
            (status === 'unknown' && this.isTurnInFlight(terminalId, launchId))
        );
    }

    markAuthoritative(terminalId: string, launchId: string, settledTurnId?: string): void {
        this.authorities.set(terminalId, { launchId, settledTurnId });
        this.clearTurn(terminalId);
    }

    markTurnStarted(terminalId: string, launchId: string): void {
        this.authorities.delete(terminalId);
        this.clearTurn(terminalId);
        const turn = {
            launchId,
            startedAt: this.now(),
            lastEvidenceAt: this.now(),
            unknownCount: 0,
        };
        this.turns.set(terminalId, turn);
        this.arm(terminalId, turn);
    }

    /**
     * Ends the in-flight turn without granting authority: the user interrupted the Agent at the PTY (a standalone
     * Escape), and neither provider promises a `Stop` hook for that path. Claude documents that `Stop` does not run for
     * a user interrupt (https://docs.anthropic.com/en/docs/claude-code/hooks#stop), and Codex aborts the same way. The
     * next probe re-derives the activity state from provider evidence, or demotes an `unknown` reading as it did before
     * the turn started, instead of pinning `running` for {@link HOOK_TURN_PRESERVE_MS} even though the Agent is back at
     * its prompt.
     *
     * The keystroke is taken at face value: an Escape the TUI consumes for something else (dismissing a picker) also
     * drops the turn, which is the bounded, self-healing side of the trade because the next lifecycle hook
     * re-establishes `running`. Unlike the other mutators this one is not launch-scoped: the coordinator forgets the
     * Terminal on every launch boundary, so only the current launch's turn can be present here.
     */
    markTurnInterrupted(
        terminalId: string,
        reason: 'escape' | 'signal' = 'escape',
        hasPendingAttention = false,
    ): boolean {
        /**
         * Waiting replaces the running turn with authority, so cancellation must release that authority too.
         */
        const turn =
            this.turns.get(terminalId) ??
            (hasPendingAttention ? this.authorities.get(terminalId) : undefined);
        if (!turn) return false;
        this.forget(terminalId);
        this.onInterrupted?.(terminalId, turn.launchId, reason);
        return true;
    }

    isAuthoritative(terminalId: string, launchId: string | undefined): boolean {
        const authority = this.authorities.get(terminalId);
        return authority !== undefined && authority.launchId === launchId;
    }

    isTurnInFlight(terminalId: string, launchId: string | undefined): boolean {
        const turn = this.turns.get(terminalId);
        if (!turn || turn.launchId !== launchId) return false;
        if (this.now() - turn.startedAt <= HOOK_TURN_PRESERVE_MS) return true;
        this.expire(terminalId, turn, 'hardTimeout');
        return false;
    }

    forget(terminalId: string): void {
        this.authorities.delete(terminalId);
        this.clearTurn(terminalId);
    }

    clear(): void {
        this.authorities.clear();
        for (const terminalId of this.turns.keys()) this.clearTurn(terminalId);
    }
}
