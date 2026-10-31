import { describe, expect, it } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import { fixture } from './chat-service-fixture';

/**
 * Codex and Grok report shell commands only as protocol notifications, so their Chats synthesize the `shellTool*`
 * signals the Workbench Root's worktree attribution pairs (issue caxri#1849).
 */
function shellSignals(signals: readonly AgentLifecycleSignal[]) {
    return signals
        .filter((signal) => signal.phase.startsWith('shellTool'))
        .map(({ phase, agentToolUseId, worktreeCreateIntent }) => ({
            phase,
            ...(agentToolUseId && { agentToolUseId }),
            ...(worktreeCreateIntent && { worktreeCreateIntent }),
        }));
}

describe('Chat shell signals from protocol notifications', () => {
    it('pairs a Codex `git worktree add` and fails the one that exited non-zero', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'codex' });
        await service.send(terminal.id, { text: 'newworktree' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(shellSignals(signals)).toEqual([
            {
                phase: 'shellToolStarted',
                agentToolUseId: 'call_feature',
                worktreeCreateIntent: true,
            },
            {
                phase: 'shellToolFinished',
                agentToolUseId: 'call_feature',
                worktreeCreateIntent: true,
            },
            { phase: 'shellToolStarted', agentToolUseId: 'call_taken', worktreeCreateIntent: true },
            { phase: 'shellToolFailed', agentToolUseId: 'call_taken', worktreeCreateIntent: true },
        ]);
        // Every shell signal belongs to the turn, before it ends.
        const phases = signals.map((signal) => signal.phase);
        expect(phases.lastIndexOf('shellToolFailed')).toBeLessThan(phases.indexOf('turnFinished'));
    });

    it('reports no outcome for a Codex command that outlives its turn', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'codex' });
        await service.send(terminal.id, { text: 'start the background server' });
        const running = await until(
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.tasks?.some((task) => task.status === 'running') === true,
        );
        const task = running.tasks?.find((candidate) => candidate.status === 'running');
        await service.stopTask(terminal.id, task?.id ?? '');
        await until((snapshot) => snapshot.tasks?.some((t) => t.status === 'stopped') === true);
        // A late outcome would read as a running turn to Terminal suspension and delegation.
        expect(shellSignals(signals)).toEqual([{ phase: 'shellToolStarted' }]);
    });

    it.each([
        ['Full access', 'newworktree'],
        ['an accepted approval', 'newworktree approve'],
    ])('pairs a Grok `git worktree add` under %s', async (_label, text) => {
        const { service, terminal, signals, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text });
        if (text.includes('approve')) {
            const pending = await until((snapshot) => snapshot.requests.length === 1);
            // The before-snapshot is requested while the command still waits for its approval.
            expect(shellSignals(signals)).toEqual([
                expect.objectContaining({ phase: 'shellToolStarted', worktreeCreateIntent: true }),
            ]);
            service.respond(terminal.id, pending.requests[0].id, {
                kind: 'decision',
                decision: 'accept',
            });
        }
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        const [started, finished, ...rest] = shellSignals(signals);
        expect(started).toMatchObject({ phase: 'shellToolStarted', worktreeCreateIntent: true });
        expect(finished).toEqual({ ...started, phase: 'shellToolFinished' });
        expect(rest).toEqual([]);
    });

    it('fails a declined Grok `git worktree add`', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'newworktree approve' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'decision',
            decision: 'decline',
        });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(shellSignals(signals).map(({ phase }) => phase)).toEqual([
            'shellToolStarted',
            'shellToolFailed',
        ]);
    });

    it('sends no shell signal while a Grok session/load replays its history', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'newworktree' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        const before = shellSignals(signals).length;
        await service.restart(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');
        expect(shellSignals(signals)).toHaveLength(before);
    });
});
