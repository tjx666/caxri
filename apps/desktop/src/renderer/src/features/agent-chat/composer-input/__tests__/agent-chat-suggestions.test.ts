import type { AgentAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatSelectionCaret,
    agentChatSessionPreparingText,
    agentChatSessionSuggestions,
    agentChatSuggestionFooter,
    isAgentChatCaretKey,
    isAgentChatCaretKeyRelease,
} from '../agent-chat-suggestions';

describe('agentChatSessionSuggestions', () => {
    it('names each Project, and adds when it was opened only to titles that repeat', () => {
        const suggestions = agentChatSessionSuggestions(
            [
                { sessionId: 'a', title: 'Fix login', projectTitle: 'web' },
                { sessionId: 'b', title: 'fix login', projectTitle: 'web' },
                { sessionId: 'c', title: 'Release', projectTitle: undefined },
            ],
            new Map([
                ['a', 100],
                ['b', 200],
                ['c', 300],
            ]),
        );
        expect(suggestions).toEqual([
            {
                key: 'session-a',
                label: 'Fix login',
                isLabelLiteral: false,
                description: 'web',
                openedAt: 100,
            },
            {
                key: 'session-b',
                label: 'fix login',
                isLabelLiteral: false,
                description: 'web',
                openedAt: 200,
            },
            { key: 'session-c', label: 'Release', isLabelLiteral: false },
        ]);
    });
});

describe('Agent Chat suggestion list copy', () => {
    it('names Escape in every footer and Enter only when a row can be chosen', () => {
        const keycaps = (hints: ReadonlyArray<{ action: string; keys: string }>) =>
            hints.map(({ action, keys }) => `${keys} ${action}`).join(' · ');
        expect(keycaps(agentChatSuggestionFooter('commands', true))).toBe(
            '↑↓ to move · Tab to complete · Enter to run · Esc to dismiss',
        );
        expect(keycaps(agentChatSuggestionFooter('sessions', true))).toBe(
            '↑↓ to move · Enter to cite · Esc to dismiss',
        );
        expect(keycaps(agentChatSuggestionFooter('history', true))).toBe(
            '↑↓ to move · Enter to fill · Esc to dismiss',
        );
        for (const list of ['commands', 'history', 'sessions'] as const)
            expect(keycaps(agentChatSuggestionFooter(list, false))).toBe('Esc to dismiss');
    });

    it('says Enter runs every command and skill, and inserts only /goal', () => {
        const action = (
            kind: 'command' | 'skill',
            invocation: string,
            argumentHint?: string,
        ): AgentAction => ({
            invocation,
            kind,
            requiresArguments: false,
            source: 'builtIn',
            ...(argumentHint && { argumentHint }),
        });
        const enter = (highlighted: AgentAction) =>
            agentChatSuggestionFooter('commands', true, highlighted).find(
                ({ keys }) => keys === 'Enter',
            )?.action;
        expect(enter(action('command', '/clear'))).toBe('to run');
        expect(enter(action('command', '/model', '<name>'))).toBe('to run');
        expect(enter(action('skill', '$review'))).toBe('to run');
        expect(enter(action('command', '/goal', '<objective>'))).toBe('to insert');
    });

    it('names the Session whose reference is being prepared', () => {
        expect(agentChatSessionPreparingText('Fix login')).toBe('Preparing “Fix login”…');
    });
});

describe('agentChatSelectionCaret', () => {
    it('ignores the selection focus reports on a restored draft until the user touches it', () => {
        expect(agentChatSelectionCaret(undefined, 8)).toBeUndefined();
    });

    it('follows every selection once the user has edited the draft or moved the caret', () => {
        expect(agentChatSelectionCaret(8, 3)).toBe(3);
        expect(agentChatSelectionCaret(0, 8)).toBe(8);
    });
});

describe('isAgentChatCaretKey', () => {
    const plain = { altKey: false, ctrlKey: false, metaKey: false };

    it('counts a caret key pressed without Command, Control, or Option', () => {
        expect(isAgentChatCaretKey({ ...plain, key: 'ArrowLeft' })).toBe(true);
        expect(isAgentChatCaretKey({ ...plain, key: 'End' })).toBe(true);
    });

    it('ignores other keys and the chords that switch Sessions', () => {
        expect(isAgentChatCaretKey({ ...plain, key: 'Escape' })).toBe(false);
        expect(
            isAgentChatCaretKey({ ...plain, key: 'ArrowLeft', ctrlKey: true, altKey: true }),
        ).toBe(false);
        expect(isAgentChatCaretKey({ ...plain, key: 'ArrowRight', metaKey: true })).toBe(false);
    });
});

describe('isAgentChatCaretKeyRelease', () => {
    const plain = { altKey: false, ctrlKey: false, metaKey: false };

    it('accepts the release of the caret key the composer saw pressed', () => {
        expect(isAgentChatCaretKeyRelease('ArrowLeft', { ...plain, key: 'ArrowLeft' })).toBe(true);
    });

    it('ignores an arrow whose press the composer never saw, as after a Session switch chord', () => {
        // Option and Control came up first, so only the bare arrow is released over the newly focused composer.
        expect(isAgentChatCaretKeyRelease(undefined, { ...plain, key: 'ArrowLeft' })).toBe(false);
        expect(isAgentChatCaretKeyRelease('ArrowRight', { ...plain, key: 'ArrowLeft' })).toBe(
            false,
        );
    });

    it('ignores a release that still carries a modifier', () => {
        expect(
            isAgentChatCaretKeyRelease('ArrowLeft', { ...plain, key: 'ArrowLeft', metaKey: true }),
        ).toBe(false);
    });
});
