import type { AgentChatTaskSnapshot } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { CodexTaskRequests } from '../codex-task-requests';
import { CodexTasks } from '../codex-tasks';

describe('Codex child request ownership', () => {
    it('ignores the parent wait and requests that do not block the child', () => {
        let snapshot = emptyAgentChatSnapshot('terminal');
        const details = new Map<string, AgentChatTaskSnapshot>();
        const tasks = new CodexTasks(
            {
                read: () => snapshot,
                apply: (operations) => {
                    snapshot = operations.reduce(applyAgentChatOperation, snapshot);
                },
                readTask: (id) => details.get(id),
                applyTask: () => {},
            },
            { threadId: () => 'parent', request: () => Promise.resolve({}) },
        );
        tasks.onThreadStarted({ id: 'child', parentThreadId: 'parent' });
        tasks.onChildNotification('child', 'turn/started', { turn: { id: 'child-turn' } });
        tasks.onAgentItem({
            id: 'wait-item',
            type: 'collabAgentToolCall',
            tool: 'wait',
            status: 'inProgress',
            senderThreadId: 'parent',
            receiverThreadIds: ['child'],
            agentsStates: { child: { status: 'running' } },
        });
        expect(snapshot.tasks?.[0]?.status).toBe('running');
        tasks.onRequestPending('parent', 'main-request', 'parent-turn', true);
        tasks.onRequestPending('child', 'optional-question', 'child-turn', false);
        expect(snapshot.tasks?.[0]?.status).toBe('running');
    });

    it('waits for every blocking request of the child, independently of other children', () => {
        const waits = new CodexTaskRequests(() => {});
        waits.open('first', 'child-a', 'turn-a');
        waits.open('second', 'child-a', 'turn-a');
        waits.open('other', 'child-b', 'turn-b');
        waits.resolve('first');
        expect(waits.isWaiting('child-a')).toBe(true);
        waits.resolve('second');
        expect(waits.isWaiting('child-a')).toBe(false);
        expect(waits.isWaiting('child-b')).toBe(true);
    });

    it('does not clear a newer turn when an older child turn finishes late', () => {
        const waits = new CodexTaskRequests(() => {});
        waits.open('old', 'child', 'old-turn');
        waits.open('new', 'child', 'new-turn');
        waits.clearTurn('child', 'old-turn');
        waits.resolve('old');
        expect(waits.isWaiting('child')).toBe(true);
        waits.clearTurn('child', 'new-turn');
        expect(waits.isWaiting('child')).toBe(false);
    });
});
