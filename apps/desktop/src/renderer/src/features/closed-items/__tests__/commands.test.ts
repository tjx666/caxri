import { createPaneLayout } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isReopenableFile: vi.fn<(sessionId: string, path: string) => Promise<boolean>>(),
    didSelectSession: vi.fn<(sessionId: string) => Promise<boolean>>(),
    openFileForSession: vi.fn<(...arguments_: unknown[]) => Promise<string | false>>(),
    sessionStateOf: vi.fn(),
}));
vi.mock('../reopen-client', () => ({ isReopenableFile: mocks.isReopenableFile }));
vi.mock('../../session/session-commands', () => ({ didSelectSession: mocks.didSelectSession }));
vi.mock('../../editor/document-commands', () => ({
    didOpenEditorTabForSession: vi.fn(),
    openFileForSession: mocks.openFileForSession,
}));
vi.mock('../../editor/session-pane-state', () => ({ sessionStateOf: mocks.sessionStateOf }));
vi.mock('../../../stores/toasts', () => ({ pushToast: vi.fn() }));

import { useWorkbenchStore } from '../../../stores/workbench';
import { reopenClosedItem } from '../commands';
import { closedItems } from '../stack';

const tab = (sessionId: string, path: string) => ({
    kind: 'tab' as const,
    sessionId,
    paneId: 'pane-1',
    index: 0,
    path,
});

describe('reopenClosedItem', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        closedItems.clear();
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-b',
                sessions: [{ id: 'session-a' }, { id: 'session-b' }],
            } as never,
        });
        mocks.sessionStateOf.mockReturnValue({
            workbenchProjectId: 'project',
            paneLayout: createPaneLayout(undefined, () => 'pane-1'),
        });
        mocks.didSelectSession.mockResolvedValue(true);
        mocks.openFileForSession.mockResolvedValue('/project/kept.md');
    });

    it('skips a deleted file without showing its Session and reopens the entry before it', async () => {
        closedItems.push([
            tab('session-b', '/project/kept.md'),
            tab('session-a', '/project/notes.md'),
        ]);
        mocks.isReopenableFile.mockImplementation((_sessionId, path) =>
            Promise.resolve(path !== '/project/notes.md'),
        );

        await reopenClosedItem();

        expect(mocks.didSelectSession).not.toHaveBeenCalled();
        expect(mocks.openFileForSession).toHaveBeenCalledTimes(1);
        expect(mocks.openFileForSession).toHaveBeenCalledWith('session-b', '/project/kept.md', {
            paneId: 'pane-1',
        });
        expect(closedItems.snapshot()).toEqual([]);
    });

    it('shows the Session of a closed file that still exists', async () => {
        closedItems.push([tab('session-a', '/project/kept.md')]);
        mocks.isReopenableFile.mockResolvedValue(true);

        await reopenClosedItem();

        expect(mocks.didSelectSession).toHaveBeenCalledWith('session-a');
        expect(mocks.openFileForSession).toHaveBeenCalledWith('session-a', '/project/kept.md', {
            paneId: 'pane-1',
        });
    });
});
