import { CancellationTokenSource } from 'caxri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionHostMessage } from '../../shared/extension-host-protocol';
import { rejectPendingApiRequests, requestHostApi } from '../host-api-request';

describe('Extension Host API requests', () => {
    afterEach(() => {
        rejectPendingApiRequests('Test cleanup');
        vi.useRealTimers();
    });

    it('reports public-token cancellation as a typed non-fault outcome', async () => {
        const sent: ExtensionHostMessage[] = [];
        const source = new CancellationTokenSource();
        const request = requestHostApi(
            {
                apiToken: 'token-1',
                extensionId: 'publisher.fixture',
                generation: 1,
                assertCurrent: () => {},
                isApiTokenCurrent: () => true,
                send: (message) => sent.push(message),
            },
            { method: 'workspace.request', params: { operation: 'files.list', arguments: {} } },
            source.token,
        );

        source.cancel();

        await expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(sent).toContainEqual(expect.objectContaining({ type: 'api-cancel' }));
    });

    it('does not abandon a non-expiring mutation at the nested Host API boundary', async () => {
        vi.useFakeTimers();
        const sent: ExtensionHostMessage[] = [];
        const source = new CancellationTokenSource();
        const request = requestHostApi(
            {
                apiToken: 'token-1',
                extensionId: 'publisher.fixture',
                generation: 1,
                assertCurrent: () => {},
                isApiTokenCurrent: () => true,
                send: (message) => sent.push(message),
            },
            {
                method: 'workspace.request',
                params: {
                    operation: 'files.copy',
                    arguments: { directory: '/project', path: '/project/source' },
                },
            },
            source.token,
        );
        let isSettled = false;
        const observed = (async () => {
            try {
                return await request;
            } finally {
                isSettled = true;
            }
        })();

        await vi.advanceTimersByTimeAsync(15_000);

        expect(isSettled).toBe(false);
        expect(sent).not.toContainEqual(expect.objectContaining({ type: 'api-cancel' }));
        source.cancel();
        await expect(observed).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(sent).toContainEqual(expect.objectContaining({ type: 'api-cancel' }));
    });

    it('cancels Host work when an expiring API request times out', async () => {
        vi.useFakeTimers();
        const sent: ExtensionHostMessage[] = [];
        const request = requestHostApi(
            {
                apiToken: 'token-1',
                extensionId: 'publisher.fixture',
                generation: 1,
                assertCurrent: () => {},
                isApiTokenCurrent: () => true,
                send: (message) => sent.push(message),
            },
            { method: 'workspace.request', params: { operation: 'files.list', arguments: {} } },
        );

        const assertion = expect(request).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(15_000);

        await assertion;
        expect(sent).toContainEqual(expect.objectContaining({ type: 'api-cancel' }));
    });
});
