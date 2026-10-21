import { describe, expect, it } from 'vitest';

import type { AgentChatQuestionDraft } from './use-agent-chat-question-draft';
import {
    agentChatQuestionDraftKey,
    agentChatQuestionTicks,
    discardAgentChatQuestionDraft,
    readAgentChatQuestionDraft,
    updateAgentChatQuestionDraft,
} from './use-agent-chat-question-draft';

const initial: AgentChatQuestionDraft = {
    index: 0,
    seen: [0],
    selected: { scope: 'Narrow' },
    typed: {},
    picked: {},
};

describe('question drafts', () => {
    it('keeps a pick made on one card for every card of the same request', () => {
        const key = agentChatQuestionDraftKey('terminal-1', 'request-1');
        updateAgentChatQuestionDraft(key, initial, (draft) => ({
            ...draft,
            index: 1,
            seen: [0, 1],
            selected: { ...draft.selected, scope: 'Wide' },
        }));

        // The Chat's own card mounts later with a fresh initial draft and must read the popup's picks.
        updateAgentChatQuestionDraft(key, initial, (draft) => draft);
        expect(readAgentChatQuestionDraft(key)).toMatchObject({
            index: 1,
            seen: [0, 1],
            selected: { scope: 'Wide' },
        });
        expect(
            readAgentChatQuestionDraft(agentChatQuestionDraftKey('terminal-2', 'request-1')),
        ).toBeUndefined();
    });

    it('forgets the draft once the answer is sent', () => {
        const key = agentChatQuestionDraftKey('terminal-1', 'request-2');
        const other = agentChatQuestionDraftKey('terminal-1', 'request-3');
        updateAgentChatQuestionDraft(key, initial, (draft) => draft);
        updateAgentChatQuestionDraft(other, initial, (draft) => draft);

        discardAgentChatQuestionDraft(key);

        expect(readAgentChatQuestionDraft(key)).toBeUndefined();
        expect(readAgentChatQuestionDraft(other)).toEqual(initial);
    });
});

describe('agentChatQuestionTicks', () => {
    it('toggles the open question and ignores toggles while answering', () => {
        let draft = initial;
        const update = (change: (current: AgentChatQuestionDraft) => AgentChatQuestionDraft) => {
            draft = change(draft);
        };

        agentChatQuestionTicks(draft, update, 'tools', false).toggle('Lint');
        expect([...agentChatQuestionTicks(draft, update, 'tools', false).ticked]).toEqual(['Lint']);

        agentChatQuestionTicks(draft, update, 'tools', true).toggle('Test');
        expect(draft.picked.tools).toEqual(['Lint']);
    });
});
