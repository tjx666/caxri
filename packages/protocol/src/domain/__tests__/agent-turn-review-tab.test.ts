import { describe, expect, it } from 'vitest';

import { agentTaskTabPath } from '../agent-task-tab';
import {
    agentTurnReviewTabPath,
    isAgentTurnReviewTabPath,
    parseAgentTurnReviewTab,
} from '../agent-turn-review-tab';
import { isVirtualEditorTabPath } from '../virtual-tabs';

describe('Agent turn review tabs', () => {
    it('round-trips a Terminal and a turn that contain separators', () => {
        const path = agentTurnReviewTabPath('terminal/1', 'turn 2/a');

        expect(path).toBe('caxri-agent-turn-review://terminal%2F1/turn%202%2Fa');
        expect(parseAgentTurnReviewTab(path)).toEqual({
            terminalId: 'terminal/1',
            turnId: 'turn 2/a',
        });
        expect(isAgentTurnReviewTabPath(path)).toBe(true);
        expect(isVirtualEditorTabPath(path)).toBe(true);
    });

    it.each([
        'caxri-agent-turn-review://',
        'caxri-agent-turn-review://terminal-1',
        'caxri-agent-turn-review:///turn-1',
        'caxri-agent-turn-review://terminal-1/turn-1/extra',
        'caxri-agent-turn-review://bad%ZZ/turn-1',
        '/project/src/a.ts',
    ])('rejects malformed paths: %s', (path) => {
        expect(parseAgentTurnReviewTab(path)).toBeUndefined();
        expect(isAgentTurnReviewTabPath(path)).toBe(false);
    });

    it('does not claim task tabs', () => {
        expect(parseAgentTurnReviewTab(agentTaskTabPath('terminal-1', 'turn-1'))).toBeUndefined();
    });
});
