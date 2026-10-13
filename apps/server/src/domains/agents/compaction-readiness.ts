import type { AgentLifecycleSignal } from './hooks/contract';

interface Proof {
    launchId: string;
    turnId: string;
}

/**
 * A finished turn alone does not prove an empty composer: users can type their next draft while the Agent works.
 * Require an observed standalone Enter, a subsequent authenticated turn start, and no intervening input through
 * completion. Unknown edits, queued prompts, paste contents, and restored processes fail closed. No text is retained.
 */
export class CompactionReadiness {
    private readonly submitted = new Set<string>();
    private readonly pasting = new Set<string>();
    private readonly pending = new Map<string, Proof>();
    private readonly ready = new Map<string, Proof>();

    input(terminalId: string, data: string): void {
        this.pending.delete(terminalId);
        this.ready.delete(terminalId);
        this.submitted.delete(terminalId);
        if (data.includes('\u{1B}[200~')) this.pasting.add(terminalId);
        if (data === '\r' && !this.pasting.has(terminalId)) this.submitted.add(terminalId);
        if (data.includes('\u{1B}[201~')) this.pasting.delete(terminalId);
    }

    observe(signal: AgentLifecycleSignal): void {
        if (signal.agentId || signal.agentTurnContinues || signal.agentBackgroundWork) return;
        const { terminalId, launchId, agentTurnId: turnId, phase } = signal;
        switch (phase) {
            case 'turnStarted': {
                this.ready.delete(terminalId);
                this.pending.delete(terminalId);
                if (turnId && this.submitted.delete(terminalId))
                    this.pending.set(terminalId, { launchId, turnId });

                break;
            }
            case 'turnFinished': {
                const pending = this.pending.get(terminalId);
                if (pending?.launchId === launchId && pending.turnId === turnId)
                    this.ready.set(terminalId, pending);

                break;
            }
            case 'attentionRequested':
            case 'turnFailed':
            case 'compactionStarted':
            case 'compactionFinished':
            case 'sessionIdentified': {
                this.forget(terminalId);

                break;
            }
            // No default
        }
    }

    proof(terminalId: string): Proof | undefined {
        return this.ready.get(terminalId);
    }

    forget(terminalId: string): void {
        this.submitted.delete(terminalId);
        this.pasting.delete(terminalId);
        this.pending.delete(terminalId);
        this.ready.delete(terminalId);
    }
}
