import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

    it('names the effort Claude Code applies before the first turn when the user never chose one', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        // An SDK-hosted init carries no effort; `get_settings` reports the applied one as soon as the CLI starts.
        await until((snapshot) => snapshot.models !== undefined && snapshot.effort === 'medium');

        // Each turn's hook input keeps it current.
        await service.send(terminal.id, { text: 'hello' });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'completed');
        expect(snapshot.effort).toBe('medium');
    });

    it('turns ultracode on, keeps it through an effort change, and withdraws it on a model without it', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await until((snapshot) => snapshot.ultracode === false);

        await service.configure(terminal.id, { ultracode: true });
        await until((snapshot) => snapshot.ultracode === true);
        // The first turn names the model, which an effort change is validated against.
        await service.send(terminal.id, { text: 'hello' });
        await until((current) => current.turns.at(-1)?.status === 'completed');

        // Claude Code drops ultracode on an effort change that leaves the key out; the Chat sends it along.
        await service.configure(terminal.id, { effort: 'high' });
        await service.send(terminal.id, { text: 'again' });
        const ran = await until(
            (current) => current.turns.length === 2 && current.turns.at(-1)?.status === 'completed',
        );
        expect(ran).toMatchObject({ effort: 'high', ultracode: true });

        await service.configure(terminal.id, { model: 'fake-claude-haiku' });
        const withdrawn = await until(
            (snapshot) =>
                snapshot.model === 'fake-claude-haiku' && snapshot.ultracode === undefined,
        );
        expect(withdrawn.ultracode).toBeUndefined();
        await expect(service.configure(terminal.id, { ultracode: true })).rejects.toMatchObject({
            code: 'VALIDATION',
        });
    });

    it('rejects a model change the CLI refuses and keeps the model it runs', async () => {
        const { claudeConfigDirectory, service, terminal, until } = await fixture({
            provider: 'claude',
        });
        const ready = await until((snapshot) => snapshot.models !== undefined);
        await mkdir(claudeConfigDirectory, { recursive: true });
        await writeFile(join(claudeConfigDirectory, 'reject-model-change'), '');

        await expect(service.configure(terminal.id, { model: 'opus' })).rejects.toThrow();
        expect(service.read(terminal.id).model).toBe(ready.model);
    });
});
