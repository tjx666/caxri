import { randomUUID } from 'node:crypto';

import type { ServerOperationParameters } from '@caxri/protocol';

import type { ServerDomainService } from './domain-service';

/**
 * The `agent.dispatch.wait` calls each client request holds, keyed by `principalRequestKey`. A dispatch wait lives in
 * the dispatch domain rather than behind an abort signal, so a client that disconnects mid-wait has its waits cancelled
 * there by id instead.
 */
export class DispatchWaits {
    private readonly ids = new Map<string, Set<string>>();

    constructor(private readonly domainService: ServerDomainService) {}

    async wait(
        key: string,
        parameters: Omit<ServerOperationParameters<'agent.dispatch.waitInternal'>, 'waitId'>,
    ): Promise<unknown> {
        const waitId = randomUUID();
        const waitIds = this.ids.get(key) ?? new Set<string>();
        waitIds.add(waitId);
        this.ids.set(key, waitIds);
        try {
            return await this.domainService.request('agent.dispatch.waitInternal', {
                ...parameters,
                waitId,
            });
        } finally {
            waitIds.delete(waitId);
            if (waitIds.size === 0) this.ids.delete(key);
        }
    }

    async cancel(key: string): Promise<void> {
        const waitIds = this.ids.get(key) ?? new Set<string>();
        await Promise.all(
            [...waitIds].map(async (waitId) => {
                try {
                    await this.domainService.request('agent.dispatch.cancelWaitInternal', {
                        waitId,
                    });
                } catch {
                    // Best-effort cancel: the wait may have already resolved.
                }
            }),
        );
    }
}
