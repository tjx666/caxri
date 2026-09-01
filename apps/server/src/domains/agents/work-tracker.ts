import type { AgentLifecycleSignal } from './hooks/contract';

interface TerminalAgentWork {
    activeSubagents: Map<string, number>;
    deferredParentFinish?: AgentLifecycleSignal;
    staleTimeout?: NodeJS.Timeout;
}

export interface AgentWorkObservation {
    deferCompletion: boolean;
    handled?: boolean;
}

interface AgentWorkTrackerOptions {
    staleTimeoutMs?: number;
}

/**
 * Bounds a lost completion hook without treating total runtime as liveness. Every child-scoped hook refreshes the
 * deadline, and the generous window permits ordinary long-running background tools to stay silent between events.
 */
const DEFAULT_SUBAGENT_STALE_TIMEOUT_MS = 30 * 60_000;

/**
 * Aggregates Claude's main turn and background subagents inside one Terminal launch. Claude can emit the main `Stop`
 * while background subagents are still running, so that signal must remain pending until the last known child stops. A
 * watchdog runs only while completion is deferred and recovers after all remaining children have been silent for the
 * bounded fallback window; it never measures a child's total runtime.
 */
export class AgentWorkTracker {
    private readonly workByTerminal = new Map<string, TerminalAgentWork>();
    private readonly staleTimeoutMs: number;

    constructor(
        private readonly onDeferredParentFinished: (signal: AgentLifecycleSignal) => void,
        options: AgentWorkTrackerOptions = {},
    ) {
        this.staleTimeoutMs = Math.max(
            1,
            options.staleTimeoutMs ?? DEFAULT_SUBAGENT_STALE_TIMEOUT_MS,
        );
    }

    private clearStaleTimeout(work: TerminalAgentWork): void {
        if (work.staleTimeout) clearTimeout(work.staleTimeout);
        work.staleTimeout = undefined;
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

    private subagentStarted(signal: AgentLifecycleSignal): boolean {
        if (!signal.agentId) return false;
        let work = this.workByTerminal.get(signal.terminalId);
        if (!work) {
            work = { activeSubagents: new Map() };
            this.workByTerminal.set(signal.terminalId, work);
        }
        const isNew = !work.activeSubagents.has(signal.agentId);
        work.activeSubagents.set(signal.agentId, Date.now());
        if (work.deferredParentFinish) this.armStaleTimeout(signal.terminalId, work);
        return isNew;
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
        this.clearStaleTimeout(work);
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

    private subagentFinished(signal: AgentLifecycleSignal): AgentLifecycleSignal | undefined {
        if (!signal.agentId) return;
        const work = this.workByTerminal.get(signal.terminalId);
        if (!work?.activeSubagents.delete(signal.agentId)) return;
        if (work.activeSubagents.size > 0) {
            if (work.deferredParentFinish) this.armStaleTimeout(signal.terminalId, work);
            return;
        }
        this.clearStaleTimeout(work);
        this.workByTerminal.delete(signal.terminalId);
        return work.deferredParentFinish;
    }

    observe(signal: AgentLifecycleSignal): AgentWorkObservation {
        if (signal.phase === 'subagentStarted')
            return { deferCompletion: false, handled: this.subagentStarted(signal) };
        if (signal.agentId && signal.phase === 'turnFinished') {
            const deferredParentFinish = this.subagentFinished(signal);
            if (deferredParentFinish) this.onDeferredParentFinished(deferredParentFinish);
            return { deferCompletion: false, handled: Boolean(deferredParentFinish) };
        }
        if (signal.agentId) {
            this.touchSubagent(signal);
            if (signal.phase === 'turnStarted') return { deferCompletion: false, handled: true };
        } else if (signal.phase === 'turnStarted') this.parentStarted(signal.terminalId);
        return {
            deferCompletion: signal.phase === 'turnFinished' && this.deferParentFinish(signal),
        };
    }

    forget(terminalId: string): void {
        const work = this.workByTerminal.get(terminalId);
        if (work) this.clearStaleTimeout(work);
        this.workByTerminal.delete(terminalId);
    }

    clear(): void {
        for (const work of this.workByTerminal.values()) this.clearStaleTimeout(work);
        this.workByTerminal.clear();
    }
}
