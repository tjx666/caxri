import { describe, expect, it } from 'vitest';

import type { AgentChatSnapshot } from '../agent-chat-contract.js';
import type { AgentChatPendingMessageBase } from '../agent-chat-pending.js';
import {
    agentChatDraftWithReturnedMessage,
    agentChatPendingKnownIds,
    agentChatPendingPlacement,
    agentChatPendingView,
    isAgentChatPendingAnswerSettled,
    isAgentChatPendingMessageSettled,
    unsettledAgentChatPendingMessages,
} from '../agent-chat-pending.js';

function snapshot(overrides: Partial<AgentChatSnapshot> = {}): AgentChatSnapshot {
    return {
        terminalId: 'terminal-1',
        revision: 1,
        status: 'ready',
        items: [],
        turns: [],
        requests: [],
        tasks: [],
        ...overrides,
    } as AgentChatSnapshot;
}

function pending(
    overrides: Partial<AgentChatPendingMessageBase> = {},
): AgentChatPendingMessageBase {
    return {
        id: 'pending-1',
        text: 'Run the tests',
        placement: 'timeline',
        knownIds: new Set(['old']),
        ...overrides,
    };
}

const question = {
    id: 'request-1',
    kind: 'question' as const,
    questions: [
        { id: 'color', header: 'Color', question: 'Which?', options: [], allowsOther: true },
    ],
};

describe('agentChatPendingPlacement', () => {
    it('lands in the timeline when the message starts or steers a turn', () => {
        expect(agentChatPendingPlacement(snapshot(), undefined, false)).toBe('timeline');
        expect(agentChatPendingPlacement(snapshot({ activeTurnId: 't' }), 'steer', false)).toBe(
            'timeline',
        );
        // A paused queue does not hold a new message back.
        expect(
            agentChatPendingPlacement(
                snapshot({ queue: [{ id: 'q', text: 'x' }], queuePaused: true }),
                undefined,
                false,
            ),
        ).toBe('timeline');
    });

    it('lands in the queue when a turn, a compaction, the queue, or an earlier send holds it', () => {
        expect(agentChatPendingPlacement(snapshot({ activeTurnId: 't' }), undefined, false)).toBe(
            'queue',
        );
        expect(
            agentChatPendingPlacement(snapshot({ operation: 'compacting' }), 'steer', false),
        ).toBe('queue');
        expect(
            agentChatPendingPlacement(
                snapshot({ queue: [{ id: 'q', text: 'x' }] }),
                undefined,
                false,
            ),
        ).toBe('queue');
        expect(agentChatPendingPlacement(snapshot(), undefined, true)).toBe('queue');
    });
});

describe('agentChatPendingKnownIds', () => {
    it('collects the user messages and queue entries already shown', () => {
        expect(
            agentChatPendingKnownIds(
                snapshot({
                    items: [
                        { id: 'u', type: 'userMessage', text: 'a' },
                        { id: 'a', type: 'agentMessage', text: 'b', streaming: false },
                    ],
                    queue: [{ id: 'q', text: 'c' }],
                }),
            ),
        ).toEqual(new Set(['u', 'q']));
    });
});

describe('isAgentChatPendingMessageSettled', () => {
    it('settles on a new user message or queue entry that carries its text', () => {
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({ items: [{ id: 'new', type: 'userMessage', text: 'Run the  tests\n' }] }),
            ),
        ).toBe(true);
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({ queue: [{ id: 'new', text: 'Run the tests' }] }),
            ),
        ).toBe(true);
        // The queue joined it with the message before it.
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({
                    items: [{ id: 'new', type: 'userMessage', text: 'First\n\nRun the tests' }],
                }),
            ),
        ).toBe(true);
    });

    it('settles on a bounded copy that kept only the tail or head of a long message', () => {
        const long = `${'start '.repeat(100)}${'middle '.repeat(700)}${'end '.repeat(100)}`;
        const tail = `…${long.slice(-4_000)}`;
        const head = `${long.slice(0, 200)}…`;
        expect(
            isAgentChatPendingMessageSettled(
                pending({ text: long }),
                snapshot({
                    items: [{ id: 'new', type: 'userMessage', text: tail }],
                }),
            ),
        ).toBe(true);
        expect(
            isAgentChatPendingMessageSettled(
                pending({ text: long }),
                snapshot({ queue: [{ id: 'new', text: head }] }),
            ),
        ).toBe(true);
        // A short clipped text is too little to identify the message.
        expect(
            isAgentChatPendingMessageSettled(
                pending({ text: 'ok, go ahead' }),
                snapshot({ queue: [{ id: 'new', text: 'ok…' }] }),
            ),
        ).toBe(false);
    });

    it('stays pending while only an earlier message or another text shows', () => {
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({ items: [{ id: 'old', type: 'userMessage', text: 'Run the tests' }] }),
            ),
        ).toBe(false);
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({ items: [{ id: 'new', type: 'userMessage', text: 'Something else' }] }),
            ),
        ).toBe(false);
        expect(isAgentChatPendingMessageSettled(pending(), undefined)).toBe(false);
    });
});

describe('isAgentChatPendingAnswerSettled', () => {
    it('settles once the request leaves or its answer record arrives', () => {
        const answer = {
            requestId: 'request-1',
            notice: { id: 'answer:request-1', type: 'notice', kind: 'answered' } as const,
        };
        expect(isAgentChatPendingAnswerSettled(answer, snapshot({ requests: [question] }))).toBe(
            false,
        );
        expect(isAgentChatPendingAnswerSettled(answer, snapshot())).toBe(true);
        expect(
            isAgentChatPendingAnswerSettled(
                answer,
                snapshot({ requests: [question], items: [answer.notice] }),
            ),
        ).toBe(true);
    });
});

describe('agentChatPendingView', () => {
    it('splits unsettled messages by placement and hides answered requests', () => {
        const messages = [
            pending({ id: 'a', text: 'Shown already' }),
            pending({ id: 'b', text: 'On its way' }),
            pending({ id: 'c', text: 'Waiting', placement: 'queue' }),
        ];
        const notice = { id: 'answer:request-1', type: 'notice', kind: 'answered' } as const;
        const view = agentChatPendingView(
            messages,
            [{ requestId: 'request-1', notice }],
            snapshot({
                requests: [question],
                items: [{ id: 'new', type: 'userMessage', text: 'Shown already' }],
            }),
        );
        expect(view.timeline.map((message) => message.id)).toEqual(['b']);
        expect(view.queue.map((message) => message.id)).toEqual(['c']);
        expect(view.notices).toEqual([notice]);
        expect(view.answeredRequestIds).toEqual(new Set(['request-1']));
    });

    it('keeps the same array when nothing settled', () => {
        const messages = [pending()];
        expect(unsettledAgentChatPendingMessages(messages, snapshot())).toBe(messages);
    });
});

describe('agentChatDraftWithReturnedMessage', () => {
    it('puts the returned message ahead of anything typed since', () => {
        expect(agentChatDraftWithReturnedMessage('', 'queued')).toBe('queued');
        expect(agentChatDraftWithReturnedMessage('  ', 'queued')).toBe('queued');
        expect(agentChatDraftWithReturnedMessage('typed', 'queued')).toBe('queued\ntyped');
    });
});
