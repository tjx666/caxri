import { createHash } from 'node:crypto';

import type { CommandExecutionContext } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

export function principalRequestKey(context: CommandExecutionContext, requestId: string): string {
    const principal = context.principal;
    const generation = ['agent', 'extension', 'desktop'].includes(principal.kind)
        ? (principal as { generation: number }).generation
        : null;
    return JSON.stringify([principal.kind, principal.id, generation, requestId]);
}

export const dispatchIdFor = (context: CommandExecutionContext, requestId: string): string =>
    `dispatch-${createHash('sha256').update(principalRequestKey(context, requestId)).digest('hex')}`;

/**
 * Owns cancellation for authenticated public reads while preserving principal and generation isolation in the key
 * supplied by Server Core. Domain handlers remain the execution authority; aborting propagates through the shared
 * request signal.
 */
export class RequestCancellationRegistry {
    private static readonly maximumTombstones = 256;
    private static readonly tombstoneTtlMs = 30_000;
    private readonly controllers = new Map<string, AbortController>();
    /**
     * Requests that only observe state, so aborting one when its caller goes away loses no work.
     */
    private readonly disconnectable = new Set<string>();
    private readonly tombstones = new Map<string, number>();

    private pruneTombstones(now = Date.now()): void {
        for (const [key, expiresAt] of this.tombstones)
            if (expiresAt <= now) this.tombstones.delete(key);
        while (this.tombstones.size > RequestCancellationRegistry.maximumTombstones)
            this.tombstones.delete(this.tombstones.keys().next().value!);
    }

    private async register<T>(
        key: string,
        task: (signal: AbortSignal) => Promise<T>,
        isDisconnectable: boolean,
    ): Promise<T> {
        this.pruneTombstones();
        if (this.tombstones.delete(key))
            throw new CaxriError('CANCELLED', 'Runtime request was canceled before registration');
        if (this.controllers.has(key))
            throw new CaxriError('CONFLICT', 'Request identity is already in flight');
        const controller = new AbortController();
        this.controllers.set(key, controller);
        if (isDisconnectable) this.disconnectable.add(key);
        try {
            return await task(controller.signal);
        } finally {
            if (this.controllers.get(key) === controller) {
                this.controllers.delete(key);
                this.disconnectable.delete(key);
            }
        }
    }

    run<T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return this.register(key, task, false);
    }

    /**
     * Runs a request that only observes state, which `disconnect` may abort once its caller goes away.
     */
    runDisconnectable<T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return this.register(key, task, true);
    }

    /**
     * Aborts a request whose caller disconnected, but only one registered as disconnectable: most forwarded operations
     * are durable mutations that must finish even when nobody is left to read the answer. Unlike `cancel`, an unknown
     * key leaves no tombstone, since a disconnected caller never sends that request again.
     */
    disconnect(key: string): void {
        if (this.disconnectable.has(key)) this.controllers.get(key)?.abort();
    }

    cancel(key: string): boolean {
        const controller = this.controllers.get(key);
        if (controller) controller.abort();
        else {
            this.pruneTombstones();
            this.tombstones.set(key, Date.now() + RequestCancellationRegistry.tombstoneTtlMs);
            this.pruneTombstones();
        }
        return true;
    }
}
