import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatSnapshot, AgentChatTask } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatSessionHost, ChatLifecycleEvent } from '../chat-provider';
import { chatTextDigest } from '../chat-turn-answer';
import { ClaudeTurns } from '../claude-turns';

function backgroundTask(fields: Partial<AgentChatTask> = {}): AgentChatTask {
    return {
        id: 'task-1',
        kind: 'agent',
        title: 'Trace a flow',
        status: 'running',
        isBackground: true,
        canStop: true,
        ...fields,
    };
}

function harness() {
    let snapshot: AgentChatSnapshot = emptyAgentChatSnapshot('terminal-1');
    const events: ChatLifecycleEvent[] = [];
    const host = {
        read: () => snapshot,
        apply: (operations) => {
            snapshot = operations.reduce(applyAgentChatOperation, snapshot);
        },
        lifecycle: (event) => events.push(event),
        onTurnFinished: () => {},
    } as Pick<AgentChatSessionHost, 'apply' | 'lifecycle' | 'onTurnFinished' | 'read'>;
    const turns = new ClaudeTurns({
        host: host as AgentChatSessionHost,
        bindSession: () => 'agent-session',
        sessionId: () => 'agent-session',
        settleRequests: () => {},
    });
    const setTasks = (tasks: AgentChatTask[]) => host.apply([{ op: 'state', state: { tasks } }]);
    return { events, host, setTasks, turns };
}

describe('ClaudeTurns background work', () => {
    it('keeps a successful result completed when it races a user Stop', () => {
        const { host, turns } = harness();
        turns.begin('turn-1');
        turns.requestInterrupt();
        turns.finish({
            subtype: 'success',
            is_error: false,
            result: 'Done',
            modelUsage: {},
        } as SDKResultMessage);
        expect(host.read().turns.at(-1)?.status).toBe('completed');
        expect(host.read().turns.at(-1)).not.toHaveProperty('interruptionReason');
        expect(turns.interruptionReason).toBeUndefined();
    });

    it('reports a finished turn as waiting while a background subagent still runs', () => {
        const { events, setTasks, turns } = harness();
        turns.begin('turn-1');
        setTasks([backgroundTask()]);
        turns.onSessionState('running');
        turns.onSessionState('idle');

        expect(events.at(-1)).toEqual({
            phase: 'turnFinished',
            agentSessionId: 'agent-session',
            agentTurnId: 'turn-1',
            agentBackgroundWork: true,
        });
    });

    it('reports the plain finish once the work drains without a new turn', () => {
        const { events, setTasks, turns } = harness();
        turns.begin('turn-1');
        setTasks([backgroundTask()]);
        turns.onSessionState('running');
        turns.onSessionState('idle');

        turns.onTasksChanged();
        expect(events).toHaveLength(2);

        setTasks([backgroundTask({ status: 'completed' })]);
        turns.onTasksChanged();
        turns.onTasksChanged();
        expect(events.slice(2)).toEqual([
            { phase: 'turnFinished', agentSessionId: 'agent-session', agentTurnId: 'turn-1' },
        ]);
    });

    it('leaves the finish to the resumed turn when Claude Code wakes itself', () => {
        const { events, setTasks, turns } = harness();
        turns.begin('turn-1');
        setTasks([backgroundTask()]);
        turns.onSessionState('running');
        turns.onSessionState('idle');

        turns.onSessionState('running');
        setTasks([backgroundTask({ status: 'completed' })]);
        turns.onTasksChanged();

        expect(events.filter((event) => event.phase === 'turnFinished')).toHaveLength(1);
        expect(events.at(-1)?.phase).toBe('turnStarted');
    });

    it.each([
        ['a background shell', backgroundTask({ kind: 'shell' })],
        ['a foreground subagent', backgroundTask({ isBackground: false })],
    ])('does not wait on %s', (_label, task) => {
        const { events, setTasks, turns } = harness();
        turns.begin('turn-1');
        setTasks([task]);
        turns.onSessionState('running');
        turns.onSessionState('idle');

        expect(events.at(-1)).not.toHaveProperty('agentBackgroundWork');
    });
});

describe('ClaudeTurns delegation digests', () => {
    it('digests the prompt at turn start and the final answer at turn end', () => {
        const { events, host, turns } = harness();
        turns.begin('turn-1', { isOwnPrompt: true, prompt: 'Read the task.' });
        expect(events[0]).toEqual({
            phase: 'turnStarted',
            agentSessionId: 'agent-session',
            agentTurnId: 'turn-1',
            agentPromptDigest: chatTextDigest('Read the task.'),
        });

        host.apply([
            {
                op: 'upsertItem',
                item: {
                    id: 'a-1',
                    type: 'agentMessage',
                    text: 'Draft',
                    turnId: 'turn-1',
                    streaming: false,
                },
            },
            {
                op: 'upsertItem',
                item: {
                    id: 'a-2',
                    type: 'agentMessage',
                    text: 'Answer',
                    turnId: 'turn-1',
                    streaming: false,
                },
            },
        ]);
        turns.onSessionState('running');
        turns.onSessionState('idle');

        expect(events.at(-1)).toEqual({
            phase: 'turnFinished',
            agentSessionId: 'agent-session',
            agentTurnId: 'turn-1',
            agentResponseDigest: chatTextDigest('Answer'),
        });
    });

    it('omits both digests for a turn without a known prompt or answer', () => {
        const { events, turns } = harness();
        turns.begin('turn-1');
        turns.onSessionState('running');
        turns.onSessionState('idle');

        expect(events[0]).not.toHaveProperty('agentPromptDigest');
        expect(events.at(-1)).not.toHaveProperty('agentResponseDigest');
    });
});
