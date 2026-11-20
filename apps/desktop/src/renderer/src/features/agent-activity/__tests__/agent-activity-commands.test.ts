import type { BootstrapState, ProjectRecord, SessionRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    markSessionsDone: vi.fn(),
    didSelectSession: vi.fn(),
    showConfirm: vi.fn(),
}));
vi.mock('../../session/session-commands', () => ({
    cachedMergedPullRequestSessionIds: () => new Set<string>(),
    markSessionsDone: mocks.markSessionsDone,
    didSelectSession: mocks.didSelectSession,
}));
vi.mock(import('../../../stores/confirmations'), async (importOriginal) => ({
    ...(await importOriginal()),
    showConfirm: mocks.showConfirm,
}));

import { useChromeLayoutStore } from '../../../stores/chrome-layout';
import { useWorkbenchStore } from '../../../stores/workbench';
import {
    focusNextAttentionSession,
    markAllAttentionSessionsDone,
} from '../agent-activity-commands';

function project(id: string): ProjectRecord {
    return { title: id, id } as ProjectRecord;
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        attentionGeneration: 0,
        title: id,
        hasPendingAttention: false,
        hasUnread: false,
        id,
        agentActivityState: 'idle',
        sessionActivityAt: 1,
        projectId: 'alpha',
        acknowledgedAttentionGeneration: 0,
        sidebarOrder: 0,
        ...overrides,
    } as SessionRecord;
}

function bootstrap(selectedSessionId: string | undefined): BootstrapState {
    return {
        projects: [project('alpha')],
        selectedSessionId,
        sessions: [
            session('quiet'),
            session('older', { hasPendingAttention: true, sessionActivityAt: 10 }),
            session('newer', { hasPendingAttention: true, sessionActivityAt: 20 }),
        ],
        terminals: [],
    } as unknown as BootstrapState;
}

/**
 * The shortcut computes its own queue from the Workbench store instead of reading the Activity view's memoized groups.
 * That view only exists while the Primary Side Bar shows Activity, so this is what keeps `cmd+shift+n` working while
 * the queue is hidden or was never opened (issue caxri#1111).
 */
describe('focusNextAttentionSession', () => {
    beforeEach(() => {
        mocks.didSelectSession.mockReset();
        mocks.didSelectSession.mockResolvedValue(true);
        useChromeLayoutStore.setState({
            primarySidebarActivityMode: false,
            primarySidebarVisible: false,
        });
    });

    it('selects the next Session that needs the user while the queue is not mounted', () => {
        useWorkbenchStore.setState({ bootstrap: bootstrap('quiet') });

        focusNextAttentionSession();

        expect(mocks.didSelectSession).toHaveBeenCalledExactlyOnceWith('newer');
        expect(useChromeLayoutStore.getState()).toMatchObject({
            primarySidebarActivityMode: true,
            primarySidebarVisible: true,
        });
    });

    it('cycles past the current selection', () => {
        useWorkbenchStore.setState({ bootstrap: bootstrap('newer') });

        focusNextAttentionSession();

        expect(mocks.didSelectSession).toHaveBeenCalledExactlyOnceWith('older');
    });

    it('does nothing before the first snapshot', () => {
        useWorkbenchStore.setState({ bootstrap: undefined });

        focusNextAttentionSession();

        expect(mocks.didSelectSession).not.toHaveBeenCalled();
        expect(useChromeLayoutStore.getState().primarySidebarActivityMode).toBe(false);
    });
});

describe('markAllAttentionSessionsDone', () => {
    beforeEach(() => {
        mocks.markSessionsDone.mockReset();
        mocks.markSessionsDone.mockResolvedValue(2);
        mocks.showConfirm.mockReset();
    });

    it('resolves every Session in Needs attention at its shown generation after confirming', async () => {
        useWorkbenchStore.setState({ bootstrap: bootstrap('quiet') });
        mocks.showConfirm.mockResolvedValue(true);

        await markAllAttentionSessionsDone();

        expect(mocks.showConfirm).toHaveBeenCalledOnce();
        expect(mocks.markSessionsDone).toHaveBeenCalledExactlyOnceWith([
            { sessionId: 'newer', attentionGeneration: 0 },
            { sessionId: 'older', attentionGeneration: 0 },
        ]);
    });

    it('sends nothing when the user cancels', async () => {
        useWorkbenchStore.setState({ bootstrap: bootstrap('quiet') });
        mocks.showConfirm.mockResolvedValue(false);

        await markAllAttentionSessionsDone();

        expect(mocks.markSessionsDone).not.toHaveBeenCalled();
    });

    it('asks nothing when the queue is empty', async () => {
        useWorkbenchStore.setState({
            bootstrap: { ...bootstrap('quiet'), sessions: [session('quiet')] },
        });

        await markAllAttentionSessionsDone();

        expect(mocks.showConfirm).not.toHaveBeenCalled();
    });
});
