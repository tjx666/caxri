import { describe, expect, it } from 'vitest';

import type { AgentChatFailureReason } from '../agent-chat-contract.js';
import {
    agentChatFailureMessage,
    agentChatQuestionAnswers,
    sentenceStartProvider,
} from '../agent-chat-presentation.js';
import type { AgentChatRequest } from '../agent-chat-requests.js';

describe('agentChatFailureMessage', () => {
    it('keeps the Desktop copy, which names the next step on the same machine', () => {
        const desktop = (reason: AgentChatFailureReason) =>
            agentChatFailureMessage(reason, { providerName: 'Codex', surface: 'desktop' });
        expect(desktop('executable_not_found')).toBe(
            'Codex is not installed or is not on your PATH. Install it, then retry.',
        );
        expect(desktop('spawn_failed')).toBe(
            'Codex could not be started. Retry, or check that the Codex CLI runs in a terminal.',
        );
        expect(desktop('handshake_failed')).toBe(
            'Codex started but did not respond. Retry, or update the Codex CLI.',
        );
        expect(desktop('process_exited')).toBe(
            'Codex stopped unexpectedly. Retry to resume the conversation.',
        );
        expect(desktop('resume_failed')).toBe('The previous conversation could not be resumed.');
        expect(desktop('conversation_in_use')).toBe(
            'This conversation is open in another Codex app or window. Close it there, then retry.',
        );
        expect(desktop('unsupported_version')).toBe(
            'This Codex version does not support Chat. Update the Codex CLI.',
        );
    });

    it('keeps the phone copy, which places the provider on the computer', () => {
        const mobile = (reason: AgentChatFailureReason) =>
            agentChatFailureMessage(reason, { providerName: 'Codex', surface: 'mobile' });
        expect(mobile('executable_not_found')).toBe(
            "Codex is not installed or is not on your computer's PATH. Install it on your computer.",
        );
        expect(mobile('spawn_failed')).toBe('Codex could not be started on your computer.');
        expect(mobile('handshake_failed')).toBe('Codex started but did not respond.');
        expect(mobile('process_exited')).toBe(
            'Codex stopped unexpectedly. Retry to resume the conversation.',
        );
        expect(mobile('resume_failed')).toBe('The previous conversation could not be resumed.');
        expect(mobile('conversation_in_use')).toBe(
            'This conversation is open in another Codex app or window on your computer.',
        );
        expect(mobile('unsupported_version')).toBe(
            'This Codex version does not support Chat. Update it on your computer.',
        );
    });

    it('asks only a phone that can retry to retry a stopped provider', () => {
        expect(
            agentChatFailureMessage('process_exited', {
                canRetry: false,
                providerName: 'Claude',
                surface: 'mobile',
            }),
        ).toBe('Claude stopped unexpectedly. Reply access is required to retry.');
        expect(
            agentChatFailureMessage('process_exited', {
                canRetry: false,
                providerName: 'Claude',
                surface: 'desktop',
            }),
        ).toBe('Claude stopped unexpectedly. Retry to resume the conversation.');
    });

    it('starts a phone sentence with a capital when the provider falls back to the Agent', () => {
        expect(sentenceStartProvider('the Agent')).toBe('The Agent');
        expect(sentenceStartProvider('Codex')).toBe('Codex');
        expect(
            agentChatFailureMessage('spawn_failed', {
                providerName: 'the Agent',
                surface: 'mobile',
            }),
        ).toBe('The Agent could not be started on your computer.');
    });
});

describe('agentChatQuestionAnswers', () => {
    const request: Extract<AgentChatRequest, { kind: 'question' }> = {
        id: 'q',
        kind: 'question',
        questions: [
            {
                id: 'a',
                header: 'Pick',
                question: 'Which?',
                options: [{ label: 'One', description: '' }],
                allowsOther: true,
            },
            { id: 'b', header: 'Reason', question: 'Why?', options: [], allowsOther: true },
        ],
    };

    it('reports a question left unanswered as incomplete and omits it', () => {
        expect(
            agentChatQuestionAnswers(request, { a: 'One', b: undefined }, { b: ' '.repeat(3) }),
        ).toEqual({
            answers: { a: ['One'] },
            isComplete: false,
        });
    });

    it('prefers typed Other text over a chosen option', () => {
        expect(
            agentChatQuestionAnswers(request, { a: 'One' }, { a: ' Two ', b: 'Because' }),
        ).toEqual({ answers: { a: ['Two'], b: ['Because'] }, isComplete: true });
    });

    it('ignores a selection for a question the request does not ask', () => {
        expect(
            agentChatQuestionAnswers(request, { a: 'One', stale: 'Old' }, { b: 'Why not' }),
        ).toEqual({ answers: { a: ['One'], b: ['Why not'] }, isComplete: true });
    });
});
