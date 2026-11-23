import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatModel } from '@caxri/protocol';
import { defaultAgentProviderSettings } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../../db';
import {
    antigravityChoiceFromName,
    readAntigravityFileDefaults,
    writeAntigravityFileDefaults,
} from '../antigravity-defaults';
import { AgentChatDefaultsService } from '../chat-defaults';

/**
 * The shapes `agy` 1.5.14 reports: a Chat lists `model` values with plain names and one `thought_level` for all of
 * them, while `agy models` names a Gemini model once per level and a Claude model once.
 */
const models: AgentChatModel[] = [
    {
        id: 'gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
    },
    {
        id: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6 (Thinking)',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
    },
];
const names = [
    'Gemini 3.8 Flash (Low)',
    'Gemini 3.8 Flash (Medium)',
    'Gemini 3.8 Flash (High)',
    'Claude Sonnet 4.6 (Thinking)',
];

async function temporaryDirectory(): Promise<string> {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agy-defaults-'));
    const directory = await realpath(created);
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

describe('Antigravity defaults', () => {
    it('reads a model name with or without its thinking level', () => {
        expect(antigravityChoiceFromName('Gemini 3.8 Flash (Medium)', models)).toEqual({
            model: 'gemini-3.8-flash',
            effort: 'medium',
        });
        expect(antigravityChoiceFromName('Claude Sonnet 4.6 (Thinking)', models)).toEqual({
            model: 'claude-sonnet-4-6',
        });
        expect(antigravityChoiceFromName('Retired Model (High)', models)).toEqual({});
        expect(antigravityChoiceFromName(undefined, models)).toEqual({});
    });

    it('writes the name agy lists and keeps every other key', async () => {
        const path = join(await temporaryDirectory(), 'settings.json');
        await writeFile(path, '{"trustedWorkspaces":["/work"],"model":"Gemini 3.8 Flash (High)"}');

        await writeAntigravityFileDefaults(path, models, names, { effort: 'low' });
        expect(await readAntigravityFileDefaults(path, models)).toEqual({
            model: 'gemini-3.8-flash',
            effort: 'low',
        });

        // A model agy lists once is saved under its plain name; its level cannot be saved.
        await writeAntigravityFileDefaults(path, models, names, { model: 'claude-sonnet-4-6' });
        const text = await readFile(path, 'utf8');
        expect(text).toBe(
            `${JSON.stringify({ trustedWorkspaces: ['/work'], model: 'Claude Sonnet 4.6 (Thinking)' }, null, 2)}\n`,
        );

        // A model change without an effort takes the model's own default level.
        await writeAntigravityFileDefaults(path, models, names, { model: 'gemini-3.8-flash' });
        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
            model: 'Gemini 3.8 Flash (High)',
        });

        await writeAntigravityFileDefaults(path, models, names, { model: null });
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ trustedWorkspaces: ['/work'] });
    });

    it('refuses a model agy does not name and a file that is not JSON', async () => {
        const path = join(await temporaryDirectory(), 'settings.json');
        await expect(
            writeAntigravityFileDefaults(path, models, [], { model: 'gemini-3.8-flash' }),
        ).rejects.toThrow("Antigravity's model list does not name Gemini 3.8 Flash");
        await writeFile(path, '{ broken');
        await expect(
            writeAntigravityFileDefaults(path, models, names, { model: null }),
        ).rejects.toThrow('not valid JSON');
        expect(await readFile(path, 'utf8')).toBe('{ broken');
    });

    it('keeps a model it does not recognize when only the level changes', async () => {
        const path = join(await temporaryDirectory(), 'settings.json');
        await writeFile(path, '{"model":"Future Model (High)"}');
        await expect(
            writeAntigravityFileDefaults(path, models, names, { effort: 'low' }),
        ).rejects.toThrow('Choose an Antigravity model before its level');
        expect(await readFile(path, 'utf8')).toBe('{"model":"Future Model (High)"}');
    });

    it('reads and writes through Settings with the names `agy models` prints', async () => {
        const directory = await temporaryDirectory();
        const stateDirectory = join(directory, '.gemini', 'antigravity-cli');
        await mkdir(stateDirectory, { recursive: true });
        const executable = join(directory, 'agy');
        const rows = names.map((name, index) => `model-${index}\t${name}`).join(String.raw`\n`);
        await writeFile(
            executable,
            `#!/bin/sh\n[ "$1" = models ] && printf 'Fetching models...\\n${rows}\\n'\n`,
        );
        await chmod(executable, 0o755);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(() => database.close());
        const service = new AgentChatDefaultsService({
            database,
            logger: { write: vi.fn() } as unknown as StructuredLogger,
            agentEnvironment: { homeDirectory: directory, variables: {} },
            launchSettings: (provider) => ({
                ...defaultAgentProviderSettings[provider].launch,
                args: [],
            }),
            resolveExecutable: () => Promise.resolve(executable),
            environment: () => Promise.resolve({}),
        });
        service.observeModels('antigravity', models);

        expect(
            await service.write('antigravity', { model: 'gemini-3.8-flash', effort: 'medium' }),
        ).toMatchObject({
            provider: 'antigravity',
            model: 'gemini-3.8-flash',
            effort: 'medium',
            overrides: [],
            models,
            file: '~/.gemini/antigravity-cli/settings.json',
        });
        const settings = await readFile(join(stateDirectory, 'settings.json'), 'utf8');
        expect(JSON.parse(settings)).toEqual({
            model: 'Gemini 3.8 Flash (Medium)',
        });
        expect(await service.resolve('antigravity')).toEqual({
            model: 'gemini-3.8-flash',
            effort: 'medium',
        });
    });
});
