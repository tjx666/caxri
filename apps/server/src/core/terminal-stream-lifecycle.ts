import { CaxriError } from '@caxri/protocol';

export interface TerminalDetachTransition {
    complete(): void;
    waitForPriorOperations(): Promise<void>;
}

interface TerminalLifecycleState {
    generation: number;
    tail: Promise<void>;
}

/**
 * Establishes one authoritative order for Terminal mutations that arrive over the control and binary transports.
 * Generations invalidate operations authorized before a detach, while the detach barrier prevents newer work from
 * reaching the domain until every older operation and the detach itself have settled.
 */
export class TerminalStreamLifecycle {
    private readonly terminals = new Map<string, TerminalLifecycleState>();

    private stateFor(terminalId: string): TerminalLifecycleState {
        const existing = this.terminals.get(terminalId);
        if (existing) return existing;
        const state = { generation: 0, tail: Promise.resolve() };
        this.terminals.set(terminalId, state);
        return state;
    }

    beginDetach(terminalId: string): TerminalDetachTransition {
        const state = this.stateFor(terminalId);
        const priorOperations = state.tail;
        state.generation += 1;
        const gate = Promise.withResolvers<void>();
        state.tail = (async () => {
            await priorOperations;
            await gate.promise;
        })();
        return {
            complete: () => gate.resolve(),
            waitForPriorOperations: () => priorOperations,
        };
    }

    generationFor(terminalId: string): number {
        return this.stateFor(terminalId).generation;
    }

    isCurrent(terminalId: string, generation: number): boolean {
        return this.stateFor(terminalId).generation === generation;
    }

    run<Result>(
        terminalId: string,
        generation: number,
        action: () => Promise<Result>,
    ): Promise<Result> {
        const state = this.stateFor(terminalId);
        if (generation !== state.generation)
            return Promise.reject(
                new CaxriError('CANCELLED', 'Terminal stream authorization is stale'),
            );
        const priorOperations = state.tail;
        const scheduled = (async () => {
            await priorOperations;
            if (generation !== state.generation)
                throw new CaxriError('CANCELLED', 'Terminal stream authorization is stale');
            return action();
        })();
        state.tail = (async () => {
            try {
                await scheduled;
            } catch {
                // The caller owns the failure while later lifecycle work remains ordered.
            }
        })();
        return scheduled;
    }

    clear(): void {
        this.terminals.clear();
    }
}
