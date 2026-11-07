import { describe, expect, it } from 'vitest';

import { virtualEditorTabScheme } from '../../virtual-tabs';
import {
    agentDelegationTabPath,
    isAgentDelegationTabPath,
    parseAgentDelegationTab,
} from '../delegation-tab';
import { parseAgentSideChatTab } from '../side-chat-tab';

describe('Agent delegation tabs', () => {
    it('round-trips the child Chat Terminal id as its own virtual scheme', () => {
        const path = agentDelegationTabPath('terminal/1 a');

        expect(path).toBe('caxri-agent-delegation://terminal%2F1%20a');
        expect(parseAgentDelegationTab(path)).toEqual({ terminalId: 'terminal/1 a' });
        expect(isAgentDelegationTabPath(path)).toBe(true);
        expect(virtualEditorTabScheme(path)).toBe('agentDelegation');
        expect(parseAgentSideChatTab(path)).toBeUndefined();
    });

    it.each([
        'caxri-agent-delegation://',
        'caxri-agent-delegation://a/b',
        'caxri-agent-side-chat://a',
    ])('rejects a malformed path: %s', (path) => {
        expect(parseAgentDelegationTab(path)).toBeUndefined();
    });
});
