import type { MethodResult } from '@caxri/protocol';

import type { ChangesSnapshot } from './changes-model';

const changesSnapshot = (result: MethodResult<'mobile.changes.list'>): ChangesSnapshot => ({
    additions: result.additions,
    changedFileCount: result.total,
    deletions: result.deletions,
    files: result.files,
    isRepository: result.isRepository,
    truncated: result.truncated,
});

/**
 * A manual Refresh asks the Server for a new Git generation. Ordinary reads and event invalidations remain cache reads.
 */
export const readChangesSnapshot = async (
    request: (
        method: 'mobile.changes.list',
        parameters: { sessionId: string; refresh?: boolean },
    ) => Promise<MethodResult<'mobile.changes.list'>>,
    sessionId: string,
    isManualRefresh = false,
): Promise<ChangesSnapshot> =>
    changesSnapshot(
        await request('mobile.changes.list', {
            sessionId,
            ...(isManualRefresh && { refresh: true }),
        }),
    );
