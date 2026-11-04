import type { AgentDelegationReceipt } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { removeDelegationFiles } from './storage';

/**
 * Keeps task creation and Session deletion from racing: a Session being deleted takes no new task, and its deletion
 * waits for the creations already in flight before it removes private files and then metadata.
 */
export class SessionDeletionFence {
    private readonly deleting = new Set<string>();
    private readonly creations = new Map<string, Set<Promise<AgentDelegationReceipt>>>();

    has(sessionId: string): boolean {
        return this.deleting.has(sessionId);
    }

    /**
     * Registers a creation in `sessionId`; the returned function ends it.
     */
    track(sessionId: string, creation: Promise<AgentDelegationReceipt>): () => void {
        const mine = this.creations.get(sessionId) ?? new Set();
        this.creations.set(sessionId, mine.add(creation));
        return () => {
            mine.delete(creation);
            if (mine.size === 0) this.creations.delete(sessionId);
        };
    }

    /**
     * Fences creation and cleans private files before deleting metadata; failed cleanup retains the records.
     */
    async delete<T>(
        ids: readonly string[],
        host: {
            userDataPath: string;
            storageRoots(ids: readonly string[]): Parameters<typeof removeDelegationFiles>[1];
            forget(ids: readonly string[]): void;
        },
        remove: () => T | Promise<T>,
    ): Promise<T> {
        if (ids.some((id) => this.deleting.has(id)))
            throw new CaxriError('CONFLICT', 'Delegation Session is already being deleted');
        for (const id of ids) this.deleting.add(id);
        try {
            await Promise.allSettled(ids.flatMap((id) => [...(this.creations.get(id) ?? [])]));
            await removeDelegationFiles(host.userDataPath, host.storageRoots(ids));
            const removed = await remove();
            host.forget(ids);
            return removed;
        } finally {
            for (const id of ids) this.deleting.delete(id);
        }
    }
}
