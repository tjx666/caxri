import { CaxriError } from '../shared/ipc/errors';
import type { CommandExecutionContext } from '../shared/ipc/principal';

export function principalRequestKey(context: CommandExecutionContext, requestId: string): string {
    const principal = context.principal;
    const generation = ['agent', 'extension', 'desktop'].includes(principal.kind)
        ? (principal as { generation: number }).generation
        : null;
    return JSON.stringify([principal.kind, principal.id, generation, requestId]);
}

/**
 * Owns cancellation for authenticated public reads while preserving principal and generation isolation in the key
 * supplied by the Host. Runtime remains the execution authority; aborting sends its existing out-of-band cancel frame.
 */
export class RuntimeRequestCancellationRegistry {
    private static readonly maximumTombstones = 256;
    private static readonly tombstoneTtlMs = 30_000;
    private readonly controllers = new Map<string, AbortController>();
    private readonly tombstones = new Map<string, number>();

    private pruneTombstones(now = Date.now()): void {
        for (const [key, expiresAt] of this.tombstones)
            if (expiresAt <= now) this.tombstones.delete(key);
        while (this.tombstones.size > RuntimeRequestCancellationRegistry.maximumTombstones)
            this.tombstones.delete(this.tombstones.keys().next().value!);
    }

    async run<T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        this.pruneTombstones();
        if (this.tombstones.delete(key))
            throw new CaxriError('CANCELLED', 'Runtime request was canceled before registration');
        if (this.controllers.has(key))
            throw new CaxriError('CONFLICT', 'Request identity is already in flight');
        const controller = new AbortController();
        this.controllers.set(key, controller);
        try {
            return await task(controller.signal);
        } finally {
            if (this.controllers.get(key) === controller) this.controllers.delete(key);
        }
    }

    cancel(key: string): boolean {
        const controller = this.controllers.get(key);
        if (controller) controller.abort();
        else {
            this.pruneTombstones();
            this.tombstones.set(
                key,
                Date.now() + RuntimeRequestCancellationRegistry.tombstoneTtlMs,
            );
            this.pruneTombstones();
        }
        return true;
    }
}
