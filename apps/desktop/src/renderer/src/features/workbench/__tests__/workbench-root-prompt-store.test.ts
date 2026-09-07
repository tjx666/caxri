import { beforeEach, describe, expect, it } from 'vitest';

import {
    dismissWorkbenchRootCandidate,
    showWorkbenchRootCandidate,
    useWorkbenchRootPromptStore,
} from '../workbench-root-prompt-store';

describe('workbench root prompt store', () => {
    beforeEach(() => {
        useWorkbenchRootPromptStore.setState({ candidates: {} });
    });

    it('shows a candidate for a Session', () => {
        showWorkbenchRootCandidate({
            candidateId: 'candidate-1',
            sessionId: 'session-1',
            rootPath: '/worktree-1',
        });

        expect(useWorkbenchRootPromptStore.getState().candidates['session-1']).toEqual({
            candidateId: 'candidate-1',
            sessionId: 'session-1',
            rootPath: '/worktree-1',
        });
    });

    it('replaces a Session prior candidate when shown again', () => {
        showWorkbenchRootCandidate({
            candidateId: 'candidate-1',
            sessionId: 'session-1',
            rootPath: '/worktree-1',
        });
        showWorkbenchRootCandidate({
            candidateId: 'candidate-2',
            sessionId: 'session-1',
            rootPath: '/worktree-2',
        });

        expect(useWorkbenchRootPromptStore.getState().candidates['session-1']).toEqual({
            candidateId: 'candidate-2',
            sessionId: 'session-1',
            rootPath: '/worktree-2',
        });
    });

    it('keeps candidates for different Sessions independent', () => {
        showWorkbenchRootCandidate({
            candidateId: 'candidate-1',
            sessionId: 'session-1',
            rootPath: '/worktree-1',
        });
        showWorkbenchRootCandidate({
            candidateId: 'candidate-2',
            sessionId: 'session-2',
            rootPath: '/worktree-2',
        });

        dismissWorkbenchRootCandidate('session-1');

        expect(useWorkbenchRootPromptStore.getState().candidates['session-1']).toBeUndefined();
        expect(useWorkbenchRootPromptStore.getState().candidates['session-2']).toEqual({
            candidateId: 'candidate-2',
            sessionId: 'session-2',
            rootPath: '/worktree-2',
        });
    });

    it('dismisses a candidate for a Session', () => {
        showWorkbenchRootCandidate({
            candidateId: 'candidate-1',
            sessionId: 'session-1',
            rootPath: '/worktree-1',
        });

        dismissWorkbenchRootCandidate('session-1');

        expect(useWorkbenchRootPromptStore.getState().candidates['session-1']).toBeUndefined();
    });

    it('is a no-op to dismiss a Session with no pending candidate', () => {
        const before = useWorkbenchRootPromptStore.getState();

        dismissWorkbenchRootCandidate('session-never-shown');

        // No matching own key means the store must return the same object reference instead of a
        // new one, so unrelated subscribers do not re-render.
        expect(useWorkbenchRootPromptStore.getState()).toBe(before);
    });
});
