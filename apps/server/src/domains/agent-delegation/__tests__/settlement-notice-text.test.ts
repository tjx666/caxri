import { describe, expect, it } from 'vitest';

import { chatNoticeCallerState } from '../../agent-runtime/chat-notice-caller';
import { formatSettlementNotice, sanitizeNoticeTitle } from '../settlement-notice/text';

describe('formatSettlementNotice', () => {
    it('lists each task with a closed phrase and the commands that read it, never an answer', () => {
        const text = formatSettlementNotice([
            { delegationId: 'task-1', kind: 'settled', status: 'completed', title: 'Fix build' },
            { delegationId: 'task-2', kind: 'settled', status: 'failed' },
            { delegationId: 'task-3', kind: 'question' },
            { delegationId: 'task-4', kind: 'approval' },
        ]);

        expect(text).toBe(
            [
                '[Caxri] Delegated task update:',
                '- task-1 "Fix build" completed',
                '- task-2 failed',
                '- task-3 is asking you a question',
                '- task-4 needs your approval',
                'Read each with (results: caxri agent delegate result <id> --json; questions: caxri agent delegate questions <id> --json; approval requests: caxri agent delegate status <id> --json).',
            ].join('\n'),
        );
    });

    it('tells the Agent to stop waiting for a task the user took over', () => {
        const text = formatSettlementNotice([
            { delegationId: 'task-1', kind: 'settled', status: 'human_intervened' },
        ]);

        expect(text).toContain('- task-1 was taken over by the user');
        expect(text).toContain(
            'The user took over task-1; stop waiting for it unless the user hands it back.',
        );
    });
});

describe('sanitizeNoticeTitle', () => {
    it('makes a title one quotable line that cannot close its own quotation', () => {
        expect(sanitizeNoticeTitle('a "b"\n\tc\u{7}  d')).toBe("a 'b' c d");
        expect(sanitizeNoticeTitle(undefined)).toBe('');
        expect(sanitizeNoticeTitle('x'.repeat(200))).toHaveLength(80);
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
