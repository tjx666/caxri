import { describe, expect, it } from 'vitest';

import {
    isAgentChatQuestionEnterKey,
    isAgentChatQuestionEnterTarget,
} from '../use-agent-chat-question-enter-key';

const key = (
    value: string,
    flags: Partial<{
        metaKey: boolean;
        ctrlKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
        isComposing: boolean;
        repeat: boolean;
    }> = {},
) => ({
    key: value,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    repeat: false,
    ...flags,
});

describe('isAgentChatQuestionEnterKey', () => {
    it('answers on plain Enter only', () => {
        expect(isAgentChatQuestionEnterKey(key('Enter'))).toBe(true);
        expect(isAgentChatQuestionEnterKey(key('a'))).toBe(false);
        expect(isAgentChatQuestionEnterKey(key('Enter', { shiftKey: true }))).toBe(false);
        expect(isAgentChatQuestionEnterKey(key('Enter', { metaKey: true }))).toBe(false);
        expect(isAgentChatQuestionEnterKey(key('Enter', { isComposing: true }))).toBe(false);
        expect(isAgentChatQuestionEnterKey(key('Enter', { repeat: true }))).toBe(false);
    });
});

describe('isAgentChatQuestionEnterTarget', () => {
    it('takes Enter from nowhere, an empty Chat composer, or a static element', () => {
        expect(isAgentChatQuestionEnterTarget(null)).toBe(true);
        expect(
            isAgentChatQuestionEnterTarget({
                isContentEditable: true,
                role: 'textbox',
                tagName: 'DIV',
                value: '',
            }),
        ).toBe(true);
        expect(isAgentChatQuestionEnterTarget({ tagName: 'DIV', role: 'log' })).toBe(true);
    });

    it('leaves Enter to a draft, a text field, a Terminal or Editor, and controls', () => {
        expect(
            isAgentChatQuestionEnterTarget({
                isContentEditable: true,
                tagName: 'DIV',
                value: 'hi',
            }),
        ).toBe(false);
        expect(isAgentChatQuestionEnterTarget({ isContentEditable: true, tagName: 'DIV' })).toBe(
            false,
        );
        // xterm and Monaco type into an empty hidden textarea.
        expect(isAgentChatQuestionEnterTarget({ tagName: 'TEXTAREA', value: '' })).toBe(false);
        expect(isAgentChatQuestionEnterTarget({ tagName: 'INPUT', value: '' })).toBe(false);
        expect(isAgentChatQuestionEnterTarget({ tagName: 'BUTTON' })).toBe(false);
        expect(isAgentChatQuestionEnterTarget({ tagName: 'DIV', role: 'tab' })).toBe(false);
        // A Files or Session row opens on Enter.
        expect(isAgentChatQuestionEnterTarget({ tagName: 'DIV', role: 'treeitem' })).toBe(false);
    });
});
