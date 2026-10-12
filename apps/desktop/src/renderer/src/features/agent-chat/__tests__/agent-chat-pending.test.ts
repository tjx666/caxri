import type { AgentChatSnapshot } from '@caxri/protocol';
import { MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentChatPendingMessage } from '../agent-chat-pending';
import {
    addAgentChatPendingAnswer,
    AGENT_CHAT_PENDING_ACCEPTED_TTL_MS,
    agentChatPendingPlacement,
    expireAgentChatPendingMessage,
    isAgentChatPendingAnswerSettled,
    pruneAgentChatPending,
    selectAgentChatPendingAnswers,
    selectAgentChatPendingMessages,
    settledAgentChatPendingMessages,
    showAgentChatPendingMessage,
    useAgentChatPendingStore,
} from '../agent-chat-pending';

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

function pending(overrides: Partial<AgentChatPendingMessage> = {}): AgentChatPendingMessage {
    return {
        id: 'pending-1',
        text: 'Run the tests',
        images: [],
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

afterEach(() => {
    useAgentChatPendingStore.setState({ messages: {}, answers: {} });
    vi.useRealTimers();
});

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

function isSettled(message: AgentChatPendingMessage, current: AgentChatSnapshot | undefined) {
    return settledAgentChatPendingMessages([message], current).has(message.id);
}

describe('settledAgentChatPendingMessages', () => {
    it('settles on a new user message or queue entry that carries its text', () => {
        expect(
            isSettled(
                pending(),
                snapshot({ items: [{ id: 'new', type: 'userMessage', text: 'Run the  tests\n' }] }),
            ),
        ).toBe(true);
        expect(
            isSettled(pending(), snapshot({ queue: [{ id: 'new', text: 'Run the tests' }] })),
        ).toBe(true);
        // The queue joined it with the message before it.
        expect(
            isSettled(
                pending(),
                snapshot({
                    items: [{ id: 'new', type: 'userMessage', text: 'First\n\nRun the tests' }],
                }),
            ),
        ).toBe(true);
    });

    it('stays pending while only an earlier message or another text shows', () => {
        expect(
            isSettled(
                pending(),
                snapshot({ items: [{ id: 'old', type: 'userMessage', text: 'Run the tests' }] }),
            ),
        ).toBe(false);
        expect(
            isSettled(
                pending(),
                snapshot({ items: [{ id: 'new', type: 'userMessage', text: 'Something else' }] }),
            ),
        ).toBe(false);
        expect(isSettled(pending(), undefined)).toBe(false);
    });
});

describe('pending messages pair one to one with what the projection shows', () => {
    const select = selectAgentChatPendingMessages('terminal-1');
    const shownTexts = (current: AgentChatSnapshot) =>
        settledAgentChatPendingMessages(select(useAgentChatPendingStore.getState()), current);
    function send(
        text: string,
        images: ReadonlyArray<{ thumbnail: string }> = [],
        current: AgentChatSnapshot = snapshot(),
    ) {
        return showAgentChatPendingMessage('terminal-1', current, {
            text,
            images,
            delivery: undefined,
        });
    }

    it('keeps a later message pending while only an earlier one that contains its text shows', () => {
        const first = send('please look');
        const second = send('ok');
        const firstShown = snapshot({
            items: [{ id: 'u1', type: 'userMessage', text: 'please look' }],
        });
        expect([...shownTexts(firstShown)]).toEqual([first]);
        // Pruning the first must not let the second claim the message the first already took.
        pruneAgentChatPending('terminal-1', firstShown);
        expect(select(useAgentChatPendingStore.getState()).map((message) => message.id)).toEqual([
            second,
        ]);
        expect(shownTexts(firstShown).size).toBe(0);
        const bothShown = snapshot({
            items: [
                { id: 'u1', type: 'userMessage', text: 'please look' },
                { id: 'u2', type: 'userMessage', text: 'ok' },
            ],
        });
        expect([...shownTexts(bothShown)]).toEqual([second]);
    });

    it('pairs an image-only message with a new entry carrying its images, never with any text', () => {
        const thumbnail = { thumbnail: 'data:image/png;base64,AA==' };
        const imageOnly = send('', [thumbnail, thumbnail]);
        expect(
            shownTexts(snapshot({ items: [{ id: 'u1', type: 'userMessage', text: 'hello' }] }))
                .size,
        ).toBe(0);
        expect(shownTexts(snapshot({ queue: [{ id: 'q1', text: '', imageCount: 1 }] })).size).toBe(
            0,
        );
        expect([
            ...shownTexts(snapshot({ queue: [{ id: 'q1', text: '', imageCount: 2 }] })),
        ]).toEqual([imageOnly]);
        expect([
            ...shownTexts(
                snapshot({
                    items: [{ id: 'u1', type: 'userMessage', text: '', images: [{}, {}] }],
                }),
            ),
        ]).toEqual([imageOnly]);
    });

    it('clears only one of two identical messages when the first arrives', () => {
        const first = send('continue');
        const second = send('continue');
        const one = snapshot({ items: [{ id: 'u1', type: 'userMessage', text: 'continue' }] });
        expect([...shownTexts(one)]).toEqual([first]);
        pruneAgentChatPending('terminal-1', one);
        expect(shownTexts(one).size).toBe(0);
        // Queued back to back, both can arrive joined in one message.
        expect([
            ...shownTexts(
                snapshot({
                    items: [
                        { id: 'u1', type: 'userMessage', text: 'continue' },
                        { id: 'u2', type: 'userMessage', text: 'continue\n\ncontinue' },
                    ],
                }),
            ),
        ]).toEqual([second]);
    });

    it('settles a joined message cut off at the timeline text bound', () => {
        const long = 'a'.repeat(MAX_AGENT_CHAT_TEXT_LENGTH - 10);
        // Only queued messages are joined, so all three wait behind a running turn.
        const first = send(long, [], snapshot({ activeTurnId: 't' }));
        const cut = send('the tail starts here and runs past the bound');
        const gone = send('sent before the dispatch, wholly past the bound');
        const joined = `${long}\n\nthe tail starts here and runs past the bound\n\nsent before the dispatch, wholly past the bound`;
        const shown = snapshot({
            items: [
                {
                    id: 'u1',
                    type: 'userMessage',
                    text: joined.slice(0, MAX_AGENT_CHAT_TEXT_LENGTH),
                },
            ],
        });
        expect([...shownTexts(shown)]).toEqual([first, cut, gone]);
    });

    it('keeps a later message pending when a clipped entry ends with an earlier message', () => {
        // A message long enough to be clipped starts its own turn; nothing can be joined to it.
        const long = send('a'.repeat(MAX_AGENT_CHAT_TEXT_LENGTH + 10));
        const later = send('ok');
        const shown = snapshot({
            activeTurnId: 't',
            items: [
                {
                    id: 'u1',
                    type: 'userMessage',
                    text: 'a'.repeat(MAX_AGENT_CHAT_TEXT_LENGTH),
                },
            ],
        });
        expect([...shownTexts(shown)]).toEqual([long]);
        pruneAgentChatPending('terminal-1', shown);
        expect(shownTexts(shown).size).toBe(0);
        // Shown on its own, it settles there.
        expect([...shownTexts(snapshot({ ...shown, queue: [{ id: 'q1', text: 'ok' }] }))]).toEqual([
            later,
        ]);
    });

    it('prefers an entry showing a queued message over the cut tail of a clipped one', () => {
        const long = 'a'.repeat(MAX_AGENT_CHAT_TEXT_LENGTH - 10);
        const busy = snapshot({ activeTurnId: 't' });
        const first = send(`${long} the tail runs past the bound`, [], busy);
        const second = send('queued after the dispatch');
        send('still on its way');
        const shown = snapshot({
            activeTurnId: 't2',
            items: [
                {
                    id: 'u1',
                    type: 'userMessage',
                    text: `${long} the tail runs past the bound`.slice(
                        0,
                        MAX_AGENT_CHAT_TEXT_LENGTH,
                    ),
                },
            ],
            queue: [{ id: 'q1', text: 'queued after the dispatch' }],
        });
        // The message still on its way did not follow the cut one into the clipped entry.
        expect([...shownTexts(shown)]).toEqual([first, second]);
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

describe('pending store', () => {
    it('queues a message sent behind one still on its way, and prunes each once shown', () => {
        const idle = snapshot();
        showAgentChatPendingMessage('terminal-1', idle, {
            text: 'First',
            images: [],
            delivery: undefined,
        });
        showAgentChatPendingMessage('terminal-1', idle, {
            text: 'Second',
            images: [],
            delivery: undefined,
        });
        const select = selectAgentChatPendingMessages('terminal-1');
        expect(
            select(useAgentChatPendingStore.getState()).map((message) => message.placement),
        ).toEqual(['timeline', 'queue']);

        pruneAgentChatPending(
            'terminal-1',
            snapshot({
                activeTurnId: 't',
                items: [{ id: 'u1', type: 'userMessage', text: 'First' }],
            }),
        );
        expect(select(useAgentChatPendingStore.getState()).map((message) => message.text)).toEqual([
            'Second',
        ]);
    });

    it('drops an accepted message the projection never matched, after its bound', () => {
        vi.useFakeTimers();
        const id = showAgentChatPendingMessage('terminal-1', snapshot(), {
            text: 'Rewritten by the provider',
            images: [],
            delivery: undefined,
        });
        expireAgentChatPendingMessage('terminal-1', id);
        vi.advanceTimersByTime(AGENT_CHAT_PENDING_ACCEPTED_TTL_MS);
        expect(
            selectAgentChatPendingMessages('terminal-1')(useAgentChatPendingStore.getState()),
        ).toEqual([]);
    });

    it('keeps one pending answer per request and prunes it once settled', () => {
        addAgentChatPendingAnswer('terminal-1', { requestId: 'request-1', notice: undefined });
        addAgentChatPendingAnswer('terminal-1', { requestId: 'request-1', notice: undefined });
        const select = selectAgentChatPendingAnswers('terminal-1');
        expect(select(useAgentChatPendingStore.getState())).toHaveLength(1);
        pruneAgentChatPending('terminal-1', snapshot({ requests: [question] }));
        expect(select(useAgentChatPendingStore.getState())).toHaveLength(1);
        pruneAgentChatPending('terminal-1', snapshot());
        expect(select(useAgentChatPendingStore.getState())).toEqual([]);
    });
});
