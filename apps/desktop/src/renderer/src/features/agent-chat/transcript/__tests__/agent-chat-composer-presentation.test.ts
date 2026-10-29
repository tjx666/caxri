import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    agentChatCommandMenuKeyStep,
    agentChatComposerPlaceholder,
    agentChatSendRefusal,
    agentChatSkillLabel,
    shouldAgentChatPaneEscapeStop,
    shouldConfirmUnmatchedSend,
} from '../agent-chat-presentation';

describe('agentChatComposerPlaceholder', () => {
    const sendAction = { placeholder: 'Queue a follow-up' };

    it('says Enter steers the first queued message in a running turn, and says Enter sends it in an idle Chat', () => {
        const state = {
            hasNextQueued: true,
            hasStash: false,
            isEditing: false,
            isGoalMode: false,
            isTurnRunning: true,
        };
        expect(agentChatComposerPlaceholder(sendAction, state, translate)).toBe(
            'Enter to steer the first queued message',
        );
        expect(
            agentChatComposerPlaceholder(sendAction, { ...state, isTurnRunning: false }, translate),
        ).toBe('Enter to send the queued message, or type a new one');
        expect(
            agentChatComposerPlaceholder(sendAction, { ...state, isEditing: true }, translate),
        ).toBe(sendAction.placeholder);
        expect(
            agentChatComposerPlaceholder(sendAction, { ...state, hasNextQueued: false }, translate),
        ).toBe(sendAction.placeholder);
    });

    it('asks for the goal in Goal mode', () => {
        expect(
            agentChatComposerPlaceholder(
                sendAction,
                {
                    hasNextQueued: true,
                    hasStash: false,
                    isEditing: false,
                    isGoalMode: true,
                    isTurnRunning: true,
                },
                translate,
            ),
        ).toBe('Describe your goal, define measurable outcomes for best results');
    });

    it('says how to bring back a stashed draft, except during an edit', () => {
        const state = {
            hasNextQueued: false,
            hasStash: true,
            isEditing: false,
            isGoalMode: false,
            isTurnRunning: false,
        };
        expect(agentChatComposerPlaceholder(sendAction, state, translate)).toBe(
            'Draft stashed · Ctrl+S to restore',
        );
        expect(
            agentChatComposerPlaceholder(sendAction, { ...state, isEditing: true }, translate),
        ).toBe(sendAction.placeholder);
    });
});

describe('agentChatSendRefusal', () => {
    const action = { tooltip: 'Send (Enter)' };
    const held = {
        block: undefined,
        hasContent: true,
        isAttaching: false,
        isSending: false,
        isSendable: false,
    };

    it('says why Enter did not send a typed draft', () => {
        expect(agentChatSendRefusal(action, { ...held, block: 'loading' }, translate)).toBe(
            'Chat loading…',
        );
        expect(agentChatSendRefusal(action, { ...held, isAttaching: true }, translate)).toBe(
            'Attaching…',
        );
        expect(
            agentChatSendRefusal(action, { ...held, isPreparingReference: true }, translate),
        ).toBe('Preparing Session reference…');
        expect(agentChatSendRefusal(action, { ...held, isSending: true }, translate)).toBe(
            'Sending…',
        );
    });

    it('stays quiet when Enter sent or there was nothing to send', () => {
        expect(
            agentChatSendRefusal(action, { ...held, isSendable: true }, translate),
        ).toBeUndefined();
        expect(
            agentChatSendRefusal(
                action,
                { ...held, hasContent: false, block: 'loading' },
                translate,
            ),
        ).toBeUndefined();
    });
});

describe('shouldConfirmUnmatchedSend', () => {
    it('holds the first Enter on an unmatched draft and lets the second one send it', () => {
        expect(
            shouldConfirmUnmatchedSend({
                confirmingDraft: undefined,
                draft: '/tset',
                matchCount: 0,
            }),
        ).toBe(true);
        expect(
            shouldConfirmUnmatchedSend({ confirmingDraft: '/tset', draft: '/tset', matchCount: 0 }),
        ).toBe(false);
        // An edit since the first Enter asks again.
        expect(
            shouldConfirmUnmatchedSend({
                confirmingDraft: '/tset',
                draft: '/tsetx',
                matchCount: 0,
            }),
        ).toBe(true);
        expect(
            shouldConfirmUnmatchedSend({ confirmingDraft: undefined, draft: '/te', matchCount: 2 }),
        ).toBe(false);
    });
});

describe('agentChatCommandMenuKeyStep', () => {
    const matched = {
        confirmingDraft: undefined,
        draft: '/te',
        matchCount: 2,
        hasActiveCommand: true,
    };
    const unmatched = {
        confirmingDraft: undefined,
        draft: '/tset',
        matchCount: 0,
        hasActiveCommand: false,
    };

    it('moves, completes, chooses, and dismisses on a list with an active row', () => {
        expect(agentChatCommandMenuKeyStep('next', matched)).toEqual({ kind: 'move', delta: 1 });
        expect(agentChatCommandMenuKeyStep('previous', matched)).toEqual({
            kind: 'move',
            delta: -1,
        });
        expect(agentChatCommandMenuKeyStep('complete', matched)).toEqual({
            kind: 'run',
            handler: 'complete',
        });
        expect(agentChatCommandMenuKeyStep('choose', matched)).toEqual({
            kind: 'run',
            handler: 'choose',
        });
        expect(agentChatCommandMenuKeyStep('dismiss', matched)).toEqual({ kind: 'dismiss' });
        expect(agentChatCommandMenuKeyStep(undefined, matched)).toBeUndefined();
    });

    it('holds the first Enter with no match, then lets the composer send it', () => {
        expect(agentChatCommandMenuKeyStep('choose', unmatched)).toEqual({ kind: 'confirm' });
        expect(
            agentChatCommandMenuKeyStep('choose', { ...unmatched, confirmingDraft: '/tset' }),
        ).toBeUndefined();
        expect(agentChatCommandMenuKeyStep('dismiss', unmatched)).toEqual({ kind: 'dismiss' });
        expect(agentChatCommandMenuKeyStep('next', unmatched)).toBeUndefined();
        expect(agentChatCommandMenuKeyStep('complete', unmatched)).toBeUndefined();
    });
});

describe('agentChatSkillLabel', () => {
    it('names the product skill by its product name and any other skill by its own', () => {
        expect(agentChatSkillLabel('caxri-cli', translate)).toBe('Caxri skill');
        expect(agentChatSkillLabel('release-notes', translate)).toBe('release-notes');
    });
});

describe('shouldAgentChatPaneEscapeStop', () => {
    const key = { key: 'Escape', isComposing: false, repeat: false, defaultPrevented: false };
    const idle = { isTurnRunning: true, isEditableTarget: false, isOverlayOpen: false };

    it('stops a running turn from outside the composer', () => {
        expect(shouldAgentChatPaneEscapeStop(key, idle)).toBe(true);
    });

    it.each([
        ['no turn is running', key, { ...idle, isTurnRunning: false }],
        ['focus is in an editable field', key, { ...idle, isEditableTarget: true }],
        ['an overlay is open', key, { ...idle, isOverlayOpen: true }],
        ['the key was already handled', { ...key, defaultPrevented: true }, idle],
        ['the key is held', { ...key, repeat: true }, idle],
        ['an IME composition is active', { ...key, isComposing: true }, idle],
        ['the key is not Escape', { ...key, key: 'a' }, idle],
    ])('does nothing when %s', (_name, event, state) => {
        expect(shouldAgentChatPaneEscapeStop(event, state)).toBe(false);
    });
});
