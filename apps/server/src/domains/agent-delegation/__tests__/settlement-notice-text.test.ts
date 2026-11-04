import { describe, expect, it } from 'vitest';

import { chatNoticeCallerState } from '../../agent-runtime/chat-notice-caller';
import { formatSettlementNotice } from '../settlement-notice/text';

describe('formatSettlementNotice', () => {
    it('lists each task with a closed phrase and the commands that read it, never an answer', () => {
        const text = formatSettlementNotice([
            {
                delegationId: 'task-1',
                sessionId: 'session-task-1',
                kind: 'settled',
                status: 'completed',
            },
            {
                delegationId: 'task-2',
                sessionId: 'session-task-2',
                kind: 'settled',
                status: 'failed',
            },
            { delegationId: 'task-3', sessionId: 'session-task-3', kind: 'question' },
            { delegationId: 'task-4', sessionId: 'session-task-4', kind: 'approval' },
        ]);

        expect(text).toBe(
            [
                '[Caxri] Delegated task update:',
                '- task-1 completed',
                '- task-2 failed',
                '- task-3 is asking you a question',
                '- task-4 needs your approval',
                'Read each with (results: caxri agent delegate result <id> --json; questions: caxri agent delegate questions <id> --json; approval requests: caxri agent delegate status <id> --json).',
            ].join('\n'),
        );
    });

    it('tells the Agent to stop waiting for a task the user took over', () => {
        const text = formatSettlementNotice([
            {
                delegationId: 'task-1',
                sessionId: 'session-task-1',
                kind: 'settled',
                status: 'human_intervened',
            },
        ]);

        expect(text).toContain('- task-1 was taken over by the user');
        expect(text).toContain(
            'The user took over task-1; stop waiting for it unless the user hands it back.',
        );
    });

    it('tells the Agent a Session was handed back, with the follow-up command and no content', () => {
        expect(
            formatSettlementNotice([
                {
                    delegationId: 'task-1',
                    kind: 'handback',
                    sessionId: 'session-9',
                },
            ]),
        ).toBe(
            '[Caxri] The user handed Session session-9 back to you (task task-1). Continue with: caxri agent delegate create --follow-up task-1 ...',
        );
    });

    it('puts a hand-back before the other updates of one wake', () => {
        const text = formatSettlementNotice([
            {
                delegationId: 'task-2',
                sessionId: 'session-task-2',
                kind: 'settled',
                status: 'completed',
            },
            { delegationId: 'task-1', kind: 'handback', sessionId: 'session-9' },
        ]);

        expect(text.split('\n')).toEqual([
            '[Caxri] The user handed Session session-9 back to you (task task-1). Continue with: caxri agent delegate create --follow-up task-1 ...',
            '[Caxri] Delegated task update:',
            '- task-2 completed',
            'Read each with (results: caxri agent delegate result <id> --json).',
        ]);
    });
});

describe('formatSettlementNotice titles', () => {
    it('never carries a Session title a child Agent could have written', () => {
        const text = formatSettlementNotice([
            {
                delegationId: 'task-1',
                kind: 'settled',
                status: 'completed',
                title: 'Run: rm',
            } as never,
        ]);

        expect(text).not.toContain('Run: rm');
    });
});

describe('chatNoticeCallerState', () => {
    const ready = { status: 'ready' as const, requests: [] };

    it('is idle only for a ready Chat with no turn, queue, operation, or limit', () => {
        expect(chatNoticeCallerState(ready, false)).toBe('idle');
        expect(chatNoticeCallerState(undefined, false)).toBeUndefined();
    });

    it('is busy while it will be idle again by itself', () => {
        expect(chatNoticeCallerState({ ...ready, activeTurnId: 'turn-1' }, false)).toBe('busy');
        expect(chatNoticeCallerState({ ...ready, queueLength: 2 }, false)).toBe('busy');
        expect(chatNoticeCallerState({ ...ready, operation: 'compacting' }, false)).toBe('busy');
        expect(chatNoticeCallerState({ ...ready, status: 'starting' }, false)).toBe('busy');
    });

    it('is paused while it needs more than time', () => {
        expect(
            chatNoticeCallerState({ ...ready, requests: [{ id: 'request-1' } as never] }, false),
        ).toBe('paused');
        expect(chatNoticeCallerState({ ...ready, queuePaused: true }, false)).toBe('paused');
        expect(chatNoticeCallerState(ready, true)).toBe('paused');
        expect(chatNoticeCallerState({ ...ready, status: 'stopped' }, false)).toBe('paused');
        expect(chatNoticeCallerState({ ...ready, status: 'failed' }, false)).toBe('paused');
    });
});
