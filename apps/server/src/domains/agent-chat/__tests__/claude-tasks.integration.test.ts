import { describe, expect, it, vi } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Claude Code background work in Agent Chat', () => {
    it('routes a subagent into its own task projection and lists its lifecycle', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'run a subagent' });
        const done = await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
        );
        const row = done.items.find((item) => item.type === 'toolCall' && item.name === 'Agent');
        expect(row).toMatchObject({ status: 'completed' });
        // The subagent's own messages never reach the parent timeline.
        expect(done.items.some((item) => 'text' in item && item.text.includes('README'))).toBe(
            false,
        );
        expect(
            done.items.some(
                (item) =>
                    item.type === 'notice' && /subagent (?:read )?Hook/iu.test(item.message ?? ''),
            ),
        ).toBe(false);
        expect(done.items.at(-1)).toMatchObject({ text: 'The subagent finished.' });

        const toolUseId = row?.id ?? '';
        expect(done.tasks).toEqual([
            expect.objectContaining({
                id: toolUseId,
                itemId: toolUseId,
                kind: 'agent',
                title: 'Survey the project',
                agentType: 'general-purpose',
                model: 'fake-haiku',
                status: 'completed',
                isBackground: false,
                canStop: false,
                summary: 'Found a README.',
                usage: { totalTokens: 1500, toolUses: 1, durationMs: 50 },
                lastToolName: 'Read',
            }),
        ]);

        const task = await service.readTask(terminal.id, toolUseId);
        expect(task.items.map((item) => item.type)).toEqual([
            'userMessage',
            'agentMessage',
            'toolCall',
            'notice',
            'notice',
            'notice',
            'agentMessage',
        ]);
        expect(task.items[0]).toMatchObject({ text: 'List the files in the project.' });
        expect(task.items[1]).toMatchObject({ text: 'Looking at the files.', streaming: false });
        expect(task.items[2]).toMatchObject({
            name: 'Read',
            status: 'completed',
            output: '# Project',
        });
        expect(task.items[3]).toMatchObject({
            type: 'notice',
            kind: 'error',
            title: 'Hook "PreToolUse:Read" failed (exit code 2)',
            message: 'Subagent read Hook failed.',
        });
        task.items.splice(3, 1);
        expect(task.items[3]).toMatchObject({
            type: 'notice',
            kind: 'warning',
            title: 'Input blocked by Hook',
            message: 'The subagent Hook blocked this read once. Retry with a narrower range.',
        });
        expect(task.items[4]).toMatchObject({
            type: 'notice',
            kind: 'output',
            title: 'review-tools · /check-read',
            message: 'Subagent mod output.',
        });
        expect(task.items[5]).toMatchObject({ text: 'Found a README.' });
    });

    it('rebuilds a subagent from its transcript after a restart', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'run a subagent' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        const toolUseId = done.items.find((item) => item.type === 'toolCall')?.id ?? '';
        await service.restart(terminal.id);

        const task = await service.readTask(terminal.id, toolUseId);
        expect(task.taskId).toBe(toolUseId);
        expect(task.items.map((item) => item.type)).toEqual([
            'userMessage',
            'agentMessage',
            'toolCall',
            'notice',
            'notice',
            'agentMessage',
        ]);
        expect(task.items[2]).toMatchObject({ status: 'completed', output: '# Project' });
        expect(task.items[3]).toMatchObject({
            type: 'notice',
            kind: 'warning',
            message: 'The subagent Hook blocked this read once. Retry with a narrower range.',
        });
        expect(task.items[4]).toMatchObject({
            type: 'notice',
            kind: 'output',
            title: 'review-tools · /check-read',
            message: 'Subagent mod output.',
        });
        expect(task.items.every((item) => item.turnId === undefined)).toBe(true);
        await expect(service.readTask(terminal.id, 'toolu_unknown')).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('streams a background shell output tail and stops it', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'run in background' });
        const listed = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.tasks?.[0]?.status === 'running',
        );
        const shell = listed.tasks?.[0];
        const bashRow = listed.items.find((item) => item.type === 'command');
        expect(shell).toMatchObject({
            kind: 'shell',
            itemId: bashRow?.id,
            // Named by the Bash call's description; the command line stays for its tab.
            title: 'Print ticks',
            command: 'while true; do echo tick; sleep 0.1; done',
            isBackground: true,
            canStop: true,
        });
        const taskId = shell?.id ?? '';
        await vi.waitFor(
            async () => {
                const task = await service.readTask(terminal.id, taskId);
                expect(task.output).toMatch(/tick 2\n/u);
            },
            { timeout: 5_000, interval: 50 },
        );
        // The Bash row opens the same task.
        expect((await service.readTask(terminal.id, bashRow?.id ?? '')).taskId).toBe(taskId);

        await service.stopTask(terminal.id, taskId);
        const stopped = await until((snapshot) => snapshot.tasks?.[0]?.status === 'stopped');
        expect(stopped.tasks?.[0]).toMatchObject({ canStop: false, summary: 'Stopped' });
        await expect(service.stopTask(terminal.id, taskId)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('keeps background tasks running when the turn is interrupted', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'start a background agent' });
        const listed = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.tasks?.length === 1,
        );
        expect(listed.tasks?.[0]).toMatchObject({
            kind: 'agent',
            title: 'Watch the build',
            status: 'running',
            isBackground: true,
            canStop: true,
        });
        // A background subagent's placeholder tool result does not end it.
        expect(listed.items.find((item) => item.type === 'toolCall')).toMatchObject({
            status: 'completed',
        });
        const taskId = listed.tasks?.[0]?.id ?? '';
        await vi.waitFor(async () => {
            const task = await service.readTask(terminal.id, taskId);
            expect(
                task.items.some(
                    (item) => 'text' in item && item.text === 'Working in the background.',
                ),
            ).toBe(true);
        });
        // A running subagent's `task_progress` names the tool it last used and what it has spent so far.
        const progressed = await until((snapshot) => snapshot.tasks?.[0]?.lastToolName === 'Grep');
        expect(progressed.tasks?.[0]).toMatchObject({
            agentType: 'general-purpose',
            model: 'fake-haiku',
            usage: { totalTokens: 12_300, toolUses: 2 },
        });

        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) =>
            snapshot.items.some(
                (item) => item.type === 'agentMessage' && item.text.startsWith('word'),
            ),
        );
        await service.interrupt(terminal.id);
        const interrupted = await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'interrupted',
        );
        expect(interrupted.tasks?.[0]).toMatchObject({ status: 'running', canStop: true });

        await service.stopTask(terminal.id, taskId);
        await until((snapshot) => snapshot.tasks?.[0]?.status === 'stopped');
    });

    it('keeps a background shell running when a later turn is interrupted', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'run in background' });
        const listed = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.tasks?.[0]?.status === 'running',
        );
        const taskId = listed.tasks?.[0]?.id ?? '';

        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) =>
            snapshot.items.some(
                (item) => item.type === 'agentMessage' && item.text.startsWith('word'),
            ),
        );
        await service.interrupt(terminal.id);
        const interrupted = await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'interrupted',
        );
        expect(interrupted.tasks?.[0]).toMatchObject({
            id: taskId,
            kind: 'shell',
            status: 'running',
            canStop: true,
        });
        // Its output keeps streaming after the interrupt.
        const before = (await service.readTask(terminal.id, taskId)).output ?? '';
        await vi.waitFor(
            async () => {
                const task = await service.readTask(terminal.id, taskId);
                expect((task.output ?? '').length).toBeGreaterThan(before.length);
            },
            { timeout: 5_000, interval: 50 },
        );

        await service.stopTask(terminal.id, taskId);
        await until((snapshot) => snapshot.tasks?.[0]?.status === 'stopped');
    });

    it('lists a workflow by its name with its progress until it completes', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'run a quick workflow' });
        const listed = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.tasks?.[0]?.status === 'running',
        );
        const row = listed.items.find(
            (item) => item.type === 'toolCall' && item.name === 'Workflow',
        );
        expect(listed.tasks).toEqual([
            expect.objectContaining({
                kind: 'agent',
                title: 'review',
                itemId: row?.id,
                isBackground: true,
                canStop: true,
            }),
        ]);

        const done = await until((snapshot) => snapshot.tasks?.[0]?.status === 'completed');
        expect(done.tasks?.[0]).toMatchObject({
            title: 'review',
            canStop: false,
            lastToolName: 'Agent',
            summary: 'Finished',
            usage: { totalTokens: 0, toolUses: 0, durationMs: 300 },
        });
    });

    it('stops a running workflow', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'start a workflow' });
        const listed = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.tasks?.[0]?.lastToolName === 'Agent',
        );
        const taskId = listed.tasks?.[0]?.id ?? '';
        expect(listed.tasks?.[0]).toMatchObject({ status: 'running', canStop: true });

        await service.stopTask(terminal.id, taskId);
        const stopped = await until((snapshot) => snapshot.tasks?.[0]?.status === 'stopped');
        expect(stopped.tasks?.[0]).toMatchObject({
            title: 'review',
            canStop: false,
            summary: 'Stopped',
        });
    });

    it('shows a turn Claude Code starts on its own after a background task finishes', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'quick background job' });
        const done = await until(
            (snapshot) =>
                snapshot.turns.length === 2 &&
                snapshot.turns.every((turn) => turn.status === 'completed') &&
                !snapshot.activeTurnId,
        );
        expect(done.tasks?.[0]).toMatchObject({ kind: 'shell', status: 'completed' });
        const autoTurn = done.turns[1];
        expect(autoTurn.id).toMatch(/^auto:/u);
        expect(done.items.at(-1)).toMatchObject({
            turnId: autoTurn.id,
            text: 'The background command finished.',
        });
        expect(done.items.filter((item) => item.type === 'userMessage')).toHaveLength(1);
    });

    it('marks a steered message and sends it with next priority', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'pause first' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'and then' }, 'steer');
        const done = await until(
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some(
                    (item) => item.type === 'agentMessage' && item.text.includes('[next]'),
                ),
        );
        const messages = done.items.filter((item) => item.type === 'userMessage');
        expect(messages[0]).not.toHaveProperty('delivery');
        expect(messages[1]).toMatchObject({ text: 'and then', delivery: 'steered' });
    });

    it('shows compaction in progress, then the compacted notice without a /compact bubble', async () => {
        const { service, terminal, signals, until } = await fixture({ provider: 'claude' });
        await until((snapshot) => snapshot.status === 'ready');
        await service.runCommand(terminal.id, 'compact');
        await until((snapshot) => snapshot.operation === 'compacting');
        const done = await until(
            (snapshot) => snapshot.operation === undefined && !snapshot.activeTurnId,
        );
        expect(done.items).toEqual([
            expect.objectContaining({ type: 'notice', kind: 'compacted' }),
        ]);
        expect(signals.map((signal) => signal.phase)).toEqual(
            expect.arrayContaining(['compactionStarted', 'compactionFinished']),
        );

        await service.restart(terminal.id);
        expect(service.read(terminal.id).items.map((item) => item.type)).toEqual(['notice']);
    });

    it('reports a failed compaction as an error notice', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await until((snapshot) => snapshot.status === 'ready');
        await service.runCommand(terminal.id, 'compact', 'break');
        await until((snapshot) => snapshot.operation === 'compacting');
        const done = await until(
            (snapshot) => snapshot.operation === undefined && !snapshot.activeTurnId,
        );
        expect(done.items).toContainEqual(
            expect.objectContaining({
                type: 'notice',
                kind: 'error',
                message: 'Not enough messages to compact.',
            }),
        );
        expect(done.items.some((item) => item.type === 'userMessage')).toBe(false);
    });
});
