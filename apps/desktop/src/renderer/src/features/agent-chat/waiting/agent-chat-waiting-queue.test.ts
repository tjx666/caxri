import type { AgentChatRequest, AgentChatWaitingChat } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatWaitingQueue,
    agentChatWaitingRequestCount,
    nextAgentChatWaitingArrivals,
    nextAgentChatWaitingView,
} from './agent-chat-waiting-queue';

function approval(id: string): AgentChatRequest {
    return { id, kind: 'command', command: 'make', decisions: ['accept', 'decline'] };
}

function chat(terminalId: string, ...requestIds: string[]): AgentChatWaitingChat {
    return {
        sessionId: `session-${terminalId}`,
        terminalId,
        requests: (requestIds.length > 0 ? requestIds : [`${terminalId}-request`]).map(approval),
    };
}

const everything = {
    answers: {},
    arrivals: new Map<string, number>(),
    isKnownSession: () => true,
    isOnScreen: () => false,
};

describe('nextAgentChatWaitingArrivals', () => {
    it('keeps waiting Chats in place, queues new ones last, and forgets the ones that stopped', () => {
        const first = nextAgentChatWaitingArrivals(new Map(), [chat('a'), chat('b')]);
        expect([...first]).toEqual([
            ['a', 1],
            ['b', 2],
        ]);
        const second = nextAgentChatWaitingArrivals(first, [chat('c'), chat('b')]);
        expect([...second]).toEqual([
            ['c', 3],
            ['b', 2],
        ]);
    });

    it('returns the same map when nothing arrived or left, so the hook settles', () => {
        const arrivals = nextAgentChatWaitingArrivals(new Map(), [chat('a')]);
        expect(nextAgentChatWaitingArrivals(arrivals, [chat('a')])).toBe(arrivals);
    });
});

describe('agentChatWaitingQueue', () => {
    it('asks the oldest arrival first, whatever order Server Core lists them in', () => {
        const queue = agentChatWaitingQueue([chat('new'), chat('old')], {
            ...everything,
            arrivals: new Map([
                ['old', 1],
                ['new', 2],
            ]),
        });
        expect(queue.map((each) => each.terminalId)).toEqual(['old', 'new']);
    });

    it('leaves out a Chat on screen and one whose Session this window does not know', () => {
        const queue = agentChatWaitingQueue([chat('shown'), chat('unknown'), chat('hidden')], {
            ...everything,
            isKnownSession: (sessionId) => sessionId !== 'session-unknown',
            isOnScreen: (terminalId) => terminalId === 'shown',
        });
        expect(queue.map((each) => each.terminalId)).toEqual(['hidden']);
    });

    it('drops a request answered here before Server Core settles it, and the Chat once nothing is left', () => {
        const queue = agentChatWaitingQueue([chat('a', 'r1', 'r2'), chat('b', 'r3')], {
            ...everything,
            answers: {
                a: [{ requestId: 'r1', notice: undefined }],
                b: [{ requestId: 'r3', notice: undefined }],
            },
        });
        expect(queue).toEqual([{ ...chat('a', 'r1', 'r2'), requests: [approval('r2')] }]);
        expect(agentChatWaitingRequestCount(queue)).toBe(1);
    });

    it('counts every request across Chats', () => {
        const queue = agentChatWaitingQueue([chat('a', 'r1', 'r2'), chat('b')], everything);
        expect(agentChatWaitingRequestCount(queue)).toBe(3);
    });
});

describe('nextAgentChatWaitingView', () => {
    it('unfolds a folded popup when another request arrives', () => {
        expect(nextAgentChatWaitingView({ isCollapsed: true, count: 1 }, 2)).toEqual({
            isCollapsed: false,
            count: 2,
        });
    });

    it('stays folded while requests are only answered', () => {
        expect(nextAgentChatWaitingView({ isCollapsed: true, count: 3 }, 2)).toEqual({
            isCollapsed: true,
            count: 2,
        });
    });

    it('resets the fold once nothing waits, and keeps the same view when the count holds', () => {
        expect(nextAgentChatWaitingView({ isCollapsed: true, count: 1 }, 0)).toEqual({
            isCollapsed: false,
            count: 0,
        });
        const view = { isCollapsed: true, count: 2 };
        expect(nextAgentChatWaitingView(view, 2)).toBe(view);
    });
});
