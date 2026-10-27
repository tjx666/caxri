import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Agent Chat goals with a fake Codex app-server', () => {
    it('sets a goal that Codex pursues on its own and mirrors its status', async () => {
        const { fakeLog, service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');

        await service.runCommand(terminal.id, 'goal', 'Ship the release notes');
        const done = await until((snapshot) => snapshot.goal?.status === 'complete');
        expect(done.goal).toMatchObject({ objective: 'Ship the release notes', tokensUsed: 0 });
        // Codex starts the goal's turn itself; Caxri never sent `turn/start`.
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(await fakeLog('codex', 'turn-starts.jsonl')).toEqual([]);
        const [request, ...others] = await fakeLog('codex', 'goal-requests.jsonl');
        expect(others).toEqual([]);
        expect(request).toEqual({
            method: 'thread/goal/set',
            threadId: request.threadId,
            origin: 'user',
            objective: 'Ship the release notes',
            status: 'active',
        });
        expect(typeof request.threadId).toBe('string');

        // A new objective replaces the finished goal instead of editing it.
        await service.runCommand(terminal.id, 'goal', 'Write the changelog');
        await until(
            (snapshot) =>
                snapshot.goal?.objective === 'Write the changelog' &&
                snapshot.goal.status === 'complete',
        );
        expect((await fakeLog('codex', 'goal-requests.jsonl')).slice(1)).toMatchObject([
            { method: 'thread/goal/clear', origin: 'user' },
            { method: 'thread/goal/set', objective: 'Write the changelog' },
        ]);

        // A replacement Codex refuses puts the previous goal back instead of leaving none.
        await expect(
            service.runCommand(terminal.id, 'goal', 'reject this objective'),
        ).rejects.toThrow();
        expect(service.read(terminal.id).goal?.objective).toBe('Write the changelog');

        await service.runCommand(terminal.id, 'goal', 'clear');
        await until((snapshot) => snapshot.goal === undefined);

        // The goal belongs to the thread, so a resumed Chat shows it again.
        await service.runCommand(terminal.id, 'goal', 'Keep the docs current');
        await until((snapshot) => snapshot.goal?.status === 'complete');
        await service.restart(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');
        expect(service.read(terminal.id).goal).toMatchObject({
            objective: 'Keep the docs current',
            status: 'complete',
        });
    });

    it('pauses the goal on Stop so Codex does not continue it, and resumes during a turn', async () => {
        const { service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        await expect(service.runCommand(terminal.id, 'goal')).rejects.toMatchObject({
            code: 'VALIDATION',
        });

        await service.runCommand(terminal.id, 'goal', 'hold the line');
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        // The goal's spend grows with each model request of the turn that pursues it.
        const spending = await until((snapshot) => (snapshot.goalUsage?.requests ?? 0) >= 2);
        const requests = spending.goalUsage?.requests ?? 0;
        expect(spending.goalUsage).toMatchObject({
            objective: 'hold the line',
            totalTokens: requests * 1200,
        });
        await service.interrupt(terminal.id);
        const stopped = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.goal?.status === 'paused',
        );
        expect(stopped.turns.at(-1)?.status).toBe('interrupted');

        // A goal change is not a turn of its own, so it never waits in the follow-up queue.
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.runCommand(terminal.id, 'goal', 'resume');
        expect(service.read(terminal.id)).toMatchObject({ goal: { status: 'active' } });
        expect(service.read(terminal.id).queue ?? []).toEqual([]);
        await service.runCommand(terminal.id, 'goal', 'pause');
        expect(service.read(terminal.id).goal?.status).toBe('paused');
        await service.interrupt(terminal.id);
    });
});
