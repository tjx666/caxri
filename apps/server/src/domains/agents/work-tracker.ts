import type { AgentLifecycleSignal, AgentSignalDecision } from './hooks/contract';

interface TerminalAgentWork {
    activeSubagents: Map<string, number>;
    deferredParentFinish?: AgentLifecycleSignal;
    /**
     * Bounds the wait for the parent turn to resume after its last background subagent stopped.
     */
    resumeTimeout?: NodeJS.Timeout;
    staleTimeout?: NodeJS.Timeout;
}

/**
 * What one subagent-scoped signal did, in the same closed vocabulary the hook boundary logs. A `boolean` cannot carry
 * this: the ordinary "matched a scope, siblings still running" case and the anomalous "no scope owns this" case both
 * mean the coordinator changes nothing, and collapsing them makes every healthy multi-subagent turn look like a lost
 * hook in the launch aggregate.
 */
export type AgentWorkOutcome = Extract<
    AgentSignalDecision,
    'accepted' | 'subagentPending' | 'subagentUnmatched'
>;

export interface AgentWorkObservation {
    deferCompletion: boolean;
    continuedTurnId?: string;
    outcome?: AgentWorkOutcome;
}

interface AgentWorkTrackerOptions {
    resumeGraceMs?: number;
    staleTimeoutMs?: number;
}

/**
 * Bounds a lost completion hook without treating total runtime as liveness. Every child-scoped hook refreshes the
 * deadline, and the generous window permits ordinary long-running background tools to stay silent between events.
 */
const DEFAULT_SUBAGENT_STALE_TIMEOUT_MS = 30 * 60_000;

/**
 * Claude Code emits the main `Stop` while a background subagent is still running, then resumes the main turn on its own
 * once that subagent stops: `SubagentStop` is followed within roughly 100 ms by a fresh `UserPromptSubmit` and the turn
 * keeps working until a later `Stop` with no pending background tasks. Releasing the deferred parent completion at the
 * final `SubagentStop` therefore produced a spurious `completed` transition, unread badge, and system notification a
 * moment before the turn resumed. The grace window waits for that resume signal instead; a turn that never resumes (an
 * older CLI or an abandoned wait) still settles once the window elapses.
 */
const DEFAULT_RESUME_GRACE_MS = 10_000;

/**
 * Aggregates Claude's main turn and background subagents inside one Terminal launch. Claude can emit the main `Stop`
 * while background subagents are still running, so that signal must remain pending until the last known child stops and
 * the resume grace window passes without a new parent turn. A watchdog runs only while completion is deferred and
 * recovers after all remaining children have been silent for the bounded fallback window; it never measures a child's
 * total runtime.
 */
export class AgentWorkTracker {
    private readonly workByTerminal = new Map<string, TerminalAgentWork>();
    private readonly resumeGraceMs: number;
    private readonly staleTimeoutMs: number;

    constructor(
        private readonly onDeferredParentFinished: (signal: AgentLifecycleSignal) => void,
        options: AgentWorkTrackerOptions = {},
    ) {
        this.resumeGraceMs = Math.max(0, options.resumeGraceMs ?? DEFAULT_RESUME_GRACE_MS);
        this.staleTimeoutMs = Math.max(
            1,
            options.staleTimeoutMs ?? DEFAULT_SUBAGENT_STALE_TIMEOUT_MS,
        );
    }

    private clearStaleTimeout(work: TerminalAgentWork): void {
        if (work.staleTimeout) clearTimeout(work.staleTimeout);
        work.staleTimeout = undefined;
    }

    private clearResumeTimeout(work: TerminalAgentWork): void {
        if (work.resumeTimeout) clearTimeout(work.resumeTimeout);
        work.resumeTimeout = undefined;
    }

    private clearTimeouts(work: TerminalAgentWork): void {
        this.clearStaleTimeout(work);
        this.clearResumeTimeout(work);
    }

    /**
     * Holds the deferred parent completion until the provider either resumes the turn (`parentStarted` cancels it) or
     * stays silent for the grace window, which then releases the completion as the last known state.
     */
    private armResumeTimeout(terminalId: string, work: TerminalAgentWork): void {
        this.clearResumeTimeout(work);
        const timeout = setTimeout(() => {
            work.resumeTimeout = undefined;
            if (this.workByTerminal.get(terminalId) !== work || !work.deferredParentFinish) return;
            const deferredParentFinish = work.deferredParentFinish;
            this.workByTerminal.delete(terminalId);
            this.onDeferredParentFinished(deferredParentFinish);
        }, this.resumeGraceMs);
        timeout.unref();
        work.resumeTimeout = timeout;
    }

    private pruneStaleSubagents(work: TerminalAgentWork): void {
        const staleBefore = Date.now() - this.staleTimeoutMs;
        for (const [agentId, lastEvidenceAt] of work.activeSubagents)
            if (lastEvidenceAt <= staleBefore) work.activeSubagents.delete(agentId);
    }

    private armStaleTimeout(terminalId: string, work: TerminalAgentWork): void {
        this.clearStaleTimeout(work);
        if (!work.deferredParentFinish || work.activeSubagents.size === 0) return;
        const oldestEvidenceAt = Math.min(...work.activeSubagents.values());
        const delay = Math.max(0, oldestEvidenceAt + this.staleTimeoutMs - Date.now());
        const timeout = setTimeout(() => {
            work.staleTimeout = undefined;
            if (this.workByTerminal.get(terminalId) !== work || !work.deferredParentFinish) return;
            this.pruneStaleSubagents(work);
            if (work.activeSubagents.size > 0) {
                this.armStaleTimeout(terminalId, work);
                return;
            }
            const deferredParentFinish = work.deferredParentFinish;
            this.workByTerminal.delete(terminalId);
            this.onDeferredParentFinished(deferredParentFinish);
        }, delay);
        timeout.unref();
        work.staleTimeout = timeout;
    }

    private subagentStarted(signal: AgentLifecycleSignal): AgentWorkOutcome {
        // A subagent phase with no scope id cannot be tracked at all, which is the provider anomaly worth counting.
        if (!signal.agentId) return 'subagentUnmatched';
        let work = this.workByTerminal.get(signal.terminalId);
        if (!work) {
            work = { activeSubagents: new Map() };
            this.workByTerminal.set(signal.terminalId, work);
        }
        const isNew = !work.activeSubagents.has(signal.agentId);
        work.activeSubagents.set(signal.agentId, Date.now());
        this.clearResumeTimeout(work);
        if (work.deferredParentFinish) this.armStaleTimeout(signal.terminalId, work);
        // A repeated start for a scope already tracked refreshes its evidence but opens nothing new.
        return isNew ? 'accepted' : 'subagentPending';
    }

    private touchSubagent(signal: AgentLifecycleSignal): void {
        if (!signal.agentId) return;
        const work = this.workByTerminal.get(signal.terminalId);
        if (!work?.activeSubagents.has(signal.agentId)) return;
        work.activeSubagents.set(signal.agentId, Date.now());
        if (work.deferredParentFinish) this.armStaleTimeout(signal.terminalId, work);
    }

    private parentStarted(terminalId: string): void {
        const work = this.workByTerminal.get(terminalId);
        if (!work) return;
        this.clearTimeouts(work);
        work.deferredParentFinish = undefined;
        if (work.activeSubagents.size === 0) this.workByTerminal.delete(terminalId);
    }

    private deferParentFinish(signal: AgentLifecycleSignal): boolean {
        const work = this.workByTerminal.get(signal.terminalId);
        if (!work) return false;
        this.pruneStaleSubagents(work);
        if (work.activeSubagents.size === 0) {
            this.workByTerminal.delete(signal.terminalId);
            return false;
        }
        work.deferredParentFinish = { ...signal };
        this.armStaleTimeout(signal.terminalId, work);
        return true;
    }

    private subagentFinished(signal: AgentLifecycleSignal): AgentWorkOutcome {
        if (!signal.agentId) return 'subagentUnmatched';
        const work = this.workByTerminal.get(signal.terminalId);
        // No tracked scope owns this completion: its `subagentStarted` hook never arrived.
        if (!work?.activeSubagents.delete(signal.agentId)) return 'subagentUnmatched';
        if (work.activeSubagents.size > 0) {
            if (work.deferredParentFinish) this.armStaleTimeout(signal.terminalId, work);
            // Matched, but siblings are still running, so the parent completion stays deferred.
            return 'subagentPending';
        }
        this.clearStaleTimeout(work);
        // The last child left. A waiting parent finish now gets the resume window; nothing settles synchronously.
        if (work.deferredParentFinish) this.armResumeTimeout(signal.terminalId, work);
        else this.workByTerminal.delete(signal.terminalId);
        return 'subagentPending';
    }

    observe(signal: AgentLifecycleSignal): AgentWorkObservation {
        if (signal.phase === 'subagentStarted')
            return { deferCompletion: false, outcome: this.subagentStarted(signal) };
        /**
         * Claude subagents inherit the parent's hooks, so a Task that ends on an API error sends a scoped `turnFailed`.
         * It retires that child like a scoped finish; it must never reach Session state as the parent turn failing.
         */
        if (signal.agentId && (signal.phase === 'turnFinished' || signal.phase === 'turnFailed'))
            return { deferCompletion: false, outcome: this.subagentFinished(signal) };
        if (signal.agentId) {
            this.touchSubagent(signal);
            if (signal.phase === 'turnStarted')
                return { deferCompletion: false, outcome: 'accepted' };
        } else if (signal.phase === 'turnStarted') {
            const continuedTurnId = this.workByTerminal.get(signal.terminalId)?.deferredParentFinish
                ?.agentTurnId;
            this.parentStarted(signal.terminalId);
            return { deferCompletion: false, continuedTurnId };
        }
        return {
            deferCompletion: signal.phase === 'turnFinished' && this.deferParentFinish(signal),
        };
    }

    forget(terminalId: string): void {
        const work = this.workByTerminal.get(terminalId);
        if (work) this.clearTimeouts(work);
        this.workByTerminal.delete(terminalId);
    }

    clear(): void {
        for (const work of this.workByTerminal.values()) this.clearTimeouts(work);
        this.workByTerminal.clear();
    }
}
