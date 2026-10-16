import type { AgentChatSnapshot, AgentChatTask } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { fixture } from './chat-service-fixture';

function agentTask(snapshot: AgentChatSnapshot): AgentChatTask | undefined {
    return snapshot.tasks?.find((task) => task.kind === 'agent');
}

function shellTask(snapshot: AgentChatSnapshot): AgentChatTask | undefined {
    return snapshot.tasks?.find((task) => task.kind === 'shell');
}

function itemTexts(items: AgentChatSnapshot['items']): string[] {
    return items.flatMap((item) =>
        item.type === 'userMessage' || item.type === 'agentMessage' ? [item.text] : [],
    );
}

describe('Codex Chat background work with a fake app-server', () => {
    it('marks a child waiting on its own approval and resumes only after resolution', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'use a subagent with child approval' });
        const pending = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.requests.length > 0,
        );
        expect(agentTask(pending)).toMatchObject({ status: 'waiting', canStop: true });
        expect(agentTask(pending)).not.toHaveProperty('endedAt');
        await service.send(terminal.id, { text: 'Example parent input' });
        const parentDone = await until(
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.turns.at(-1)?.status === 'completed' &&
                snapshot.turns.at(-1)?.id !== pending.turns.at(-1)?.id,
        );
        expect(agentTask(parentDone)?.status).toBe('waiting');
        expect(parentDone.requests).toHaveLength(1);
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'decision',
            decision: 'accept',
        });
        const resumed = await until(
            (snapshot) =>
                agentTask(snapshot)?.status === 'running' && snapshot.requests.length === 0,
        );
        expect(agentTask(resumed)).not.toHaveProperty('endedAt');
        const done = await until((snapshot) => agentTask(snapshot)?.status === 'completed');
        expect(agentTask(done)?.canStop).toBe(false);
    });

    it('clears a stopped child turn approval without waiting for a separate resolved event', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'use a subagent with child approval' });
        const pending = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.requests.length > 0,
        );
        await service.stopTask(terminal.id, agentTask(pending)?.id ?? '');
        const stopped = await until((snapshot) => agentTask(snapshot)?.status === 'stopped');
        expect(stopped.requests).toEqual([]);
    });

    it('projects a subagent thread into its own task, not the parent timeline', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'use a subagent' });
        const done = await until(
            (snapshot) => !snapshot.activeTurnId && agentTask(snapshot)?.status === 'completed',
        );
        const task = agentTask(done);
        expect(task).toMatchObject({
            title: 'Inspect the fixtures',
            model: 'fake-codex-mini',
            isBackground: true,
            canStop: false,
            summary: 'Found one sample file.',
        });
        const spawn = done.items.find(
            (item) => item.type === 'toolCall' && item.name === 'spawnAgent',
        );
        expect(spawn).toMatchObject({ status: 'completed' });
        expect(spawn?.type === 'toolCall' && spawn.summary).toContain('Inspect');
        expect(task?.itemId).toBe(spawn?.id);
        expect(done.items).toContainEqual(
            expect.objectContaining({
                type: 'toolCall',
                name: 'wait',
                output: 'Found one sample file.',
            }),
        );
        expect(itemTexts(done.items)).toEqual(['use a subagent', 'The helper finished.']);

        // Events the child sent before the spawn named it were held, not lost.
        const child = await service.readTask(terminal.id, task?.id ?? '');
        expect(child.items.map((item) => item.type)).toEqual([
            'userMessage',
            'reasoning',
            'command',
            'agentMessage',
        ]);
        expect(itemTexts(child.items)).toEqual([
            'Inspect the fixtures\nand report what you find.',
            'Found one sample file.',
        ]);
        const viaItem = await service.readTask(terminal.id, spawn?.id ?? '');
        expect(viaItem.taskId).toBe(task?.id);
        expect(viaItem.items).toEqual(child.items);
    });

    it("names a subagent's running browser step after the tab it bound earlier", async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'subagent browsestep' });
        const running = await until(
            (snapshot) => agentTask(snapshot)?.lastToolName === 'browserUse',
        );
        const taskId = agentTask(running)?.id ?? '';
        const child = await service.readTask(terminal.id, taskId);
        const save = child.items.find(
            (item) => item.type === 'toolCall' && item.summary === 'Click Save',
        );
        expect(save).toMatchObject({ name: 'browserUse', status: 'running' });

        await until((snapshot) => agentTask(snapshot)?.status === 'completed');
        const done = await service.readTask(terminal.id, taskId);
        expect(
            done.items.find((item) => item.type === 'toolCall' && item.summary === 'Click Save'),
        ).toMatchObject({ name: 'browserUse', status: 'completed' });
    });

    it('stops a running subagent without ending the Chat turn state', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'subagent hold' });
        const running = await until(
            (snapshot) =>
                !snapshot.activeTurnId &&
                agentTask(snapshot)?.status === 'running' &&
                agentTask(snapshot)?.canStop === true,
        );
        const taskId = agentTask(running)?.id ?? '';
        await service.stopTask(terminal.id, taskId);
        const stopped = await until((snapshot) => agentTask(snapshot)?.status === 'stopped');
        expect(agentTask(stopped)?.endedAt).toBeTypeOf('number');
        await expect(service.stopTask(terminal.id, taskId)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('rebuilds a subagent task from thread/read after a restart', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'use a subagent' });
        const done = await until(
            (snapshot) => !snapshot.activeTurnId && agentTask(snapshot)?.status === 'completed',
        );
        const spawnId = agentTask(done)?.itemId ?? '';
        const childId = agentTask(done)?.id ?? '';

        await service.restart(terminal.id);
        const resumed = service.read(terminal.id);
        expect(agentTask(resumed)).toMatchObject({ id: childId, itemId: spawnId, canStop: false });
        const rebuilt = await service.readTask(terminal.id, spawnId);
        expect(rebuilt.taskId).toBe(childId);
        expect(itemTexts(rebuilt.items)).toEqual([
            'Inspect the fixtures\nand report what you find.',
            'Found one sample file.',
        ]);
        await expect(service.readTask(terminal.id, 'unknown-task')).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('lists a command that outlives its turn as a background terminal and stops it', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'start the background server' });
        const running = await until(
            (snapshot) => !snapshot.activeTurnId && shellTask(snapshot)?.status === 'running',
        );
        const task = shellTask(running);
        expect(task).toMatchObject({
            title: 'bun run dev',
            isBackground: true,
            canStop: true,
        });
        // The row stays running instead of closing as interrupted with its turn.
        expect(running.items.find((item) => item.id === task?.itemId)).toMatchObject({
            type: 'command',
            status: 'running',
        });
        expect(task?.id).toBe(task?.itemId);

        await vi.waitFor(
            async () => {
                const output = await service.readTask(terminal.id, task?.id ?? '');
                expect(output.output).toContain('server starting\n');
                expect(output.output).toContain('tick 2\n');
            },
            { timeout: 5_000, interval: 20 },
        );

        await service.stopTask(terminal.id, task?.id ?? '');
        const stopped = await until(
            (snapshot) =>
                shellTask(snapshot)?.status === 'stopped' &&
                snapshot.items.some(
                    (item) =>
                        item.id === task?.itemId &&
                        item.type === 'command' &&
                        item.status === 'failed',
                ),
        );
        expect(shellTask(stopped)?.canStop).toBe(false);
        await expect(service.stopTask(terminal.id, task?.id ?? '')).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('lists a background terminal from before a restart as ended', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'start the background server' });
        const running = await until(
            (snapshot) => !snapshot.activeTurnId && shellTask(snapshot)?.status === 'running',
        );
        const taskId = shellTask(running)?.id ?? '';
        await vi.waitFor(
            async () => {
                expect((await service.readTask(terminal.id, taskId)).output).toContain('tick 1\n');
            },
            { timeout: 5_000, interval: 20 },
        );

        // The restart ends the app-server and its terminals; the resumed history still shows the command.
        await service.restart(terminal.id);
        const resumed = await until((snapshot) => shellTask(snapshot) !== undefined);
        expect(shellTask(resumed)).toMatchObject({
            id: taskId,
            title: 'bun run dev',
            status: 'stopped',
            canStop: false,
            summary: 'Ended: Caxri restarted and can no longer track it',
        });
        // Its tab still opens; Codex keeps no output for a command that never finished.
        await expect(service.readTask(terminal.id, taskId)).resolves.toMatchObject({ taskId });
        await expect(service.stopTask(terminal.id, taskId)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('stops a background terminal Codex no longer lists, even without a notification', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'start the background server' });
        const running = await until(
            (snapshot) => !snapshot.activeTurnId && shellTask(snapshot)?.status === 'running',
        );
        const taskId = shellTask(running)?.id ?? '';

        // Codex reaps the terminal silently; the next turn's end reconciles the list.
        await service.send(terminal.id, { text: 'vanish' });
        const stopped = await until((snapshot) => shellTask(snapshot)?.status === 'stopped');
        expect(shellTask(stopped)).toMatchObject({ id: taskId, canStop: false });
        await expect(service.stopTask(terminal.id, taskId)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('lists a background terminal only Codex reported', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'unannounced' });
        const adopted = await until(
            (snapshot) => !snapshot.activeTurnId && shellTask(snapshot)?.status === 'running',
        );
        expect(shellTask(adopted)).toMatchObject({
            title: 'tail -f server.log',
            isBackground: true,
            canStop: true,
        });
        await service.stopTask(terminal.id, shellTask(adopted)?.id ?? '');
        await until((snapshot) => shellTask(snapshot)?.status === 'stopped');
    });

    it('says when Codex stopped streaming a background command', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'background flood' });
        const running = await until(
            (snapshot) => !snapshot.activeTurnId && shellTask(snapshot)?.status === 'running',
        );
        const output = await service.readTask(terminal.id, shellTask(running)?.id ?? '');
        expect(output.isOutputCapped).toBe(true);
        expect(output.output).toMatch(/^server starting\n\.+$/u);
        await service.stopTask(terminal.id, shellTask(running)?.id ?? '');
    });

    it('shows compaction in progress and the compacted notice only once it completes', async () => {
        const { service, terminal, signals, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        await service.runCommand(terminal.id, 'compact');
        const compacting = await until((snapshot) => snapshot.operation === 'compacting');
        expect(compacting.items.some((item) => item.type === 'notice')).toBe(false);
        // A compaction turn cannot be steered; that error is not mistaken for a turn that already ended.
        await expect(
            service.send(terminal.id, { text: 'hello during compaction' }, 'steer'),
        ).rejects.toMatchObject({ code: 'CONFLICT' });

        const compacted = await until(
            (snapshot) => snapshot.operation === undefined && !snapshot.activeTurnId,
        );
        expect(compacted.items).toEqual([expect.objectContaining({ kind: 'compacted' })]);
        const phases = signals.map((signal) => signal.phase);
        expect(phases).toContain('compactionStarted');
        expect(phases.indexOf('compactionStarted')).toBeLessThan(
            phases.indexOf('compactionFinished'),
        );
    });

    it('marks a steered message, and starts a turn when the steer loses the race', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'hello steer' }, 'steer');
        const steered = await until((snapshot) =>
            snapshot.items.some(
                (item) => item.type === 'userMessage' && item.text === 'hello steer',
            ),
        );
        expect(
            steered.items.find(
                (item) => item.type === 'userMessage' && item.text === 'hello steer',
            ),
        ).toMatchObject({
            delivery: 'steered',
        });

        await service.send(terminal.id, { text: 'hello late' }, 'steer');
        const late = await until(
            (snapshot) =>
                snapshot.turns.length === 2 &&
                snapshot.items.some(
                    (item) => item.type === 'agentMessage' && item.text.endsWith('hello late'),
                ),
        );
        const message = late.items.find(
            (item) => item.type === 'userMessage' && item.text === 'hello late',
        );
        expect(message).toBeDefined();
        expect(message).not.toHaveProperty('delivery');
        expect(late.turns[0]?.status).toBe('interrupted');
    });
});
