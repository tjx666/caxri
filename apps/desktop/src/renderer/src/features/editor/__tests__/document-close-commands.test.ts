import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import { closeDocumentTabFamily } from '../document-commands';
import {
    activePaneTabPath,
    closeAllEditors,
    closeEditor,
    installEmptySession,
    installPaneLayout,
    installSessions,
    paneLayout,
    paneTabPaths,
    setAutoSave,
} from './document-commands.fixture';

afterEach(() => {
    mocks.request.mockReset();
    mocks.request.mockImplementation(() => Promise.resolve(null));
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
});

describe('closing a dirty editor tab', () => {
    it('aborts the close and keeps the tab open when the user cancels the discard confirmation', async () => {
        installSessions('/project/dirty.ts', 'session-1');
        mocks.request.mockImplementation((method) =>
            method === 'editor.confirmDiscard'
                ? Promise.resolve({ choice: 'cancel' })
                : Promise.resolve(null),
        );

        await closeEditor('/project/dirty.ts');

        expect(mocks.request).toHaveBeenCalledWith('editor.confirmDiscard', { name: 'dirty.ts' });
        expect(mocks.request).not.toHaveBeenCalledWith('files.write', expect.anything());
        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        expect(paneTabPaths(state)).toEqual(['/project/dirty.ts']);
        expect(activePaneTabPath(state)).toBe('/project/dirty.ts');
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/dirty.ts': { dirty: true },
        });
    });

    it("closes a dirty tab without writing when the user chooses Don't Save", async () => {
        installSessions('/project/dirty.ts', 'session-1');
        mocks.request.mockImplementation((method) =>
            method === 'editor.confirmDiscard'
                ? Promise.resolve({ choice: 'discard' })
                : Promise.resolve(null),
        );

        await closeEditor('/project/dirty.ts');

        expect(mocks.request).not.toHaveBeenCalledWith('files.write', expect.anything());
        expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual([]);
        expect(useSessionViewStore.getState().documents['session-1']).toEqual({});
    });

    it('saves a dirty tab before closing it when the user chooses Save', async () => {
        installSessions('/project/dirty.ts', 'session-1');
        mocks.request.mockImplementation((method) => {
            if (method === 'editor.confirmDiscard') return Promise.resolve({ choice: 'save' });
            if (method === 'files.write')
                return Promise.resolve({
                    content: 'unsaved',
                    mtimeMs: 2,
                    path: '/project/dirty.ts',
                    size: 7,
                });
            return Promise.resolve(null);
        });

        await closeEditor('/project/dirty.ts');

        expect(mocks.request).toHaveBeenCalledWith(
            'files.write',
            expect.objectContaining({ sessionId: 'session-1', path: '/project/dirty.ts' }),
        );
        expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual([]);
        expect(useSessionViewStore.getState().documents['session-1']).toEqual({});
    });

    it('aborts a bulk close entirely when any dirty tab in it is canceled', async () => {
        installEmptySession();
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessionStates: [
                          {
                              ...state.bootstrap.sessionStates[0],
                              paneLayout: paneLayout(['/project/a.ts', '/project/b.ts']),
                          },
                      ],
                  }
                : undefined,
        }));
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/a.ts',
            content: 'a',
            dirty: true,
            mtimeMs: 1,
            size: 1,
        });
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/b.ts',
            content: 'b',
            dirty: true,
            mtimeMs: 1,
            size: 1,
        });
        let confirmCalls = 0;
        mocks.request.mockImplementation((method) => {
            if (method === 'editor.confirmDiscard') {
                confirmCalls += 1;
                return Promise.resolve({ choice: confirmCalls === 1 ? 'discard' : 'cancel' });
            }
            return Promise.resolve(null);
        });

        await closeAllEditors('/project/a.ts');

        expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual([
            '/project/a.ts',
            '/project/b.ts',
        ]);
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/a.ts': { dirty: true },
            '/project/b.ts': { dirty: true },
        });
    });
});

describe('closing a mixed pane of Terminal and document tabs', () => {
    it.each(['all', 'others', 'right'] as const)(
        'preserves the Terminal PTY when an editor closes %s',
        async (mode) => {
            installPaneLayout(['/project/a.ts', { terminalId: 'terminal-1' }]);

            await closeDocumentTabFamily('tab-0', mode);

            expect(mocks.request).not.toHaveBeenCalledWith('terminal.close', {
                terminalId: 'terminal-1',
            });
            expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual(
                mode === 'all' ? ['terminal-1'] : ['/project/a.ts', 'terminal-1'],
            );

            /*
             * The other direction is deliberately asymmetric: a Terminal's own bulk close spans the whole rail, so
             * "Close All" from it clears the surviving editor too, and the PTY is still released rather than orphaned.
             */
            await closeDocumentTabFamily('tab-1', 'all');
            expect(mocks.request).toHaveBeenCalledWith('terminal.close', {
                terminalId: 'terminal-1',
            });
            expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual(
                [],
            );
        },
    );

    it('clears the documents beside a Terminal without touching its PTY', async () => {
        installPaneLayout(['/project/a.ts', { terminalId: 'terminal-1' }, '/project/b.ts'], 1);

        await closeDocumentTabFamily('tab-1', 'editors');

        expect(mocks.request).not.toHaveBeenCalledWith('terminal.close', {
            terminalId: 'terminal-1',
        });
        expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual([
            'terminal-1',
        ]);
    });
});

describe('closing a dirty editor tab under auto save', () => {
    it('saves without asking when auto save is on focus change', async () => {
        installSessions('/project/dirty.ts', 'session-1');
        setAutoSave('onFocusChange');
        mocks.request.mockImplementation((method) =>
            method === 'files.write'
                ? Promise.resolve({
                      content: 'unsaved',
                      mtimeMs: 2,
                      path: '/project/dirty.ts',
                      size: 7,
                  })
                : Promise.resolve(null),
        );

        await closeEditor('/project/dirty.ts');

        expect(mocks.request).not.toHaveBeenCalledWith('editor.confirmDiscard', expect.anything());
        expect(mocks.request).toHaveBeenCalledWith(
            'files.write',
            expect.objectContaining({ path: '/project/dirty.ts', content: 'unsaved' }),
        );
        expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual([]);
    });

    it('keeps the tab open when the automatic save fails', async () => {
        installSessions('/project/dirty.ts', 'session-1');
        setAutoSave('onFocusChange');
        mocks.request.mockImplementation((method) =>
            method === 'files.write'
                ? Promise.reject(new Error('disk full'))
                : Promise.resolve(null),
        );

        await closeEditor('/project/dirty.ts');

        expect(mocks.request).not.toHaveBeenCalledWith('editor.confirmDiscard', expect.anything());
        expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual([
            '/project/dirty.ts',
        ]);
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/dirty.ts': { dirty: true },
        });
    });
});
