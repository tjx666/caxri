import { describe, expect, it, vi } from 'vitest';

import { createTerminalHandlers } from '../handlers';
import type { TerminalManager } from '../index';

function handlers(
    runningTerminals: (sessionId?: string) => number,
    liveChats: (sessionId?: string) => number,
) {
    return createTerminalHandlers({
        countLiveChats: liveChats,
        database: { getTerminal: vi.fn() },
        ptyUsage: { usage: vi.fn() },
        resourceMonitor: {
            processes: vi.fn(() => []),
            readingOverride: vi.fn(),
            sessionResources: vi.fn(),
        },
        terminals: { runningCount: runningTerminals } as unknown as TerminalManager,
        terminalSuspension: { suspendOnRequest: vi.fn() },
    });
}

describe('terminal.runningCount', () => {
    it('reports running Terminals and Chats separately, so a Chat-only window still asks before closing', async () => {
        const runningTerminals = vi.fn((sessionId?: string) => (sessionId === 'session-1' ? 0 : 2));
        const liveChats = vi.fn((sessionId?: string) => (sessionId === 'session-1' ? 1 : 3));
        const runningCount = handlers(runningTerminals, liveChats)['terminal.runningCount'];

        expect(await runningCount({})).toEqual({ terminals: 2, chats: 3 });
        expect(await runningCount({ sessionId: 'session-1' })).toEqual({ terminals: 0, chats: 1 });
        expect(runningTerminals.mock.calls).toEqual([[undefined], ['session-1']]);
        expect(liveChats.mock.calls).toEqual([[undefined], ['session-1']]);
    });
});
