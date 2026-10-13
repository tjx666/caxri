import { describe, expect, it } from 'vitest';

import { agentTaskTabPath, isAgentTaskTabPath, parseAgentTaskTab } from '../agent-task-tab';
import { agentTranscriptTabPath } from '../agent-transcript';
import { isVirtualEditorTabPath } from '../virtual-tabs';

describe('Agent task tabs', () => {
    it('round-trips a Terminal and a task key that contain separators', () => {
        const path = agentTaskTabPath('terminal/1', 'toolu_01/abc def');

        expect(path).toBe('caxri-agent-task://terminal%2F1/toolu_01%2Fabc%20def');
        expect(parseAgentTaskTab(path)).toEqual({
            terminalId: 'terminal/1',
            taskId: 'toolu_01/abc def',
        });
        expect(isAgentTaskTabPath(path)).toBe(true);
        expect(isVirtualEditorTabPath(path)).toBe(true);
    });

    it.each([
        'caxri-agent-task://',
        'caxri-agent-task://terminal-1',
        'caxri-agent-task://terminal-1/',
        'caxri-agent-task:///task-1',
        'caxri-agent-task://terminal-1/task-1/extra',
        'caxri-agent-task://bad%ZZ/task-1',
        '/project/src/a.ts',
    ])('rejects malformed paths: %s', (path) => {
        expect(parseAgentTaskTab(path)).toBeUndefined();
        expect(isAgentTaskTabPath(path)).toBe(false);
    });

    it('does not claim transcript tabs', () => {
        expect(parseAgentTaskTab(agentTranscriptTabPath('terminal-1'))).toBeUndefined();
    });
});
