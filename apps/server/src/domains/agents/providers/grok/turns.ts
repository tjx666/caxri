import type { AgentLifecycleSignal } from '../../hooks/contract';

/**
 * Prevents an old conversation or delayed completion from settling a newer turn in the same PTY.
 */
export class GrokTurnTracker {
    private readonly turns = new Map<string, string>();

    forget(terminalId: string): void {
        this.turns.delete(terminalId);
    }

    accept(signal: AgentLifecycleSignal, sessionId?: string): boolean {
        if (signal.provider !== 'grok') return true;
        if (signal.phase === 'sessionIdentified') {
            this.forget(signal.terminalId);
            return Boolean(signal.agentSessionId);
        }
        if (!signal.agentSessionId || signal.agentSessionId !== sessionId) return false;
        if (signal.phase === 'turnStarted' && !signal.agentTurnId) return false;
        if (signal.phase === 'turnStarted' && signal.agentTurnId)
            this.turns.set(signal.terminalId, signal.agentTurnId);
        if (signal.phase === 'turnFinished' || signal.phase === 'turnFailed') {
            if (!signal.agentTurnId || this.turns.get(signal.terminalId) !== signal.agentTurnId)
                return false;
            this.forget(signal.terminalId);
        }
        return true;
    }
}
