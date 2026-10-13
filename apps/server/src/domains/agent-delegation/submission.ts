import type { AgentDelegationReceipt } from '@caxri/protocol';

import type { AgentDelegationServiceOptions } from './service-options';

/**
 * The per-task deadlines a delegation arms while it waits for its Agent: a submitted pointer that has not started a
 * turn yet, or a launch that has not reached its first turn. One timer per task.
 */
export class DelegationSubmissions {
    private readonly timers = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly options: Pick<
            AgentDelegationServiceOptions,
            'database' | 'submissionTimeoutMs' | 'write'
        >,
        private readonly fail: (id: string, failure: AgentDelegationReceipt['failure']) => void,
    ) {}

    private isSubmitting(id: string): boolean {
        return this.options.database.agentDelegations.get(id)?.receipt.status === 'submitting';
    }

    /**
     * Applies the Terminal Host's real answer for a pointer that was admitted before it was delivered.
     *
     * A background delegation writes to a Terminal with no Renderer attachment, so the Host can still refuse the input:
     * the launch changed while it was waiting, or the request was rejected outright. Reported as success, the task sat
     * in `submitting` until its 15s timeout turned it into `submission_unconfirmed`, which names the wrong cause. Only
     * a task still waiting for that prompt is settled; anything else already has an outcome of its own.
     */
    private settle(id: string, wasDelivered: boolean): void {
        if (wasDelivered || !this.isSubmitting(id)) return;
        this.clear(id);
        this.fail(id, 'target_changed');
    }

    /**
     * Writes a `submitting` task's pointer into `launchId` as one bracketed paste (a Chat takes it as one message),
     * failing the task if the Host refuses it later or no turn starts in time. False when the Host refused it
     * outright.
     */
    submit(id: string, terminalId: string, launchId: string, pointer: string): boolean {
        const paste = `\u{1B}[200~${pointer}\u{1B}[201~\r`;
        if (!this.options.write?.(terminalId, launchId, paste, (ok) => this.settle(id, ok)))
            return false;
        if (this.isSubmitting(id))
            this.arm(id, () => {
                if (this.isSubmitting(id)) this.fail(id, 'submission_unconfirmed');
            });
        return true;
    }

    arm(id: string, onExpired: () => void): void {
        const timer = setTimeout(() => {
            this.timers.delete(id);
            onExpired();
        }, this.options.submissionTimeoutMs ?? 15_000);
        timer.unref();
        this.timers.set(id, timer);
    }

    clear(id: string): void {
        clearTimeout(this.timers.get(id));
        this.timers.delete(id);
    }

    close(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }
}
