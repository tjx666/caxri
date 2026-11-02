import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../../i18n';
import {
    agentChatComposerPrompt,
    isAgentChatAcceptSuggestionKey,
} from '../agent-chat-composer-keys';

const translate = ((key: string, options?: { suggestion?: string }) =>
    options?.suggestion === undefined ? key : `${options.suggestion} · ${key}`) as Translate;
const idle = {
    edit: { isEditing: false, sendAction: { placeholder: 'Message Claude' } },
    goalMode: { isOn: false },
    isTurnRunning: false,
    nextQueuedId: undefined,
    promptSuggestion: 'Run the tests',
    stash: { hasStash: false },
};
const tab = {
    key: 'Tab',
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    metaKey: false,
    shiftKey: false,
};

describe('agentChatComposerPrompt', () => {
    it('offers the suggestion to an idle composer as its placeholder', () => {
        expect(agentChatComposerPrompt(idle, translate)).toEqual({
            offeredSuggestion: 'Run the tests',
            placeholder: 'Run the tests · agentChat.promptSuggestion.placeholder',
        });
        expect(
            agentChatComposerPrompt({ ...idle, promptSuggestion: undefined }, translate),
        ).toEqual({
            offeredSuggestion: undefined,
            placeholder: 'Message Claude',
        });
    });

    it.each([
        ['a queued message', { nextQueuedId: 'queued-1' }],
        ['a stash', { stash: { hasStash: true } }],
        ['an edit', { edit: { ...idle.edit, isEditing: true } }],
        ['Goal mode', { goalMode: { isOn: true } }],
    ])('yields the input to the placeholder %s needs', (_, state) => {
        const prompt = agentChatComposerPrompt({ ...idle, ...state }, translate);
        expect(prompt.offeredSuggestion).toBeUndefined();
        expect(prompt.placeholder).not.toContain('Run the tests');
    });
});

describe('isAgentChatAcceptSuggestionKey', () => {
    it('accepts a plain Tab in an empty input', () => {
        expect(isAgentChatAcceptSuggestionKey(tab, '')).toBe(true);
    });

    it('leaves Tab alone once the input holds text', () => {
        expect(isAgentChatAcceptSuggestionKey(tab, 'R')).toBe(false);
    });

    it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing'] as const)(
        'leaves Tab with %s to its own meaning',
        (flag) => {
            expect(isAgentChatAcceptSuggestionKey({ ...tab, [flag]: true }, '')).toBe(false);
        },
    );

    it('ignores other keys', () => {
        expect(isAgentChatAcceptSuggestionKey({ ...tab, key: 'Enter' }, '')).toBe(false);
    });
});
