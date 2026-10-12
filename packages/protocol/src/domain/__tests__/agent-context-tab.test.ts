import { describe, expect, it } from 'vitest';

import {
    agentContextTabPath,
    isAgentContextTabPath,
    parseAgentContextTab,
} from '../agent-context-tab';
import { parseAgentStatusTab } from '../agent-status-tab';
import { isVirtualEditorTabPath } from '../virtual-tabs';

describe('Agent context tabs', () => {
    it('round-trips a Terminal id that contains separators', () => {
        const path = agentContextTabPath('terminal/1 a');

        expect(path).toBe('caxri-agent-context://terminal%2F1%20a');
        expect(parseAgentContextTab(path)).toEqual({ terminalId: 'terminal/1 a' });
        expect(isAgentContextTabPath(path)).toBe(true);
        expect(isVirtualEditorTabPath(path)).toBe(true);
        expect(parseAgentStatusTab(path)).toBeUndefined();
    });

    it.each([
        'caxri-agent-context://',
        'caxri-agent-context://terminal-1/extra',
        'caxri-agent-context://bad%ZZ',
        'caxri-agent-status://terminal-1',
    ])('rejects a malformed path: %s', (path) => {
        expect(parseAgentContextTab(path)).toBeUndefined();
        expect(isAgentContextTabPath(path)).toBe(false);
    });
});
