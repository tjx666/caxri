import type { AgentChatSnapshot, AgentChatTask } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatSessionHost, ChatLifecycleEvent } from '../../../chat-provider';
import { chatTextDigest } from '../../../chat-turn-answer';
import { ClaudeTurns } from '../turns';

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

function harness(longRunning?: readonly string[], commands: Record<string, string> = {}) {
    let snapshot: AgentChatSnapshot = emptyAgentChatSnapshot('terminal-1');
    const events: ChatLifecycleEvent[] = [];
    const host = {
        read: () => snapshot,
        apply: (operations) => {
            snapshot = operations.reduce(applyAgentChatOperation, snapshot);
        },
        lifecycle: (event) => events.push(event),
        onTurnFinished: () => {},
        ...(longRunning && { longRunningShellCommands: () => longRunning }),
    } as Pick<
        AgentChatSessionHost,
        'apply' | 'lifecycle' | 'longRunningShellCommands' | 'onTurnFinished' | 'read'
    >;
    const turns = new ClaudeTurns({
        host: host as AgentChatSessionHost,
        bindSession: () => 'agent-session',
        sessionId: () => 'agent-session',
        settleRequests: () => {},
        shellCommand: (taskId) => commands[taskId],
    });
    const setTasks = (tasks: AgentChatTask[]) => host.apply([{ op: 'state', state: { tasks } }]);
    return { events, host, setTasks, turns };
}

describe('ClaudeTurns background work', () => {
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
        [
            'a background shell whose command is not long-running',
            backgroundTask({ kind: 'shell', title: 'bun run check' }),
            'bun run check',
        ],
        [
            'a described background shell',
            backgroundTask({ kind: 'shell', title: 'Watch CI' }),
            'bun run scripts/watch-ci.ts',
        ],
    ])('waits on %s', (_label, task, command) => {
        const { events, setTasks, turns } = harness(['bun run dev'], { [task.id]: command });
        turns.begin('turn-1');
        setTasks([task]);
        turns.onSessionState('running');
        turns.onSessionState('idle');

        expect(events.at(-1)).toHaveProperty('agentBackgroundWork', true);
    });

    it.each([
        [
            'a background shell without long-running patterns',
            backgroundTask({ kind: 'shell' }),
            undefined,
            'bun run check',
        ],
        [
            'a long-running background shell',
            backgroundTask({ kind: 'shell', title: 'Dev server' }),
            ['bun run dev'],
            'cd web && bun run dev --port 3000',
        ],
        // Only the Agent's description is known, which says nothing about whether the shell ends.
        [
            'a background shell whose command is unknown',
            backgroundTask({ kind: 'shell', title: 'Start the dev server' }),
            ['bun run dev'],
            undefined,
        ],
        [
            'a foreground subagent',
            backgroundTask({ isBackground: false }),
            ['bun run dev'],
            undefined,
        ],
    ])('does not wait on %s', (_label, task, longRunning, command) => {
        const { events, setTasks, turns } = harness(
            longRunning,
            command === undefined ? {} : { [task.id]: command },
        );
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

describe('ClaudeTurns goal', () => {
    const goalSet = {
        type: 'assistant',
        uuid: 'goal',
        local_command_run: { command: 'goal', args: 'Green CI' },
        local_command_source: '<local-command-stdout>Goal set: Green CI</local-command-stdout>',
    };

    it('drops the goal when its turn completes with nothing left to wake Claude Code', () => {
        const { host, turns } = harness();
        turns.begin('turn-1');
        turns.goals.applyFeedback(goalSet);
        expect(host.read().goal).toMatchObject({ objective: 'Green CI', pausable: false });
        turns.onSessionState('running');
        turns.onSessionState('idle');
        expect(host.read().goal).toBeUndefined();
    });

    it('keeps the goal through an interrupt and while background work will wake Claude Code', () => {
        const { host, setTasks, turns } = harness();
        turns.begin('turn-1');
        turns.goals.applyFeedback(goalSet);
        turns.isInterruptRequested = true;
        turns.onSessionState('running');
        turns.onSessionState('idle');
        expect(host.read().goal).toMatchObject({ status: 'active' });

        turns.begin('turn-2');
        setTasks([backgroundTask()]);
        turns.onSessionState('running');
        turns.onSessionState('idle');
        expect(host.read().goal).toMatchObject({ status: 'active' });
    });
});
