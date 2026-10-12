import type { DesktopLease } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { DesktopLeaseWaiter } from './control-server-support';

/**
 * Upper bound on concurrent callers waiting for a Desktop to report ready.
 */
const MAX_DESKTOP_LEASE_WAITERS = 32;

/**
 * Callers waiting for the next ready Desktop lease, such as a Desktop launch that must route a window operation once
 * the launched Desktop connects. Each waiter settles exactly once: on the next ready lease, its own deadline, or
 * transport close.
 */
export class DesktopLeaseWaiters {
    private readonly waiters = new Set<DesktopLeaseWaiter>();

    /**
     * Waits for the next ready Desktop lease, rejecting with `CAPACITY` when too many waiters are pending and with
     * `TIMEOUT` when no Desktop reports ready before `timeoutMs`.
     */
    wait(timeoutMs: number): Promise<DesktopLease> {
        if (this.waiters.size >= MAX_DESKTOP_LEASE_WAITERS)
            return Promise.reject(
                new CaxriError('CAPACITY', 'Too many Desktop launches are pending'),
            );
        return new Promise((resolve, reject) => {
            const waiter: DesktopLeaseWaiter = {
                reject,
                resolve,
                timer: setTimeout(() => {
                    this.waiters.delete(waiter);
                    reject(
                        new CaxriError('TIMEOUT', 'Desktop did not connect before the deadline'),
                    );
                }, timeoutMs),
            };
            this.waiters.add(waiter);
        });
    }

    /**
     * Resolves every pending waiter with the lease of the Desktop that just reported ready.
     */
    resolveAll(lease: DesktopLease): void {
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(lease);
        }
        this.waiters.clear();
    }

    /**
     * Rejects every pending waiter, for example when the Host transport closes.
     */
    rejectAll(error: CaxriError): void {
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        this.waiters.clear();
    }
}
