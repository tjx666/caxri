import type { BootstrapState, ProjectRecord, SessionRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ didSelectSession: vi.fn() }));
vi.mock('../../session/session-commands', () => ({
    didSelectSession: mocks.didSelectSession,
}));

import { useChromeLayoutStore } from '../../../stores/chrome-layout';
import { useWorkbenchStore } from '../../../stores/workbench';
import { focusNextAttentionSession } from '../agent-activity-commands';

function project(id: string): ProjectRecord {
    return { title: id, id } as ProjectRecord;
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        attentionGeneration: 0,
        title: id,
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
            session('older', { hasUnread: true, sessionActivityAt: 10 }),
            session('newer', { hasUnread: true, sessionActivityAt: 20 }),
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
