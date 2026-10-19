import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatPromptHistory,
    agentChatPromptPreview,
    MAX_AGENT_CHAT_PROMPT_HISTORY,
    shouldOpenAgentChatPromptHistory,
    stepAgentChatPromptHistory,
} from '../agent-chat-prompt-history';

/**
 * A message that cites one folder, as the composer sends it.
 */
const FOLDER_MESSAGE =
    '# Files mentioned by the user:\n\n## prettier-config: /work/prettier-config/\n\n## My request for Codex:\n';

const user = (id: string, text: string): AgentChatItem => ({
    id,
    type: 'userMessage',
    text,
});

const bare = {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    metaKey: false,
    shiftKey: false,
};

describe('agentChatPromptHistory', () => {
    it('recalls the words of a message that cited files, without the references', () => {
        expect(
            agentChatPromptHistory([
                user('u1', `${FOLDER_MESSAGE}tidy it`),
                user('u2', FOLDER_MESSAGE),
            ]),
        ).toEqual([{ id: 'u1', prompt: 'tidy it' }]);
    });

    it('lists sent prompts oldest first, collapsing repeats and skipping image-only messages', () => {
        const items: AgentChatItem[] = [
            user('u1', 'first'),
            {
                id: 'a1',
                type: 'agentMessage',
                text: 'reply',
                streaming: false,
            },
            user('u2', '  again  '),
            user('u3', 'again'),
            user('u4', ''),
            user('u5', 'last'),
        ];
        expect(agentChatPromptHistory(items)).toEqual([
            { id: 'u1', prompt: 'first' },
            { id: 'u3', prompt: 'again' },
            { id: 'u5', prompt: 'last' },
        ]);
        expect(agentChatPromptHistory(undefined)).toEqual([]);
    });

    it('moves a prompt sent again to its newest position and keeps only the newest rows', () => {
        expect(
            agentChatPromptHistory([user('u1', 'same'), user('u2', 'other'), user('u3', 'same')]),
        ).toEqual([
            { id: 'u2', prompt: 'other' },
            { id: 'u3', prompt: 'same' },
        ]);
        const many = Array.from({ length: MAX_AGENT_CHAT_PROMPT_HISTORY + 5 }, (_, index) =>
            user(`u${index}`, `prompt ${index}`),
        );
        const history = agentChatPromptHistory(many);
        expect(history).toHaveLength(MAX_AGENT_CHAT_PROMPT_HISTORY);
        expect(history[0]?.prompt).toBe('prompt 5');
        expect(history.at(-1)?.prompt).toBe(`prompt ${MAX_AGENT_CHAT_PROMPT_HISTORY + 4}`);
    });
});

describe('shouldOpenAgentChatPromptHistory', () => {
    it('opens on a bare ArrowUp in an input holding nothing but whitespace', () => {
        expect(shouldOpenAgentChatPromptHistory({ ...bare, key: 'ArrowUp' }, '')).toBe(true);
        expect(shouldOpenAgentChatPromptHistory({ ...bare, key: 'ArrowUp' }, ' \n ')).toBe(true);
        // A draft keeps ArrowUp for the caret, so a multi-line prompt still moves line by line.
        expect(shouldOpenAgentChatPromptHistory({ ...bare, key: 'ArrowUp' }, 'one\ntwo')).toBe(
            false,
        );
        expect(shouldOpenAgentChatPromptHistory({ ...bare, key: 'ArrowDown' }, '')).toBe(false);
    });

    it('leaves modified keys and IME composition alone', () => {
        for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing'])
            expect(
                shouldOpenAgentChatPromptHistory({ ...bare, [modifier]: true, key: 'ArrowUp' }, ''),
            ).toBe(false);
    });
});

describe('stepAgentChatPromptHistory', () => {
    it('moves toward older rows without wrapping and closes past the newest', () => {
        expect(stepAgentChatPromptHistory('previous', 2, 3)).toBe(1);
        expect(stepAgentChatPromptHistory('previous', 0, 3)).toBe(0);
        expect(stepAgentChatPromptHistory('next', 1, 3)).toBe(2);
        expect(stepAgentChatPromptHistory('next', 2, 3)).toBe('close');
    });

    it('fills on Enter or Tab and closes on Escape or any other key', () => {
        expect(stepAgentChatPromptHistory('choose', 1, 3)).toBe('fill');
        expect(stepAgentChatPromptHistory('complete', 1, 3)).toBe('fill');
        expect(stepAgentChatPromptHistory('dismiss', 1, 3)).toBe('close');
        expect(stepAgentChatPromptHistory(undefined, 1, 3)).toBe('close');
    });
});

describe('agentChatPromptPreview', () => {
    it('puts a multi-line prompt on one line', () => {
        expect(agentChatPromptPreview('  fix the\n\n  login   bug ')).toBe('fix the login bug');
    });
});
