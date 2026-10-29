import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Agent Chat /review with a fake Codex app-server', () => {
    it('starts an inline review of the uncommitted changes and shows its notice and conclusion', async () => {
        const { fakeLog, service, terminal, until } = await fixture();
        const ready = await until((snapshot) => snapshot.status === 'ready');
        expect(ready.commands?.find((command) => command.name === 'review')).toMatchObject({
            description: 'Review code changes for bugs and risks',
            argumentHint: '[--base <branch> | --commit <sha> | instructions]',
        });

        await service.runCommand(terminal.id, 'review');
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items).toMatchObject([
            { type: 'notice', message: 'Reviewing current changes' },
            { type: 'agentMessage', streaming: false },
        ]);
        const conclusion = done.items[1];
        expect(conclusion.type === 'agentMessage' && conclusion.text).toContain(
            '## Review findings',
        );
        const requests = await fakeLog('codex', 'review-requests.jsonl');
        expect(requests).toMatchObject([
            { target: { type: 'uncommittedChanges' }, delivery: 'inline' },
        ]);
        expect(typeof requests[0].threadId).toBe('string');

        // The review is part of the thread, so a resumed Chat shows both items again.
        await service.restart(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');
        expect(service.read(terminal.id).items.map((item) => item.type)).toEqual([
            'notice',
            'agentMessage',
        ]);
    });

    it('maps the arguments to targets and rejects an invalid one without asking Codex', async () => {
        const { fakeLog, service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');

        await expect(service.runCommand(terminal.id, 'review', '--base')).rejects.toMatchObject({
            code: 'VALIDATION',
        });
        expect(await fakeLog('codex', 'review-requests.jsonl')).toEqual([]);

        await service.runCommand(terminal.id, 'review', '--base main');
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        await service.runCommand(terminal.id, 'review', 'focus on error handling');
        await until((snapshot) => snapshot.turns.length === 2 && !snapshot.activeTurnId);
        expect(
            (await fakeLog('codex', 'review-requests.jsonl')).map((request) => request.target),
        ).toEqual([
            { type: 'baseBranch', branch: 'main' },
            { type: 'custom', instructions: 'focus on error handling' },
        ]);
    });

    it("fails with Codex's own message for an unknown commit", async () => {
        const { service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        await expect(
            service.runCommand(terminal.id, 'review', '--commit not-a-sha'),
        ).rejects.toThrow(/unknown revision 'not-a-sha'/u);
        expect(service.read(terminal.id).activeTurnId).toBeUndefined();
    });

    it('queues /review behind a running turn instead of running it concurrently', async () => {
        const { fakeLog, service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.runCommand(terminal.id, 'review', '--base main');
        expect(service.read(terminal.id).queue).toMatchObject([
            { text: '/review --base main', command: { name: 'review' } },
        ]);
        expect(await fakeLog('codex', 'review-requests.jsonl')).toEqual([]);
        await service.interrupt(terminal.id);
    });
});
