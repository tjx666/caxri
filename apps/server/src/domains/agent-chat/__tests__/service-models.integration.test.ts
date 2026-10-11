import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Agent Chat model and effort with a fake Codex app-server', () => {
    it('lists the models, reports the default effort, and carries a switch into the next turn', async () => {
        const { service, terminal, until } = await fixture();
        const ready = await until((snapshot) => snapshot.models !== undefined);
        expect(ready).toMatchObject({ model: 'fake-codex-model', effort: 'medium' });
        expect(ready.models).toEqual([
            expect.objectContaining({
                id: 'fake-codex-model',
                displayName: 'Fake Codex',
                efforts: ['low', 'medium', 'high'],
                defaultEffort: 'medium',
            }),
            expect.objectContaining({ id: 'fake-codex-mini', efforts: ['low'] }),
        ]);

        await service.configure(terminal.id, { effort: 'high' });
        expect(await until((snapshot) => snapshot.effort === 'high')).toMatchObject({
            model: 'fake-codex-model',
        });
        await service.configure(terminal.id, { model: 'fake-codex-mini' });
        // The current effort is not one the smaller model accepts, so it falls back to that model's default.
        await until(
            (snapshot) => snapshot.model === 'fake-codex-mini' && snapshot.effort === 'low',
        );

        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        // Codex saved the choice on the thread, so the resumed thread reports it rather than the launch default.
        await service.restart(terminal.id);
        expect(service.read(terminal.id)).toMatchObject({
            model: 'fake-codex-mini',
            effort: 'low',
        });
    });

    it('rejects a model or effort the provider did not list', async () => {
        const { service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.models !== undefined);
        await expect(
            service.configure(terminal.id, { model: 'gpt-unknown' }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(service.configure(terminal.id, { effort: 'xhigh' })).rejects.toMatchObject({
            code: 'VALIDATION',
        });
    });
});

describe('Agent Chat model and effort with a fake Claude Code CLI', () => {
    it('switches the model and effort in place for the next response', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        const ready = await until((snapshot) => snapshot.models !== undefined);
        expect(ready.models?.map((model) => model.id)).toEqual([
            'fake-claude-model',
            'opus',
            'fake-claude-haiku',
        ]);
        expect(ready.models?.[1]).toMatchObject({ resolvedId: 'fake-claude-opus' });
        expect(ready.models?.[2]).toMatchObject({ efforts: [] });

        await service.configure(terminal.id, { model: 'opus', effort: 'max' });
        await until(
            (snapshot) => snapshot.model === 'fake-claude-opus' && snapshot.effort === 'max',
        );

        // The next turn's init message and hook input report what the CLI now runs, and they agree.
        await service.send(terminal.id, { text: 'hello' });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'completed');
        expect(snapshot).toMatchObject({ model: 'fake-claude-opus', effort: 'max' });
    });

    it('learns the effort Claude Code applies from hook input when the user never chose one', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        const ready = await until((snapshot) => snapshot.models !== undefined);
        // An SDK-hosted init carries no effort, so nothing is known before the first turn.
        expect(ready.effort).toBeUndefined();

        await service.send(terminal.id, { text: 'hello' });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'completed');
        expect(snapshot.effort).toBe('medium');
    });
});
