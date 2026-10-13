import type { AgentDispatchReceipt, AgentDispatchWaitResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { isSettled } from './receipt-status';

interface DispatchWaiter {
    afterRevision: number;
    resolve(result: AgentDispatchWaitResult): void;
    timer: NodeJS.Timeout;
    waitId: string;
}

const MAX_DISPATCH_WAITERS = 256;
const MAX_WAITERS_PER_DISPATCH = 32;

function didCancelInGroup(
    waiters: Set<DispatchWaiter>,
    waitId: string,
    receipt: AgentDispatchReceipt,
): boolean {
    let isCanceled = false;
    for (const waiter of waiters) {
        if (waiter.waitId !== waitId) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve({ receipt, outcome: 'canceled' });
        isCanceled = true;
    }
    return isCanceled;
}

/**
 * Pending `agent.dispatch.wait` calls, bounded globally and per dispatch. Each resolves on the first published receipt
 * past its revision (or any settled one), on its timeout, or when canceled.
 */
export class DispatchWaiters {
    private readonly waiters = new Map<string, Set<DispatchWaiter>>();

    /**
     * Waits for a receipt change. `read` returns the receipt a timeout reports.
     */
    wait(
        dispatchId: string,
        afterRevision: number,
        timeoutMs: number,
        waitId: string,
        read: () => AgentDispatchReceipt,
    ): Promise<AgentDispatchWaitResult> {
        const waiters = this.waiters.get(dispatchId) ?? new Set();
        const waiterCount = this.waiters.values().reduce((count, group) => count + group.size, 0);
        if (waiterCount >= MAX_DISPATCH_WAITERS || waiters.size >= MAX_WAITERS_PER_DISPATCH)
            throw new CaxriError('CAPACITY', 'Too many Agent dispatch waits are pending');
        return new Promise((resolve) => {
            const waiter: DispatchWaiter = {
                afterRevision,
                resolve,
                timer: setTimeout(() => {
                    const currentWaiters = this.waiters.get(dispatchId);
                    currentWaiters?.delete(waiter);
                    if (currentWaiters?.size === 0) this.waiters.delete(dispatchId);
                    resolve({ receipt: read(), outcome: 'timed_out' });
                }, timeoutMs),
                waitId,
            };
            waiter.timer.unref();
            waiters.add(waiter);
            this.waiters.set(dispatchId, waiters);
        });
    }

    /**
     * Resolves every waiter the published receipt answers.
     */
    publish(receipt: AgentDispatchReceipt): void {
        const waiters = this.waiters.get(receipt.dispatchId);
        if (!waiters) return;
        for (const waiter of waiters) {
            if (receipt.revision <= waiter.afterRevision && !isSettled(receipt)) continue;
            clearTimeout(waiter.timer);
            waiters.delete(waiter);
            waiter.resolve({ receipt, outcome: 'changed' });
        }
        if (waiters.size === 0) this.waiters.delete(receipt.dispatchId);
    }

    /**
     * Cancels every waiter registered under `waitId`, each answered with its dispatch's current receipt.
     */
    cancel(
        waitId: string,
        read: (dispatchId: string) => AgentDispatchReceipt | undefined,
    ): boolean {
        let isCanceled = false;
        for (const [dispatchId, waiters] of this.waiters) {
            const receipt = read(dispatchId);
            if (!receipt) continue;
            if (didCancelInGroup(waiters, waitId, receipt)) isCanceled = true;
            if (waiters.size === 0) this.waiters.delete(dispatchId);
        }
        return isCanceled;
    }

    close(read: (dispatchId: string) => AgentDispatchReceipt | undefined): void {
        for (const [dispatchId, waiters] of this.waiters) {
            const receipt = read(dispatchId);
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                if (receipt) waiter.resolve({ receipt, outcome: 'canceled' });
            }
        }
        this.waiters.clear();
    }
}
