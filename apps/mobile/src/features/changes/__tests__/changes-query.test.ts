import { expect, it, vi } from 'vitest';

import type { ChangesMode } from '../changes-model';
import { readChangesSnapshot } from '../changes-query';

it('forces only explicit Refresh and sends the mode only when it is not the Working Tree', async () => {
    const request = vi.fn(
        (
            method: 'mobile.changes.list',
            parameters: { sessionId: string; refresh?: boolean; mode?: ChangesMode },
        ) => {
            expect(method).toBe('mobile.changes.list');
            expect(parameters.sessionId).toBe('session-1');
            return Promise.resolve({
                isRepository: true,
                uncommittedCount: 2,
                contexts: [],
                files: [],
                total: 0,
                additions: 0,
                deletions: 0,
                truncated: false,
            });
        },
    );
    await readChangesSnapshot(request, 'session-1');
    await readChangesSnapshot(request, 'session-1', true);
    const snapshot = await readChangesSnapshot(request, 'session-1', false, 'commit');
    await readChangesSnapshot(request, 'session-1', true, 'pull-request');
    expect(request.mock.calls.map((call) => call[1])).toEqual([
        { sessionId: 'session-1' },
        { sessionId: 'session-1', refresh: true },
        { sessionId: 'session-1', mode: 'commit' },
        { sessionId: 'session-1', refresh: true, mode: 'pull-request' },
    ]);
    expect(snapshot.uncommittedCount).toBe(2);
});
