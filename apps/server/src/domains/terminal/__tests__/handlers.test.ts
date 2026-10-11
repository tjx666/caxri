import { describe, expect, it, vi } from 'vitest';

import { createTerminalHandlers } from '../handlers';
import type { TerminalManager } from '../index';

function handlers(countRunning: (sessionId?: string) => number) {
    return createTerminalHandlers({
        countRunning,
        database: { getTerminal: vi.fn() },
        resourceMonitor: { processes: vi.fn(() => []), readingOverride: vi.fn() },
        terminals: {} as TerminalManager,
        terminalSuspension: { suspendOnRequest: vi.fn() },
    });
}

describe('terminal.runningCount', () => {
    it('reports the shared running count, so a Chat-only window still asks before closing', async () => {
        const countRunning = vi.fn((sessionId?: string) => (sessionId === 'session-1' ? 1 : 2));
        const runningCount = handlers(countRunning)['terminal.runningCount'];

        expect(await runningCount({})).toBe(2);
        expect(await runningCount({ sessionId: 'session-1' })).toBe(1);
        expect(countRunning).toHaveBeenNthCalledWith(1, undefined);
        expect(countRunning).toHaveBeenNthCalledWith(2, 'session-1');
    });
});
