import { describe, expect, it } from 'vitest';

import { agentStatusTabPath, isAgentStatusTabPath, parseAgentStatusTab } from '../agent-status-tab';
import { isVirtualEditorTabPath } from '../virtual-tabs';

describe('Agent status tabs', () => {
    it('round-trips a Terminal id that contains separators', () => {
        const path = agentStatusTabPath('terminal/1 a');

        expect(path).toBe('caxri-agent-status://terminal%2F1%20a');
        expect(parseAgentStatusTab(path)).toEqual({ terminalId: 'terminal/1 a' });
        expect(isAgentStatusTabPath(path)).toBe(true);
        expect(isVirtualEditorTabPath(path)).toBe(true);
    });

    it.each([
        'caxri-agent-status://',
        'caxri-agent-status://terminal-1/extra',
        'caxri-agent-status://bad%ZZ',
        'caxri-agent-task://terminal-1/task-1',
    ])('rejects a malformed path: %s', (path) => {
        expect(parseAgentStatusTab(path)).toBeUndefined();
        expect(isAgentStatusTabPath(path)).toBe(false);
    });
});
