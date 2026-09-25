import { expect, it, vi } from 'vitest';

import { readChangesSnapshot } from '../changes-query';

it('forces only explicit Refresh and leaves ordinary reads unforced', async () => {
    const request = vi.fn(
        (method: 'mobile.changes.list', parameters: { sessionId: string; refresh?: boolean }) => {
            expect(method).toBe('mobile.changes.list');
            expect(parameters.sessionId).toBe('session-1');
            return Promise.resolve({
                isRepository: true,
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
    expect(request.mock.calls.map((call) => call[1])).toEqual([
        { sessionId: 'session-1' },
        { sessionId: 'session-1', refresh: true },
    ]);
});
