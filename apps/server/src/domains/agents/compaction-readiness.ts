import type { AgentLifecycleSignal } from './hooks/contract';

interface Proof {
    launchId: string;
    turnId: string;
    /**
     * Earned by an interrupt of a turn whose composer was proven empty (see {@link CompactionReadiness.armInterrupt}),
     * not by a completed turn, so no idle proof will ever match it.
     */
    interrupted?: true;
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
    private readonly interrupting = new Map<string, Proof>();
    /**
     * Pending turns that reached a tool. Claude Code and Codex put a prompt back into the composer when it is
     * interrupted before the model answered, so only a turn that visibly got going has an empty composer after Escape.
     */
    private readonly progressed = new Set<string>();

    /**
     * Airplane Mode interrupts a running turn so it can compact it before going offline. A turn still pending here was
     * submitted by a standalone Enter with no input since, so its composer is empty; if it already reached a tool and
     * the very next input is the standalone Escape that interrupts it, the composer is still empty afterwards and the
     * turn becomes ready. Any other input or lifecycle signal in between cancels the arm.
     */
    armInterrupt(terminalId: string, launchId: string): boolean {
        const pending = this.pending.get(terminalId);
        if (pending?.launchId !== launchId || !this.progressed.has(terminalId)) return false;
        this.interrupting.set(terminalId, pending);
        return true;
    }

    input(terminalId: string, data: string): void {
        const interrupting = this.interrupting.get(terminalId);
        this.interrupting.delete(terminalId);
        this.progressed.delete(terminalId);
        this.pending.delete(terminalId);
        this.ready.delete(terminalId);
        this.submitted.delete(terminalId);
        if (data.includes('\u{1B}[200~')) this.pasting.add(terminalId);
        if (data === '\r' && !this.pasting.has(terminalId)) this.submitted.add(terminalId);
        if (data.includes('\u{1B}[201~')) this.pasting.delete(terminalId);
        if (interrupting && data === '\u{1B}')
            this.ready.set(terminalId, { ...interrupting, interrupted: true });
    }

    observe(signal: AgentLifecycleSignal): void {
        if (signal.agentId || signal.agentTurnContinues || signal.agentBackgroundWork) return;
        const { terminalId, launchId, agentTurnId: turnId, phase } = signal;
        switch (phase) {
            case 'turnStarted': {
                this.interrupting.delete(terminalId);
                this.progressed.delete(terminalId);
                this.ready.delete(terminalId);
                this.pending.delete(terminalId);
                if (turnId && this.submitted.delete(terminalId))
                    this.pending.set(terminalId, { launchId, turnId });

                break;
            }
            case 'shellToolStarted':
            case 'shellToolFinished':
            case 'shellToolFailed':
            case 'toolBatchFinished': {
                if (this.pending.get(terminalId)?.launchId === launchId)
                    this.progressed.add(terminalId);

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
        this.interrupting.delete(terminalId);
        this.progressed.delete(terminalId);
        this.submitted.delete(terminalId);
        this.pasting.delete(terminalId);
        this.pending.delete(terminalId);
        this.ready.delete(terminalId);
    }
}
