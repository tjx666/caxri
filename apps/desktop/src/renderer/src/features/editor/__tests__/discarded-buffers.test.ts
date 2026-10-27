import type { BootstrapState, SessionState } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/caxri', () => ({ caxri: { request: vi.fn(), onEvent: vi.fn() } }));

import { getSessionDocuments, useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import {
    clearDiscardedBuffers,
    discardedChangesUnavailableReason,
    restoreDiscardedChanges,
    stashDiscardedBuffers,
} from '../discarded-buffers';

const path = '/project/first.ts';
const target = { sessionId: 'session-1', workbenchRootProjectId: 'project-1', paths: [path] };

function useWorkbenchRoot(workbenchRootProjectId: string): void {
    useWorkbenchStore.setState({
        bootstrap: {
            sessions: [{ id: 'session-1', projectId: 'project-1', workbenchRootProjectId }],
            sessionStates: [{ sessionId: 'session-1', workbenchRootProjectId } as SessionState],
        } as unknown as BootstrapState,
    });
}

function cacheDiskVersion(overrides: { dirty?: boolean } = {}): void {
    useSessionViewStore
        .getState()
        .cacheDocument(
            'session-1',
            { path, content: 'disk content', dirty: false, mtimeMs: 2, size: 12, ...overrides },
            'project-1',
        );
}

beforeEach(() => {
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    useWorkbenchRoot('project-1');
    stashDiscardedBuffers('session-1', 'project-1', [{ path, content: 'my edit' }]);
});

afterEach(() => {
    clearDiscardedBuffers();
    useWorkbenchStore.setState({ bootstrap: undefined });
});

describe('restoreDiscardedChanges', () => {
    it('puts the discarded text back as an unsaved buffer over the disk version, once', () => {
        cacheDiskVersion();
        expect(discardedChangesUnavailableReason(target)).toBeUndefined();
        restoreDiscardedChanges(target);
        expect(getSessionDocuments('session-1', 'project-1')?.[path]).toMatchObject({
            content: 'my edit',
            dirty: true,
            mtimeMs: 2,
        });
        // A second click must not overwrite edits made after the first restore, and says why.
        expect(discardedChangesUnavailableReason(target)).toBe(
            'Your earlier changes were already restored.',
        );
    });

    it('refuses when the user typed into the reloaded file, closed it, or left its Workbench Root', () => {
        cacheDiskVersion({ dirty: true });
        expect(discardedChangesUnavailableReason(target)).toBeDefined();

        useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
        expect(discardedChangesUnavailableReason(target)).toBeDefined();

        cacheDiskVersion();
        useWorkbenchRoot('project-2');
        expect(discardedChangesUnavailableReason(target)).toBeDefined();
        restoreDiscardedChanges(target);
        expect(getSessionDocuments('session-1', 'project-1')?.[path]?.content).toBe('disk content');
    });
});
