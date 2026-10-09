import type { AgentChatSnapshot } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatActivityTitle,
    agentChatQuestionAnswers,
    canSendAgentChatMessage,
    isAgentChatSubmitKey,
} from './agent-chat-presentation';

function snapshot(status: AgentChatSnapshot['status']): AgentChatSnapshot {
    return { ...emptyAgentChatSnapshot('terminal-1'), status };
}

describe('canSendAgentChatMessage', () => {
    it('accepts a message while ready, stopped (which resumes), or still starting (which queues)', () => {
        expect(canSendAgentChatMessage(snapshot('ready'))).toBe(true);
        expect(canSendAgentChatMessage(snapshot('stopped'))).toBe(true);
        expect(canSendAgentChatMessage(snapshot('starting'))).toBe(true);
    });

    it('refuses once the provider has failed or before anything is loaded', () => {
        expect(canSendAgentChatMessage(snapshot('failed'))).toBe(false);
        expect(canSendAgentChatMessage(undefined)).toBe(false);
    });
});

describe('isAgentChatSubmitKey', () => {
    it('sends on Enter only', () => {
        expect(isAgentChatSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(
            true,
        );
        expect(isAgentChatSubmitKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(
            false,
        );
    });

    it('leaves Enter to an IME composition', () => {
        expect(isAgentChatSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(
            false,
        );
    });
});

describe('agentChatActivityTitle', () => {
    it('names the first changed file and counts the rest', () => {
        expect(
            agentChatActivityTitle({
                id: 'f',
                type: 'fileChange',
                status: 'completed',
                changes: [
                    { path: 'a.ts', kind: 'update', diff: '' },
                    { path: 'b.ts', kind: 'add', diff: '' },
                ],
            }),
        ).toBe('a.ts and 1 more');
    });

    it('joins a tool name with its summary', () => {
        expect(
            agentChatActivityTitle({
                id: 't',
                type: 'toolCall',
                name: 'webSearch',
                status: 'running',
                summary: 'zod v4',
            }),
        ).toBe('webSearch: zod v4');
    });
});

describe('agentChatQuestionAnswers', () => {
    it('prefers typed Other text over a chosen option and omits unanswered questions', () => {
        expect(
            agentChatQuestionAnswers(
                { q1: 'Yes', q2: 'No', q3: undefined },
                { q2: '  Later  ', q4: ' '.repeat(3) },
            ),
        ).toEqual({ q1: ['Yes'], q2: ['Later'] });
    });
});
