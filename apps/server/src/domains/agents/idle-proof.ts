import type { AgentLifecycleSignal } from './hooks/contract';

/**
 * Native prompt input requires positive completion evidence. Metadata, silence and a timer-released parent Stop do not
 * prove that Enter will reach an ordinary prompt rather than a permission dialog or unfinished native operation.
 */
export class AgentIdleProof {
    private readonly settled = new Map<string, { launchId: string; turnId: string }>();

    invalidate(terminalId: string): void {
        this.settled.delete(terminalId);
    }

    apply(signal: AgentLifecycleSignal, isDirectHook: boolean): void {
        if (
            !isDirectHook ||
            signal.agentId ||
            signal.phase !== 'turnFinished' ||
            !signal.agentTurnId
        )
            return;
        this.settled.set(signal.terminalId, {
            launchId: signal.launchId,
            turnId: signal.agentTurnId,
        });
    }

    matches(terminalId: string, launchId: string, turnId: string): boolean {
        const proof = this.settled.get(terminalId);
        return proof?.launchId === launchId && proof.turnId === turnId;
    }

    clear(): void {
        this.settled.clear();
    }
}
