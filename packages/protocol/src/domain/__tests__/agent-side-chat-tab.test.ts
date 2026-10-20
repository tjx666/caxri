import { describe, expect, it } from 'vitest';

import { parseAgentContextTab } from '../agent-context-tab';
import {
    agentSideChatTabPath,
    isAgentSideChatTabPath,
    parseAgentSideChatTab,
} from '../agent-side-chat-tab';
import { isVirtualEditorTabPath, virtualEditorTabScheme } from '../virtual-tabs';

describe('Agent side chat tabs', () => {
    it('round-trips a Terminal id that contains separators', () => {
        const path = agentSideChatTabPath('terminal/1 a');

        expect(path).toBe('caxri-agent-side-chat://terminal%2F1%20a');
        expect(parseAgentSideChatTab(path)).toEqual({ terminalId: 'terminal/1 a' });
        expect(isAgentSideChatTabPath(path)).toBe(true);
        expect(isVirtualEditorTabPath(path)).toBe(true);
        expect(virtualEditorTabScheme(path)).toBe('agentSideChat');
        expect(parseAgentContextTab(path)).toBeUndefined();
    });

    it.each([
        'caxri-agent-side-chat://',
        'caxri-agent-side-chat://terminal-1/extra',
        'caxri-agent-side-chat://bad%ZZ',
        'caxri-agent-context://terminal-1',
    ])('rejects a malformed path: %s', (path) => {
        expect(parseAgentSideChatTab(path)).toBeUndefined();
        expect(isAgentSideChatTabPath(path)).toBe(false);
    });
});
