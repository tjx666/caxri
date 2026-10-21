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

    it('turns Fast mode on through the next turn, keeps it on the thread, and turns it off for a model without it', async () => {
        const { fakeLog, service, terminal, until } = await fixture();
        const ready = await until((snapshot) => snapshot.models !== undefined);
        expect(ready).toMatchObject({ fast: false });
        expect(ready.models?.[0]?.fast).toEqual({ description: '1.5x speed, increased usage' });
        expect(ready.models?.[1]?.fast).toBeUndefined();

        await service.configure(terminal.id, { fast: true });
        await until((snapshot) => snapshot.fast === true);
        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        // Codex saved the tier on the thread, so the resumed thread still runs Fast.
        await service.restart(terminal.id);
        expect(service.read(terminal.id)).toMatchObject({ fast: true });

        await service.configure(terminal.id, { model: 'fake-codex-mini' });
        await until((snapshot) => snapshot.model === 'fake-codex-mini' && snapshot.fast === false);
        await expect(service.configure(terminal.id, { fast: true })).rejects.toMatchObject({
            code: 'VALIDATION',
        });
        await service.send(terminal.id, { text: 'again' });
        await until(
            (snapshot) =>
                snapshot.turns.length === 2 && snapshot.turns.at(-1)?.status === 'completed',
        );
        // `default` asks for standard speed; clearing the tier would fall back to the user's config instead.
        const tiers = (await fakeLog('codex', 'turn-starts.jsonl')).map(
            (entry) => (entry as { serviceTier?: string }).serviceTier,
        );
        expect(tiers).toEqual(['priority', 'default']);
    });

    it('saves a picker switch as the default for new Chats, as the Codex TUI does', async () => {
        const { fakeLog, logWrite, service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.models !== undefined);
        await service.configure(terminal.id, { fast: true });
        await service.configure(terminal.id, { model: 'fake-codex-mini' });
        // The smaller model has no Fast mode and only `low` effort, so the save turns both off with it.
        await expect
            .poll(async () =>
                (await fakeLog('codex', 'config-writes.jsonl')).map((entry) => entry.edits),
            )
            .toEqual([
                [{ keyPath: 'service_tier', value: 'fast', mergeStrategy: 'replace' }],
                [
                    { keyPath: 'model', value: 'fake-codex-mini', mergeStrategy: 'replace' },
                    { keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'replace' },
                    { keyPath: 'service_tier', value: 'default', mergeStrategy: 'replace' },
                ],
            ]);
        expect(
            logWrite.mock.calls
                .filter(([, event]) => event === 'agent_chat.defaults_saved')
                .map(([level, , record]) => [level, record?.fields?.outcome, record?.fields?.keys]),
        ).toEqual([
            ['info', 'saved', 'service_tier'],
            ['info', 'saved', 'model,model_reasoning_effort,service_tier'],
        ]);
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

    it('turns Fast mode on through the flag settings and off for a model without it', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        // Under the Agent SDK Claude Code reports Fast mode off until the host opts in, which the toggle does.
        const ready = await until((snapshot) => snapshot.models !== undefined);
        expect(ready).toMatchObject({ fast: false });
        expect(ready.models?.map((model) => model.fast)).toEqual([{}, {}, undefined]);

        await service.configure(terminal.id, { fast: true });
        await until((snapshot) => snapshot.fast === true);
        // The turn's init message and result report what the CLI now runs.
        await service.send(terminal.id, { text: 'hello' });
        const ran = await until((current) => current.turns.at(-1)?.status === 'completed');
        expect(ran.fast).toBe(true);

        await service.configure(terminal.id, { model: 'fake-claude-haiku' });
        await until(
            (snapshot) => snapshot.model === 'fake-claude-haiku' && snapshot.fast === false,
        );
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
