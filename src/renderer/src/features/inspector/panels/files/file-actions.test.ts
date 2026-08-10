import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapState } from '@shared/types';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { caxriQueryKey, queryClient } from '../../../../queries/client';
import { dismissToast } from '../../../../stores/toasts';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { duplicateFile } from './file-actions';
import { useFileOperationStore } from './file-operation-state';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

beforeEach(() => vi.stubGlobal('window', globalThis));

afterEach(() => {
    mocks.request.mockReset();
    queryClient.clear();
    useFileOperationStore.getState().clear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    dismissToast();
    vi.unstubAllGlobals();
});

describe('file action lifecycle', () => {
    it('coalesces a repeated copy and invalidates every same-Project Session tree', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    { id: 'session-a', projectId: 'project-1' },
                    { id: 'session-b', projectId: 'project-1' },
                    { id: 'session-c', projectId: 'project-2' },
                ],
            } as unknown as BootstrapState,
        });
        const directory = '/project';
        const source = `${directory}/source.txt`;
        const copy = deferred<{
            kind: 'file';
            name: string;
            path: string;
        }>();
        mocks.request.mockReturnValue(copy.promise);
        for (const sessionId of ['session-a', 'session-b', 'session-c'])
            queryClient.setQueryData(caxriQueryKey('files.list', { sessionId, directory }), []);

        const first = duplicateFile('session-a', source);
        const repeated = duplicateFile('session-a', source);

        expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(useFileOperationStore.getState().operations).toEqual([
            expect.objectContaining({ label: 'Copying item…', projectId: 'project-1' }),
        ]);
        await expect(repeated).resolves.toBeUndefined();

        copy.resolve({
            kind: 'file',
            name: 'source copy.txt',
            path: `${directory}/source copy.txt`,
        });
        await expect(first).resolves.toMatchObject({ name: 'source copy.txt' });

        expect(useFileOperationStore.getState().operations).toEqual([]);
        expect(
            queryClient.getQueryState(
                caxriQueryKey('files.list', { sessionId: 'session-a', directory }),
            )?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(
                caxriQueryKey('files.list', { sessionId: 'session-b', directory }),
            )?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(
                caxriQueryKey('files.list', { sessionId: 'session-c', directory }),
            )?.isInvalidated,
        ).toBe(false);
    });
});
