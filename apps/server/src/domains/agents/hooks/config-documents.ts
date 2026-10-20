import type { AgentProvider } from '@caxri/protocol';
import { readBoundedRegularFileText } from '@caxri/system';

import type { AgentHookConfigTarget, AgentHookDocuments } from './contract';

export function isFileSystemError(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        Reflect.get(error, 'code') === code
    );
}

/**
 * Reads every provider config target of one adapter. A missing file reads as `undefined` (nothing installed yet); any
 * other failure, including a file over `maxBytes`, rejects.
 */
export async function readConfigDocuments(
    targets: readonly AgentHookConfigTarget[],
    maxBytes: number,
): Promise<AgentHookDocuments> {
    const entries = await Promise.all(
        targets.map(async (target) => {
            try {
                return [
                    target.id,
                    await readBoundedRegularFileText(target.path, maxBytes, {
                        capacityMessage: `Agent hook configuration exceeds the ${maxBytes} byte safety limit`,
                    }),
                ] as const;
            } catch (error) {
                if (isFileSystemError(error, 'ENOENT')) return [target.id, undefined] as const;
                throw error;
            }
        }),
    );
    return new Map(entries);
}

/**
 * What each provider's config files should hold after the last reconcile: what it read, overlaid with what it wrote.
 *
 * A native watcher reports only what happens after its subscription is live, and a file can become watched only after
 * the reconcile that read and rewrote it (a repointed link's new target). An edit landing in between produces no event,
 * so once the watcher is live the manager compares the files with this snapshot instead of reconciling blindly: a
 * reconcile clears every launch environment while it runs, so an unconditional one at each startup could hand a
 * Terminal launched in that window no hook environment at all.
 */
export class ReconciledConfigDocuments {
    private readonly snapshots = new Map<
        AgentProvider,
        { documents: AgentHookDocuments; targets: readonly AgentHookConfigTarget[] }
    >();

    constructor(private readonly maxBytes: number) {}

    remember(
        provider: AgentProvider,
        targets: readonly AgentHookConfigTarget[],
        documents: AgentHookDocuments,
    ): void {
        this.snapshots.set(provider, { documents, targets });
    }

    forget(provider: AgentProvider): void {
        this.snapshots.delete(provider);
    }

    /**
     * Whether any remembered file now reads differently. An unreadable file counts as changed, so the reconcile that
     * follows reports the failure instead of this check hiding it.
     */
    async changed(): Promise<boolean> {
        const results = await Promise.all(
            this.snapshots.values().map(async ({ documents, targets }) => {
                try {
                    const current = await readConfigDocuments(targets, this.maxBytes);
                    return targets.some(
                        (target) => current.get(target.id) !== documents.get(target.id),
                    );
                } catch {
                    return true;
                }
            }),
        );
        return results.includes(true);
    }
}
