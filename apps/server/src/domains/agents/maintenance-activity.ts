import type { AgentLifecycleSignal } from './hooks/contract';

type Launch = Pick<AgentLifecycleSignal, 'launchId' | 'provider' | 'terminalId'>;
type Turn = Launch & Pick<AgentLifecycleSignal, 'agentTurnId'>;
type Pending = Launch & { timer: ReturnType<typeof setTimeout>; token: symbol };

/**
 * A late delivery callback may cancel only its own still-pending input.
 */
export interface MaintenanceInputLease {
    cancel(): void;
}

const isSameLaunch = (left: Launch, right: Launch): boolean =>
    left.launchId === right.launchId && left.provider === right.provider;

/**
 * Classifies the next main turn of an admitted maintenance input, without trusting provider hook payloads. Pending
 * intent is bounded; a new ordinary turn or retired launch cannot inherit an old maintenance marker.
 */
export class MaintenanceActivity {
    private readonly pending = new Map<string, Pending>();
    private readonly active = new Map<string, Turn>();

    constructor(private readonly pendingTimeoutMs: number) {}

    arm(launch: Launch): MaintenanceInputLease {
        this.cancelPending(launch.terminalId);
        const token = Symbol('maintenance');
        const cancel = (): void => {
            if (this.pending.get(launch.terminalId)?.token === token)
                this.cancelPending(launch.terminalId);
        };
        const timer = setTimeout(cancel, this.pendingTimeoutMs);
        timer.unref();
        this.pending.set(launch.terminalId, { ...launch, timer, token });
        return { cancel };
    }

    cancelPending(terminalId: string): void {
        const pending = this.pending.get(terminalId);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(terminalId);
    }

    classify(signal: AgentLifecycleSignal): AgentLifecycleSignal {
        if (signal.agentId !== undefined) return signal;
        const active = this.active.get(signal.terminalId);
        if (signal.phase === 'turnStarted') {
            const pending = this.pending.get(signal.terminalId);
            if (signal.activity === 'maintenance' || (pending && isSameLaunch(pending, signal))) {
                this.cancelPending(signal.terminalId);
                this.active.set(signal.terminalId, signal);
                return { ...signal, activity: 'maintenance' };
            }
            if (active && isSameLaunch(active, signal)) {
                if (signal.agentTurnId && signal.agentTurnId === active.agentTurnId)
                    return { ...signal, activity: 'maintenance' };
                this.active.delete(signal.terminalId);
            }
        } else if (
            active &&
            isSameLaunch(active, signal) &&
            (signal.phase === 'turnFinished' || signal.phase === 'turnFailed') &&
            (!active.agentTurnId ||
                !signal.agentTurnId ||
                active.agentTurnId === signal.agentTurnId)
        ) {
            this.active.delete(signal.terminalId);
            return { ...signal, activity: 'maintenance' };
        }
        return signal;
    }

    forget(terminalId: string): void {
        this.cancelPending(terminalId);
        this.active.delete(terminalId);
    }

    clear(): void {
        for (const terminalId of this.pending.keys()) this.cancelPending(terminalId);
        this.active.clear();
    }
}
