import type { ResourceCleanupKind } from './resource-cleanup';
import { auditGoResources } from './resource-cleanup';
import type { GoState } from './state-model';
import { addEvent } from './state-model';
import { readState, runDirectoryForStatePath, withStateLock, writeState } from './state-storage';
import { assertNoPendingValidation } from './validation-artifact-policy';

export function invalidateResourceCleanupBeforeAudit(state: GoState): void {
    if (!state.resourceCleanup) return;
    state.resourceCleanup = null;
    addEvent(state, 'resource_cleanup', 'Invalidated by resource-audit');
}

/**
 * Inspects operating-system resources outside the short ledger lock, then records the receipt only if no other state
 * writer changed the run while that inspection was in flight.
 */
export async function runResourceAudit(
    statePath: string,
    recovered: ResourceCleanupKind[],
): Promise<void> {
    const snapshot = await withStateLock(statePath, async () => {
        const state = await readState(statePath, { validationArtifacts: 'full' });
        invalidateResourceCleanupBeforeAudit(state);
        await writeState(statePath, state);
        assertNoPendingValidation(state);
        return state;
    });
    const receipt = await auditGoResources(
        snapshot,
        runDirectoryForStatePath(statePath),
        recovered,
    );
    await withStateLock(statePath, async () => {
        const state = await readState(statePath, { validationArtifacts: 'full' });
        if (state.updatedAt !== snapshot.updatedAt) {
            throw new Error('Go state changed during the resource cleanup audit; run it again');
        }
        state.resourceCleanup = receipt;
        addEvent(
            state,
            'resource_cleanup',
            `${receipt.status}: ${receipt.recovered.join(',') || 'none'}`,
        );
        await writeState(statePath, state);
    });
    console.log(
        receipt.status === 'clean'
            ? 'Go resource cleanup audit: clean'
            : `Go resource cleanup audit: recovered ${receipt.recovered.join(', ')}`,
    );
}
