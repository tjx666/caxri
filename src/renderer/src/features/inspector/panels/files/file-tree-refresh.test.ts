import type { RuntimeEvent } from '@shared/ipc';
import type { BootstrapState } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state: { handler?: (event: RuntimeEvent) => void } = {};
    return {
        state,
        onEvent: vi.fn((handler: (event: RuntimeEvent) => void) => {
            state.handler = handler;
            return () => {};
        }),
    };
});

vi.mock('../../../../lib/caxri', () => ({ caxri: mocks }));

import { useWorkbenchStore } from '../../../../stores/workbench';
import {
    isGitIgnoreRulesPath,
    parentDirectoryPath,
    subscribeFileTreeInvalidation,
} from './file-tree-refresh';

afterEach(() => useWorkbenchStore.setState({ bootstrap: undefined }));

describe('file tree refresh routing', () => {
    it('routes each changed path to the directory that directly owns it', () => {
        expect(parentDirectoryPath('/project/src')).toBe('/project');
        expect(parentDirectoryPath('/project/src/index.ts')).toBe('/project/src');
        expect(parentDirectoryPath('/file.ts')).toBe('/');
    });

    it('recognizes changes that can redecorate every expanded descendant', () => {
        expect(isGitIgnoreRulesPath('/project/.gitignore')).toBe(true);
        expect(isGitIgnoreRulesPath('/project/packages/app/.gitignore')).toBe(true);
        expect(isGitIgnoreRulesPath('/project/.git/info/exclude')).toBe(true);
        expect(isGitIgnoreRulesPath('/project/.git/config')).toBe(true);
        expect(isGitIgnoreRulesPath('/project/src/index.ts')).toBe(false);
        expect(isGitIgnoreRulesPath('/project/local.ignore')).toBe(false);
    });
});

describe('subscribeFileTreeInvalidation', () => {
    it('invalidates the exact parent listing for every Session sharing the changed root', () => {
        const queryClient = new QueryClient();
        const parent = '/project/src';
        queryClient.setQueryData(['files.list', { sessionId: 'session-a', directory: parent }], []);
        queryClient.setQueryData(['files.list', { sessionId: 'session-b', directory: parent }], []);
        queryClient.setQueryData(
            ['files.list', { sessionId: 'session-other', directory: parent }],
            [],
        );
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-a',
                sessions: [
                    { id: 'session-a', workbenchProjectId: 'project-p' },
                    { id: 'session-b', workbenchProjectId: 'project-p' },
                    { id: 'session-other', workbenchProjectId: 'project-other' },
                ],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const unsubscribe = subscribeFileTreeInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-a',
                workbenchProjectId: 'project-p',
                overflow: false,
                changes: [{ kind: 'update', path: '/project/src/index.ts' }],
            },
        });

        expect(
            queryClient.getQueryState(['files.list', { sessionId: 'session-a', directory: parent }])
                ?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['files.list', { sessionId: 'session-b', directory: parent }])
                ?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'files.list',
                { sessionId: 'session-other', directory: parent },
            ])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('fans out overflow and Git ignore-rule changes only within the changed root', () => {
        const queryClient = new QueryClient();
        for (const sessionId of ['session-a', 'session-b', 'session-other'])
            for (const directory of ['/project/src', '/project/packages'])
                queryClient.setQueryData(['files.list', { sessionId, directory }], []);
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-a',
                sessions: [
                    { id: 'session-a', workbenchProjectId: 'project-p' },
                    { id: 'session-b', workbenchProjectId: 'project-p' },
                    { id: 'session-other', workbenchProjectId: 'project-other' },
                ],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const unsubscribe = subscribeFileTreeInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-a',
                workbenchProjectId: 'project-p',
                overflow: false,
                changes: [{ kind: 'update', path: '/project/.gitignore' }],
            },
        });

        for (const sessionId of ['session-a', 'session-b'])
            for (const directory of ['/project/src', '/project/packages'])
                expect(
                    queryClient.getQueryState(['files.list', { sessionId, directory }])
                        ?.isInvalidated,
                ).toBe(true);
        expect(
            queryClient.getQueryState([
                'files.list',
                { sessionId: 'session-other', directory: '/project/src' },
            ])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });
});
