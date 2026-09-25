import { describe, expect, it, vi } from 'vitest';

import { submitAgentText } from '../agent-submission';

describe('submitAgentText', () => {
    it('does not send Return when the exact Agent exits during the paste write', async () => {
        let isRunning = true;
        const writeWithCompletion = vi.fn(() => {
            isRunning = false;
            return Promise.resolve(true);
        });
        const result = await submitAgentText(
            { writeWithCompletion },
            { running: true, agentLaunchId: 'launch-1', agentProcessId: 42 },
            'terminal-1',
            'launch-1',
            'message',
            () => isRunning,
        );
        expect(result).toEqual({ outcome: 'unknown' });
        expect(writeWithCompletion).toHaveBeenCalledExactlyOnceWith(
            'terminal-1',
            '\u{1B}[200~message\u{1B}[201~',
        );
    });
});
