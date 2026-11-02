import type { AgentChatPatchOperation } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatSessionHost } from '../../../chat-provider';
import { applyClaudePromptSuggestion } from '../system-notices';

function harness(state: Extract<AgentChatPatchOperation, { op: 'state' }>['state']) {
    let snapshot = applyAgentChatOperation(emptyAgentChatSnapshot('terminal-1'), {
        op: 'state',
        state,
    });
    const host: Pick<AgentChatSessionHost, 'apply' | 'read'> = {
        read: () => snapshot,
        apply: (operations) => {
            snapshot = operations.reduce(applyAgentChatOperation, snapshot);
        },
    };
    return host;
}

describe('applyClaudePromptSuggestion', () => {
    it('stores the suggestion for the latest reply', () => {
        const host = harness({ usage: { totalTokens: 10, lastResponseAt: 42 } });
        applyClaudePromptSuggestion(host, {
            type: 'prompt_suggestion',
            suggestion: '  Run `bun run test` again  ',
        });
        expect(host.read().promptSuggestion).toEqual({
            text: 'Run `bun run test` again',
            lastResponseAt: 42,
        });
    });

    it('drops a suggestion that arrives after the next turn started', () => {
        const host = harness({
            activeTurnId: 'turn-2',
            usage: { totalTokens: 10, lastResponseAt: 42 },
        });
        applyClaudePromptSuggestion(host, { type: 'prompt_suggestion', suggestion: 'Next' });
        expect(host.read().promptSuggestion).toBeUndefined();
    });

    it('drops an empty suggestion or one with no reply to follow', () => {
        const blank = harness({ usage: { totalTokens: 10, lastResponseAt: 42 } });
        applyClaudePromptSuggestion(blank, {
            type: 'prompt_suggestion',
            suggestion: ' '.repeat(3),
        });
        expect(blank.read().promptSuggestion).toBeUndefined();

        const noReply = harness({});
        applyClaudePromptSuggestion(noReply, { type: 'prompt_suggestion', suggestion: 'Next' });
        expect(noReply.read().promptSuggestion).toBeUndefined();
    });
});
