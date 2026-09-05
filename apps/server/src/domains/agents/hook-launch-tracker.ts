interface HookTurn {
    launchId: string;
    startedAt: number;
}

/**
 * Bound on how long a hook-reported turn keeps a probe without provider evidence from demoting `running`. Matches the
 * subagent stale timeout in `work-tracker.ts`: a Claude `Stop` hook can be lost, and the running-turn watchdog only
 * covers Codex, so after this window an `unknown` reading is allowed through again rather than pinning `running`.
 */
export const HOOK_TURN_PRESERVE_MS = 30 * 60_000;

/**
 * Tracks, per Terminal, which launch the hook bridge last spoke for so probes can defer to it.
 *
 * Two facts are kept per Terminal, both scoped to a launch id so a relaunch of the same Terminal never inherits them:
 *
 * - **authoritative**: the hook reported a turn boundary (`turnFinished`, or the equivalent lifecycle end). A probe then
 *   preserves the current activity state instead of re-deriving it from provider metadata.
 * - **turn in flight**: the hook reported `turnStarted` and no `turnFinished` has been applied yet. A probe that only
 *   proves the process is alive (`unknown`) must not demote the hook-established `running` (issue #568); a probed
 *   `completed`/`waiting` still ends the turn as the lost-`Stop` fallback, and the flag expires after
 *   {@link HOOK_TURN_PRESERVE_MS}.
 */
export class HookLaunchTracker {
    private readonly authoritativeLaunchIds = new Map<string, string>();
    private readonly turns = new Map<string, HookTurn>();

    constructor(private readonly now: () => number = Date.now) {}

    markAuthoritative(terminalId: string, launchId: string): void {
        this.authoritativeLaunchIds.set(terminalId, launchId);
        this.turns.delete(terminalId);
    }

    markTurnStarted(terminalId: string, launchId: string): void {
        this.authoritativeLaunchIds.delete(terminalId);
        this.turns.set(terminalId, { launchId, startedAt: this.now() });
    }

    isAuthoritative(terminalId: string, launchId: string | undefined): boolean {
        const hookLaunchId = this.authoritativeLaunchIds.get(terminalId);
        return hookLaunchId !== undefined && hookLaunchId === launchId;
    }

    isTurnInFlight(terminalId: string, launchId: string | undefined): boolean {
        const turn = this.turns.get(terminalId);
        if (!turn || turn.launchId !== launchId) return false;
        if (this.now() - turn.startedAt <= HOOK_TURN_PRESERVE_MS) return true;
        this.turns.delete(terminalId);
        return false;
    }

    forget(terminalId: string): void {
        this.authoritativeLaunchIds.delete(terminalId);
        this.turns.delete(terminalId);
    }

    clear(): void {
        this.authoritativeLaunchIds.clear();
        this.turns.clear();
    }
}
