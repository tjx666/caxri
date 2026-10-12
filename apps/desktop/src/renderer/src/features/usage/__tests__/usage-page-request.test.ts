import { usageTabPath } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    openEditorTab: vi.fn<(path: string) => void>(),
    terminals: [{ id: 'terminal-1', sessionId: 'session-1' }],
}));

vi.mock('../../editor/document-commands', () => ({ openEditorTab: mocks.openEditorTab }));
vi.mock('../../../stores/selectors', () => ({
    getBootstrap: () => ({ terminals: mocks.terminals }),
}));

import {
    openUsagePage,
    openUsagePageForTerminal,
    useUsagePageRequestStore,
} from '../usage-page-request';

describe('openUsagePage', () => {
    beforeEach(() => {
        mocks.openEditorTab.mockClear();
        useUsagePageRequestStore.setState({ pending: undefined });
    });

    it('opens the Usage tab with a pending Session filter', () => {
        openUsagePage('session-1');

        expect(useUsagePageRequestStore.getState().pending).toEqual({ sessionId: 'session-1' });
        expect(mocks.openEditorTab).toHaveBeenCalledWith(usageTabPath());
    });

    it('asks for every Session when no Session is given, replacing an untaken filter', () => {
        openUsagePage('session-1');
        openUsagePage();

        expect(useUsagePageRequestStore.getState().pending).toEqual({});
    });

    it('clears the request once the page consumes it', () => {
        openUsagePage('session-1');
        useUsagePageRequestStore.getState().consumeUsagePageRequest();

        expect(useUsagePageRequestStore.getState().pending).toBeUndefined();
    });
});

describe('openUsagePageForTerminal', () => {
    beforeEach(() => useUsagePageRequestStore.setState({ pending: undefined }));

    it("narrows the page to the Terminal's Session", () => {
        openUsagePageForTerminal('terminal-1');

        expect(useUsagePageRequestStore.getState().pending).toEqual({ sessionId: 'session-1' });
    });

    it('falls back to every Session for an unknown Terminal', () => {
        openUsagePageForTerminal('terminal-gone');

        expect(useUsagePageRequestStore.getState().pending).toEqual({});
    });
});
