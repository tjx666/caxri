import type { AppSettings, BootstrapState, ServerEvent } from '@caxri/protocol';
import { usageTabPath } from '@caxri/protocol';
import type { EditorDocument } from '@desktop-shared/editor-state';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(),
    onEvent: vi.fn<(listener: (event: ServerEvent) => void) => () => void>(),
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.request, onEvent: mocks.onEvent },
}));

import { useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import { shouldAutoSaveDocument } from '../editor-auto-save-commands';
import { autoSaveDocument, subscribeUnsavedEditorRequests } from '../unsaved-editor-commands';

function document(path: string, overrides: Partial<EditorDocument> = {}): EditorDocument {
    return { path, content: 'draft', dirty: true, mtimeMs: 1, size: 5, ...overrides };
}

function installSession(mode: AppSettings['files.autoSave'], path = '/project/a.ts'): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-1',
            sessions: [
                { id: 'session-1', projectId: 'project-1', workbenchRootProjectId: 'project-1' },
            ],
            sessionStates: [],
            terminals: [],
            settings: { 'files.autoSave': mode },
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    useSessionViewStore.getState().cacheDocument('session-1', document(path));
}

function acceptWrites(): void {
    mocks.request.mockImplementation((method, parameters) =>
        method === 'files.write'
            ? Promise.resolve({ ...(parameters as { path: string }), mtimeMs: 2, size: 5 })
            : Promise.resolve(null),
    );
}

function writes(): unknown[] {
    return mocks.request.mock.calls.filter(([method]) => method === 'files.write');
}

afterEach(() => {
    mocks.request.mockReset();
    mocks.onEvent.mockReset();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
});

describe('shouldAutoSaveDocument', () => {
    it.each([
        [
            'a dirty file on focus change',
            'onFocusChange',
            '/project/a.ts',
            document('/project/a.ts'),
            true,
        ],
        [
            'any file when auto save is off',
            'off',
            '/project/a.ts',
            document('/project/a.ts'),
            false,
        ],
        [
            'a clean file',
            'onFocusChange',
            '/project/a.ts',
            document('/project/a.ts', { dirty: false }),
            false,
        ],
        [
            'a read-only file',
            'onFocusChange',
            '/project/a.ts',
            document('/project/a.ts', { readOnly: true }),
            false,
        ],
        ['a document that is no longer cached', 'onFocusChange', '/project/a.ts', undefined, false],
        ['a virtual tab', 'onFocusChange', usageTabPath(), document(usageTabPath()), false],
    ] as const)('decides %s', (_label, mode, path, value, expected) => {
        expect(shouldAutoSaveDocument(mode, path, value)).toBe(expected);
    });
});

describe('autoSaveDocument', () => {
    it('writes a dirty buffer once even when one focus change reports twice', async () => {
        installSession('onFocusChange');
        acceptWrites();

        autoSaveDocument('session-1', '/project/a.ts');
        autoSaveDocument('session-1', '/project/a.ts');

        await vi.waitFor(() =>
            expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
                '/project/a.ts': { dirty: false },
            }),
        );
        expect(writes()).toEqual([
            ['files.write', { sessionId: 'session-1', path: '/project/a.ts', content: 'draft' }],
        ]);
    });

    it('leaves the buffer dirty when auto save is off', () => {
        installSession('off');

        autoSaveDocument('session-1', '/project/a.ts');

        expect(writes()).toEqual([]);
    });
});

describe('quitting with unsaved editors', () => {
    function inspect(): void {
        let listener: ((event: ServerEvent) => void) | undefined;
        mocks.onEvent.mockImplementation((next) => {
            listener = next;
            return () => {};
        });
        subscribeUnsavedEditorRequests();
        listener?.({
            event: 'editor.unsavedRequest',
            payload: { requestId: 'request-1', action: 'inspect' },
        });
    }

    function reply(): unknown {
        return mocks.request.mock.calls.find(([method]) => method === 'editor.unsavedReply')?.[1];
    }

    it('answers without writing and flags auto save, so Main saves under its longer save timeout', async () => {
        installSession('onFocusChange');
        acceptWrites();

        inspect();

        await vi.waitFor(() => expect(reply()).toBeDefined());
        expect(writes()).toEqual([]);
        expect(reply()).toEqual({
            requestId: 'request-1',
            reply: { kind: 'summary', count: 1, names: ['a.ts'], autoSave: true },
        });
    });

    it('reports the unsaved buffer for the prompt when auto save is off', async () => {
        installSession('off');
        acceptWrites();

        inspect();

        await vi.waitFor(() => expect(reply()).toBeDefined());
        expect(writes()).toEqual([]);
        expect(reply()).toEqual({
            requestId: 'request-1',
            reply: { kind: 'summary', count: 1, names: ['a.ts'], autoSave: false },
        });
    });
});
