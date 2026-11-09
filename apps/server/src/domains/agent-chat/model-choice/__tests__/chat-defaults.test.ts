import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatModel } from '@caxri/protocol';
import { defaultAgentProviderSettings } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../../db';
import { AgentChatDefaultsService } from '../chat-defaults';
import type { CodexDefaultsReading } from '../codex-defaults';
import { codexLaunchDefaults } from '../codex-defaults';

const claudeModels: AgentChatModel[] = [
    { id: 'default', displayName: 'Default', efforts: ['low', 'medium', 'high'] },
    { id: 'opus', resolvedId: 'claude-opus', displayName: 'Opus', efforts: ['high', 'max'] },
];

async function setup(
    options: {
        args?: Partial<Record<'claude' | 'codex', string[]>>;
        environment?: NodeJS.ProcessEnv;
        codex?: CodexDefaultsReading;
    } = {},
) {
    const created = await mkdtemp(join(tmpdir(), 'caxri-chat-defaults-'));
    const directory = await realpath(created);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const claudeDirectory = join(directory, 'claude');
    await mkdir(claudeDirectory);
    const write = vi.fn<(context: unknown, change: unknown) => Promise<void>>(() =>
        Promise.resolve(),
    );
    const logWrite = vi.fn<StructuredLogger['write']>();
    const service = new AgentChatDefaultsService({
        database,
        logger: { write: logWrite } as unknown as StructuredLogger,
        agentEnvironment: {
            homeDirectory: directory,
            variables: { CLAUDE_CONFIG_DIR: claudeDirectory },
        },
        launchSettings: (provider) => ({
            ...defaultAgentProviderSettings[provider].launch,
            args: options.args?.[provider] ?? [],
        }),
        resolveExecutable: () => Promise.resolve('/fake/codex'),
        environment: () => Promise.resolve(options.environment ?? {}),
        codex: {
            read: () =>
                Promise.resolve(
                    options.codex ?? { file: {}, models: [], accountDefaultModel: undefined },
                ),
            write,
        },
    });
    return { claudeDirectory, database, directory, logWrite, service, write };
}

describe('AgentChatDefaultsService', () => {
    it('reads Claude Code’s settings file with the models a Chat listed last', async () => {
        const { claudeDirectory, service } = await setup({
            args: { claude: ['--effort', 'max'] },
            environment: { ANTHROPIC_MODEL: 'opus' },
        });
        await writeFile(join(claudeDirectory, 'settings.json'), '{"effortLevel":"high"}');
        service.observeModels('claude', claudeModels);

        expect(await service.read('claude')).toMatchObject({
            provider: 'claude',
            effort: 'high',
            models: claudeModels,
            builtInModel: 'default',
            overrides: [
                { key: 'model', source: 'environment', value: 'opus' },
                { key: 'effort', source: 'launchArgs', value: 'max' },
            ],
        });
        // The reset goes back to what a new Chat would run: the higher layers win key by key.
        expect(await service.resolve('claude')).toEqual({ model: 'opus', effort: 'max' });
    });

    it('writes Claude Code’s settings file and logs only the keys', async () => {
        const { claudeDirectory, logWrite, service } = await setup();
        const defaults = await service.write('claude', { model: 'opus', ultracode: true });
        expect(defaults).toMatchObject({ model: 'opus', ultracode: true });
        const written = await readFile(join(claudeDirectory, 'settings.json'), 'utf8');
        expect(JSON.parse(written)).toEqual({ model: 'opus', ultracode: true });
        expect(logWrite).toHaveBeenCalledWith('info', 'agent_chat.defaults_written', {
            fields: { provider: 'claude', outcome: 'written', keys: 'model,ultracode' },
        });
    });

    it('starts a Codex reset on the account default model when config.toml names none', async () => {
        const { database, service, write } = await setup({
            args: { codex: ['-c', 'model_reasoning_effort="high"'] },
            codex: {
                file: { effort: 'low' },
                models: claudeModels,
                accountDefaultModel: 'opus',
            },
        });
        expect(await service.resolve('codex')).toEqual({ model: 'opus', effort: 'high' });
        expect(await service.read('codex')).toMatchObject({ builtInModel: 'opus' });
        expect(database.getAppState('agentChatModels')?.codex).toEqual(claudeModels);

        await service.write('codex', { model: 'opus', effort: null });
        expect(write).toHaveBeenCalledWith(expect.objectContaining({ executable: '/fake/codex' }), {
            model: 'opus',
            effort: null,
        });
    });

    it('does not rewrite an unchanged model cache', async () => {
        const { database, service } = await setup();
        const setAppState = vi.spyOn(database, 'setAppState');
        service.observeModels('claude', claudeModels);
        service.observeModels('claude', claudeModels);
        service.observeModels('grok', claudeModels);
        expect(setAppState).toHaveBeenCalledOnce();
    });
});

describe('codexLaunchDefaults', () => {
    it('reads -m and -c overrides of model and model_reasoning_effort', () => {
        expect(
            codexLaunchDefaults([
                '-m',
                'gpt-a',
                '--config=model_reasoning_effort="xhigh"',
                '-c',
                'sandbox_mode="read-only"',
            ]),
        ).toEqual({ model: 'gpt-a', effort: 'xhigh' });
        expect(codexLaunchDefaults(['-c', 'model = "gpt-b"'])).toEqual({ model: 'gpt-b' });
    });
});
