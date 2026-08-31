import type { AgentLifecycleSignal } from './hooks/contract';

/**
 * Correlates permission requests with the provider Agent scope whose full tool batch must finish. Claude's
 * PermissionRequest omits `tool_use_id`, while PostToolBatch runs only after every parallel call in that scope
 * resolves.
 */
export class AgentAttentionTracker {
    private readonly pendingScopesByTerminal = new Map<string, Set<string>>();

    private scope(signal: AgentLifecycleSignal): string {
        return signal.agentId ? `subagent:${signal.agentId}` : 'main';
    }

    request(signal: AgentLifecycleSignal): void {
        let pending = this.pendingScopesByTerminal.get(signal.terminalId);
        if (!pending) {
            pending = new Set();
            this.pendingScopesByTerminal.set(signal.terminalId, pending);
        }
        pending.add(this.scope(signal));
    }

    resolvesFinalRequest(signal: AgentLifecycleSignal): boolean {
        const pending = this.pendingScopesByTerminal.get(signal.terminalId);
        if (!pending?.delete(this.scope(signal))) return false;
        if (pending.size > 0) return false;
        this.pendingScopesByTerminal.delete(signal.terminalId);
        return true;
    }

    forget(terminalId: string): void {
        this.pendingScopesByTerminal.delete(terminalId);
    }

    clear(): void {
        this.pendingScopesByTerminal.clear();
    }
}
