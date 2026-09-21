import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { createSourceControlClient } from '../view-operation-client';

afterEach(() => {
    mocks.request.mockReset();
    vi.unstubAllGlobals();
});

describe('controlled view operation cancellation', () => {
    it('preserves an authoritative action result after forwarding cancellation', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'action-request-1' });
        const pending = Promise.withResolvers<unknown>();
        mocks.request.mockImplementation((method) =>
            method === 'viewContainers.viewOperation' ? pending.promise : Promise.resolve(null),
        );
        const controller = new AbortController();
        const request = createSourceControlClient('publisher.provider.sourceControl').action(
            { actionId: 'action-1', revision: '7' },
            controller.signal,
        );

        controller.abort();
        pending.resolve({ revision: '7', effects: [], refresh: true });

        await expect(request).resolves.toEqual({ revision: '7', effects: [], refresh: true });
        expect(mocks.request).toHaveBeenCalledWith('viewContainers.cancelRequest', {
            requestId: 'action-request-1',
        });
    });

    it('forwards history cancellation through the generic source-control client', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'history-request-1' });
        const pending = Promise.withResolvers<unknown>();
        mocks.request.mockImplementation((method) =>
            method === 'viewContainers.viewOperation' ? pending.promise : Promise.resolve(null),
        );
        const controller = new AbortController();
        const request = createSourceControlClient('publisher.provider.sourceControl').historyPage(
            { historyId: 'history-1', offset: 0, pageSize: 5, revision: '7' },
            controller.signal,
        );

        controller.abort();
        pending.resolve({ revision: '7', items: [] });
        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.request).toHaveBeenCalledWith('viewContainers.cancelRequest', {
            requestId: 'history-request-1',
        });
    });
});
