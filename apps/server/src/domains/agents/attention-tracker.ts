import type { AgentLifecycleSignal } from './hooks/contract';

/**
 * Correlates permission requests with the provider Agent scope whose full tool batch must finish. Claude's
 * PermissionRequest omits `tool_use_id`, while PostToolBatch runs only after every parallel call in that scope
 * resolves. Tool-level question outcomes remove only their exact request, preserving concurrent approvals and
 * questions.
 */
export class AgentAttentionTracker {
    private readonly pendingScopesByTerminal = new Map<string, Map<string, Set<string>>>();

    private scope(signal: AgentLifecycleSignal): string {
        return signal.agentId ? `subagent:${signal.agentId}` : 'main';
    }

    private resolvesFinalRequest(signal: AgentLifecycleSignal): boolean {
        const pending = this.pendingScopesByTerminal.get(signal.terminalId);
        const scope = this.scope(signal);
        const requests = pending?.get(scope);
        if (!pending || !requests) return false;
        if (signal.phase === 'attentionResolved') {
            if (!signal.agentToolUseId || !requests.delete(signal.agentToolUseId)) return false;
            if (requests.size > 0) return false;
        }
        pending.delete(scope);
        if (pending.size > 0) return false;
        this.pendingScopesByTerminal.delete(signal.terminalId);
        return true;
    }

    request(signal: AgentLifecycleSignal): void {
        let pending = this.pendingScopesByTerminal.get(signal.terminalId);
        if (!pending) {
            pending = new Map();
            this.pendingScopesByTerminal.set(signal.terminalId, pending);
        }
        const scope = this.scope(signal);
        let requests = pending.get(scope);
        if (!requests) {
            requests = new Set();
            pending.set(scope, requests);
        }
        requests.add(signal.agentToolUseId ?? '');
    }

    allowsLifecycle(signal: AgentLifecycleSignal): boolean {
        if (signal.phase !== 'attentionResolved' && signal.phase !== 'toolBatchFinished')
            return true;
        return this.resolvesFinalRequest(signal);
    }

    forget(terminalId: string): boolean {
        return this.pendingScopesByTerminal.delete(terminalId);
    }

    clear(): void {
        this.pendingScopesByTerminal.clear();
    }
}
