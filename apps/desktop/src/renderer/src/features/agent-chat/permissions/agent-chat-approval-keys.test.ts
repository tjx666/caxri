import { describe, expect, it } from 'vitest';

import {
    agentChatApprovalKeyOwner,
    isAgentChatComposerEmpty,
    isAgentChatStaticTarget,
} from './agent-chat-approval-keys';

const composer = (value: string) => ({ isContentEditable: true, tagName: 'DIV', value });

describe('agentChatApprovalKeyOwner', () => {
    it("answers a Chat pane's own approval from its empty composer or a control in the pane", () => {
        expect(agentChatApprovalKeyOwner(composer(''), 'withApproval')).toBe('pane');
        expect(agentChatApprovalKeyOwner({ tagName: 'BUTTON' }, 'withApproval')).toBe('pane');
        expect(agentChatApprovalKeyOwner(null, 'withApproval')).toBe('pane');
    });

    it('leaves the chord to a composer holding a draft, even with an approval waiting', () => {
        expect(agentChatApprovalKeyOwner(composer('draft'), 'withApproval')).toBeUndefined();
        expect(agentChatApprovalKeyOwner(composer('draft'), 'withoutApproval')).toBeUndefined();
    });

    it("answers the waiting popup's approval only from a static spot outside any approval", () => {
        expect(agentChatApprovalKeyOwner(null, 'none')).toBe('popup');
        expect(agentChatApprovalKeyOwner({ tagName: 'DIV' }, 'none')).toBe('popup');
        expect(agentChatApprovalKeyOwner({ tagName: 'DIV' }, 'withoutApproval')).toBe('popup');
    });

    it('keeps the chord where focus already does something with it', () => {
        // An empty composer, a Terminal's or Editor's hidden textarea, a Session row, a Files row, a button.
        expect(agentChatApprovalKeyOwner(composer(''), 'withoutApproval')).toBeUndefined();
        expect(agentChatApprovalKeyOwner({ tagName: 'TEXTAREA', value: '' }, 'none')).toBe(
            undefined,
        );
        expect(agentChatApprovalKeyOwner({ role: 'treeitem', tagName: 'DIV' }, 'none')).toBe(
            undefined,
        );
        expect(agentChatApprovalKeyOwner({ tagName: 'BUTTON' }, 'none')).toBeUndefined();
    });
});

describe('isAgentChatStaticTarget', () => {
    it('reads nothing focused and plain elements as static, and every control as not', () => {
        expect(isAgentChatStaticTarget(null)).toBe(true);
        expect(isAgentChatStaticTarget({ tagName: 'SECTION', role: 'log' })).toBe(true);
        expect(isAgentChatStaticTarget({ tagName: 'A' })).toBe(false);
        expect(isAgentChatStaticTarget({ tagName: 'INPUT' })).toBe(false);
        expect(isAgentChatStaticTarget({ tagName: 'DIV', role: 'radio' })).toBe(false);
        expect(isAgentChatStaticTarget(composer(''))).toBe(false);
    });
});

describe('isAgentChatComposerEmpty', () => {
    it('reads a text field by its value and anything else as empty', () => {
        expect(isAgentChatComposerEmpty({ tagName: 'TEXTAREA', value: '' })).toBe(true);
        expect(isAgentChatComposerEmpty({ tagName: 'TEXTAREA', value: 'draft' })).toBe(false);
        expect(isAgentChatComposerEmpty({ tagName: 'INPUT', value: 'other' })).toBe(false);
        expect(isAgentChatComposerEmpty({ tagName: 'BUTTON' })).toBe(true);
        expect(isAgentChatComposerEmpty(composer(''))).toBe(true);
        expect(isAgentChatComposerEmpty(composer('draft'))).toBe(false);
        expect(isAgentChatComposerEmpty({ isContentEditable: true, tagName: 'DIV' })).toBe(false);
        expect(isAgentChatComposerEmpty(null)).toBe(true);
    });
});
