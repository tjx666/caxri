import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
const scope = {
    kind: 'session' as const,
    sessionId: 'session-1',
    workbenchProjectId: 'project-1',
};

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { createResourceExplorerClient, createSourceControlClient } from '../view-operation-client';

afterEach(() => {
    mocks.request.mockReset();
    vi.unstubAllGlobals();
});

describe('controlled view operation cancellation', () => {
    it('does not start a provider request for an already-aborted signal', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            createResourceExplorerClient('publisher.files.explorer', scope).list(
                '/project',
                controller.signal,
            ),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('cancels the exact in-flight provider request once', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'view-request-1' });
        const pending = Promise.withResolvers<unknown>();
        mocks.request.mockImplementation((method) =>
            method === 'viewContainers.viewOperation' ? pending.promise : Promise.resolve({}),
        );
        const controller = new AbortController();
        const request = createResourceExplorerClient('publisher.files.explorer', scope).list(
            '/project',
            controller.signal,
        );

        controller.abort();
        pending.resolve([]);
        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.request).toHaveBeenCalledWith('viewContainers.cancelRequest', {
            requestId: 'view-request-1',
        });
        expect(
            mocks.request.mock.calls.filter(
                ([method]) => method === 'viewContainers.cancelRequest',
            ),
        ).toHaveLength(1);
        expect(mocks.request).toHaveBeenCalledWith('viewContainers.viewOperation', {
            viewId: 'publisher.files.explorer',
            requestId: 'view-request-1',
            operation: 'files.list',
            arguments: { directory: '/project' },
            context: scope,
        });
    });

    it('forwards commit history cancellation through the source-control client', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'commit-request-1' });
        const pending = Promise.withResolvers<unknown>();
        mocks.request.mockImplementation((method) =>
            method === 'viewContainers.viewOperation' ? pending.promise : Promise.resolve(null),
        );
        const controller = new AbortController();
        const request = createSourceControlClient('publisher.git.sourceControl', scope).commits(
            { repositoryId: 'repo-1', offset: 0, pageSize: 5 },
            controller.signal,
        );

        controller.abort();
        pending.resolve({ commits: [], nextOffset: undefined });
        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.request).toHaveBeenCalledWith('viewContainers.cancelRequest', {
            requestId: 'commit-request-1',
        });
    });
});
