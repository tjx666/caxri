import { describe, expect, it } from 'vitest';

import type { AgentChatComposerKey } from '../agent-chat-composer-keys';
import {
    agentChatComposerKeyAction,
    isAgentChatClearKey,
    isAgentChatPlainPasteKey,
} from '../agent-chat-composer-keys';

const press = (
    key: string,
    modifiers: Partial<AgentChatComposerKey> = {},
): AgentChatComposerKey => ({
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...modifiers,
});

const idle = { isBusy: false, isEditing: false, isTurnRunning: false };

describe('agentChatComposerKeyAction', () => {
    it('interrupts a running turn with Escape, but not on a repeat or while composing', () => {
        const running = { ...idle, isBusy: true, isTurnRunning: true };
        expect(agentChatComposerKeyAction(press('Escape'), running)).toEqual({ kind: 'stop' });
        expect(agentChatComposerKeyAction(press('Escape'), idle)).toBeUndefined();
        expect(
            agentChatComposerKeyAction(press('Escape', { repeat: true }), running),
        ).toBeUndefined();
        expect(
            agentChatComposerKeyAction(press('Escape', { isComposing: true }), running),
        ).toBeUndefined();
    });

    it('cancels an edit with Escape once no turn runs, and stops a running turn first', () => {
        const editing = { ...idle, isEditing: true };
        expect(agentChatComposerKeyAction(press('Escape'), editing)).toEqual({
            kind: 'cancelEdit',
        });
        expect(
            agentChatComposerKeyAction(press('Escape'), { ...editing, isTurnRunning: true }),
        ).toEqual({ kind: 'stop' });
    });

    it('submits on Enter, steers on Cmd/Ctrl+Enter during a turn, and leaves Shift+Enter to the textarea', () => {
        const running = { ...idle, isBusy: true, isTurnRunning: true };
        expect(agentChatComposerKeyAction(press('Enter'), idle)).toEqual({
            kind: 'submit',
            delivery: undefined,
        });
        expect(agentChatComposerKeyAction(press('Enter'), running)).toEqual({
            kind: 'submit',
            delivery: undefined,
        });
        expect(agentChatComposerKeyAction(press('Enter', { metaKey: true }), running)).toEqual({
            kind: 'submit',
            delivery: 'steer',
        });
        expect(agentChatComposerKeyAction(press('Enter', { ctrlKey: true }), running)).toEqual({
            kind: 'submit',
            delivery: 'steer',
        });
        expect(
            agentChatComposerKeyAction(press('Enter', { shiftKey: true }), running),
        ).toBeUndefined();
        expect(agentChatComposerKeyAction(press('a'), running)).toBeUndefined();
    });

    it('steers on plain Enter while the main Agent waits on subagents its provider stops waiting for', () => {
        const waiting = { ...idle, isBusy: true, isTurnRunning: true, isSteerDefault: true };
        expect(agentChatComposerKeyAction(press('Enter'), waiting)).toEqual({
            kind: 'submit',
            delivery: 'steer',
        });
        expect(agentChatComposerKeyAction(press('Enter', { metaKey: true }), waiting)).toEqual({
            kind: 'submit',
            delivery: 'steer',
        });
        // Once the turn ends, Enter sends as usual.
        expect(
            agentChatComposerKeyAction(press('Enter'), { ...idle, isSteerDefault: true }),
        ).toEqual({ kind: 'submit', delivery: undefined });
    });

    it('sends the head of the queue now when Enter lands in an empty composer', () => {
        const running = { ...idle, isBusy: true, isTurnRunning: true, nextQueuedId: 'q1' };
        expect(agentChatComposerKeyAction(press('Enter'), running)).toEqual({
            kind: 'sendQueued',
            id: 'q1',
        });
        expect(agentChatComposerKeyAction(press('Enter', { metaKey: true }), running)).toEqual({
            kind: 'sendQueued',
            id: 'q1',
        });
        expect(agentChatComposerKeyAction(press('Enter'), { ...idle, nextQueuedId: 'q1' })).toEqual(
            { kind: 'sendQueued', id: 'q1' },
        );
        expect(
            agentChatComposerKeyAction(press('Enter', { shiftKey: true }), running),
        ).toBeUndefined();
        expect(agentChatComposerKeyAction(press('Escape'), running)).toEqual({ kind: 'stop' });
    });

    it('does not send the queue on a held Enter that repeats after a message was sent', () => {
        const running = { ...idle, isBusy: true, isTurnRunning: true, nextQueuedId: 'q1' };
        expect(agentChatComposerKeyAction(press('Enter', { repeat: true }), running)).toEqual({
            kind: 'submit',
            delivery: undefined,
        });
    });
});

describe('isAgentChatPlainPasteKey', () => {
    it('matches Cmd+Shift+V and Ctrl+Shift+V whatever case Shift gives the key', () => {
        expect(isAgentChatPlainPasteKey(press('V', { metaKey: true, shiftKey: true }))).toBe(true);
        expect(isAgentChatPlainPasteKey(press('v', { ctrlKey: true, shiftKey: true }))).toBe(true);
    });

    it('leaves an ordinary paste and other chords alone', () => {
        expect(isAgentChatPlainPasteKey(press('v', { metaKey: true }))).toBe(false);
        expect(
            isAgentChatPlainPasteKey(press('V', { metaKey: true, shiftKey: true, altKey: true })),
        ).toBe(false);
        expect(isAgentChatPlainPasteKey(press('V', { shiftKey: true }))).toBe(false);
    });
});

describe('isAgentChatClearKey', () => {
    it('is Ctrl+C alone, never Cmd+C (Copy), another chord, or a key the IME owns', () => {
        expect(isAgentChatClearKey(press('c', { ctrlKey: true }))).toBe(true);
        expect(isAgentChatClearKey(press('C', { ctrlKey: true }))).toBe(true);
        expect(isAgentChatClearKey(press('c', { metaKey: true }))).toBe(false);
        expect(isAgentChatClearKey(press('c', { ctrlKey: true, shiftKey: true }))).toBe(false);
        expect(isAgentChatClearKey(press('c', { ctrlKey: true, altKey: true }))).toBe(false);
        expect(isAgentChatClearKey(press('c', { ctrlKey: true, isComposing: true }))).toBe(false);
        expect(isAgentChatClearKey(press('c'))).toBe(false);
    });
});
