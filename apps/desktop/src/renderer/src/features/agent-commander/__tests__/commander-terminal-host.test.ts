import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(null)),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));

import { useDialogStore } from '../../../stores/dialogs';
import { terminalPaneHost } from '../../terminal/terminal-pane-host';
import { configureCommanderTerminalHost, openCommanderInbox } from '../commander-commands';

beforeEach(() => {
    mocks.caxriRequest.mockClear();
    configureCommanderTerminalHost();
});

describe('Agent Commander Terminal host', () => {
    it('opens Settings in the Workbench instead of a dialog this window never renders', () => {
        const before = useDialogStore.getState().settingsRequest;

        terminalPaneHost().openSettings();

        expect(mocks.caxriRequest).toHaveBeenCalledWith('agentCommander.openSettings');
        expect(useDialogStore.getState().settingsRequest).toBe(before);
    });

    it('keeps Terminal links to what the window can open', () => {
        expect(terminalPaneHost().hasWorkbenchLinks).toBe(false);
    });
});

describe('openCommanderInbox', () => {
    it('asks Main to raise the Commander with its Inbox open', () => {
        openCommanderInbox();

        expect(mocks.caxriRequest).toHaveBeenCalledWith('agentCommander.open', { target: 'inbox' });
    });
});
