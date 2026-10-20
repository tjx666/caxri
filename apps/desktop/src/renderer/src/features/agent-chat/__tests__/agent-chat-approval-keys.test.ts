import { describe, expect, it } from 'vitest';

import {
    agentChatApprovalKeyDecision,
    isAgentChatComposerEmpty,
} from '../agent-chat-approval-keys';

const key = (
    value: string,
    modifiers: Partial<{
        metaKey: boolean;
        ctrlKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
    }> = {},
    flags: Partial<{ isComposing: boolean; repeat: boolean }> = {},
) => ({
    key: value,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    repeat: false,
    ...modifiers,
    ...flags,
});

describe('agentChatApprovalKeyDecision', () => {
    const empty = { isComposerEmpty: true };

    it('accepts on Cmd+Enter and denies on Cmd+Backspace while the composer is empty', () => {
        expect(agentChatApprovalKeyDecision(key('Enter', { metaKey: true }), empty)).toBe('accept');
        expect(agentChatApprovalKeyDecision(key('Backspace', { metaKey: true }), empty)).toBe(
            'decline',
        );
    });

    it('leaves plain Enter and Escape to the composer', () => {
        expect(agentChatApprovalKeyDecision(key('Enter'), empty)).toBeUndefined();
        expect(agentChatApprovalKeyDecision(key('Escape'), empty)).toBeUndefined();
    });

    it('never answers over a draft, a held key, an IME composition, or an extra modifier', () => {
        const accept = key('Enter', { metaKey: true });
        expect(agentChatApprovalKeyDecision(accept, { isComposerEmpty: false })).toBeUndefined();
        expect(
            agentChatApprovalKeyDecision(key('Enter', { metaKey: true }, { repeat: true }), empty),
        ).toBeUndefined();
        expect(
            agentChatApprovalKeyDecision(
                key('Enter', { metaKey: true }, { isComposing: true }),
                empty,
            ),
        ).toBeUndefined();
        expect(
            agentChatApprovalKeyDecision(key('Enter', { metaKey: true, shiftKey: true }), empty),
        ).toBeUndefined();
    });
});

describe('isAgentChatComposerEmpty', () => {
    it('reads a text field by its value and anything else as empty', () => {
        expect(isAgentChatComposerEmpty({ tagName: 'TEXTAREA', value: '' })).toBe(true);
        expect(isAgentChatComposerEmpty({ tagName: 'TEXTAREA', value: 'draft' })).toBe(false);
        expect(isAgentChatComposerEmpty({ tagName: 'INPUT', value: 'other' })).toBe(false);
        expect(isAgentChatComposerEmpty({ tagName: 'BUTTON' })).toBe(true);
        expect(
            isAgentChatComposerEmpty({ isContentEditable: true, tagName: 'DIV', value: '' }),
        ).toBe(true);
        expect(
            isAgentChatComposerEmpty({ isContentEditable: true, tagName: 'DIV', value: 'draft' }),
        ).toBe(false);
        expect(isAgentChatComposerEmpty({ isContentEditable: true, tagName: 'DIV' })).toBe(false);
        expect(isAgentChatComposerEmpty(null)).toBe(true);
    });
});
