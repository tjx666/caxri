import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatModel } from '@caxri/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
    claudeDefaultOverrides,
    claudeLaunchDefaults,
    claudeSettingsPath,
    readClaudeFileDefaults,
    writeClaudeFileDefaults,
} from '../claude-defaults';

const models: AgentChatModel[] = [
    { id: 'default', displayName: 'Default', efforts: ['low', 'medium', 'high'] },
    { id: 'opus', resolvedId: 'claude-opus', displayName: 'Opus', efforts: ['high', 'max'] },
];

async function settingsFile(content?: unknown): Promise<string> {
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-defaults-'));
    const directory = await realpath(created);
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'settings.json');
    if (content !== undefined) await writeFile(path, JSON.stringify(content));
    return path;
}

const readJson = async (path: string): Promise<unknown> =>
    JSON.parse(await readFile(path, 'utf8')) as unknown;

describe('claudeSettingsPath', () => {
    it('follows CLAUDE_CONFIG_DIR like Claude Code', () => {
        expect(
            claudeSettingsPath({
                homeDirectory: '/home/me',
                variables: { CLAUDE_CONFIG_DIR: '/accounts/work' },
            }),
        ).toBe('/accounts/work/settings.json');
        expect(claudeSettingsPath({ homeDirectory: '/home/me', variables: {} })).toBe(
            '/home/me/.claude/settings.json',
        );
    });
});

describe('readClaudeFileDefaults', () => {
    it('lets the effort /effort saved for the default model win over the file-wide one', async () => {
        const path = await settingsFile({
            model: 'opus',
            effortLevel: 'high',
            modelSettings: { 'claude-opus': { effortLevel: 'max' } },
            ultracode: true,
        });
        expect(await readClaudeFileDefaults(path, models)).toEqual({
            model: 'opus',
            effort: 'max',
            ultracode: true,
        });
    });

    it('reads a missing file as no default and refuses a file that is not a JSON object', async () => {
        expect(await readClaudeFileDefaults(await settingsFile(), models)).toEqual({});
        await expect(readClaudeFileDefaults(await settingsFile([1]), models)).rejects.toMatchObject(
            { code: 'VALIDATION' },
        );
    });
});

describe('writeClaudeFileDefaults', () => {
    it('merges the change and keeps every other key', async () => {
        const path = await settingsFile({
            model: 'opus',
            permissions: { allow: ['Bash(ls)'] },
            modelSettings: { 'claude-opus': { effortLevel: 'max' } },
            ultracode: true,
        });
        await writeClaudeFileDefaults(path, models, { effort: 'high', ultracode: false });
        expect(await readJson(path)).toEqual({
            model: 'opus',
            permissions: { allow: ['Bash(ls)'] },
            // The per-model value would otherwise shadow the new default.
            modelSettings: { 'claude-opus': { effortLevel: 'high' } },
            effortLevel: 'high',
        });

        // The effort cleared is the one of the default model after the change; Opus keeps its own.
        await writeClaudeFileDefaults(path, models, { model: null, effort: null });
        expect(await readJson(path)).toEqual({
            permissions: { allow: ['Bash(ls)'] },
            modelSettings: { 'claude-opus': { effortLevel: 'high' } },
        });
    });

    it('creates a missing file and writes through a symlinked one', async () => {
        const path = await settingsFile();
        await writeClaudeFileDefaults(path, models, { model: 'opus' });
        expect(await readJson(path)).toEqual({ model: 'opus' });

        const target = await settingsFile({ theme: 'dark' });
        const link = join(await realpath(join(target, '..')), 'linked');
        await mkdir(link);
        await symlink(target, join(link, 'settings.json'));
        await writeClaudeFileDefaults(join(link, 'settings.json'), models, { effort: 'low' });
        expect((await lstat(join(link, 'settings.json'))).isSymbolicLink()).toBe(true);
        expect(await readJson(target)).toEqual({ theme: 'dark', effortLevel: 'low' });
    });

    it('refuses max, which Claude Code never saves', async () => {
        const path = await settingsFile({});
        await expect(
            writeClaudeFileDefaults(path, models, { effort: 'max' }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(await readJson(path)).toEqual({});
    });
});

describe('claudeLaunchDefaults and claudeDefaultOverrides', () => {
    it('reads --model, --effort, and an inline --settings object', () => {
        const launch = claudeLaunchDefaults([
            '--model=opus',
            '--effort',
            'high',
            '--settings',
            '{"ultracode":true}',
        ]);
        expect(launch).toEqual({ model: 'opus', effort: 'high', ultracode: true });
        expect(claudeLaunchDefaults(['--settings', '/path/settings.json'])).toEqual({});
    });

    it('ranks the effort environment variable over --effort, and --model over ANTHROPIC_MODEL', () => {
        expect(
            claudeDefaultOverrides(
                { model: 'opus', effort: 'high' },
                { ANTHROPIC_MODEL: 'haiku', CLAUDE_CODE_EFFORT_LEVEL: 'low' },
            ),
        ).toEqual([
            { key: 'model', source: 'launchArgs', value: 'opus' },
            { key: 'effort', source: 'environment', value: 'low' },
        ]);
        expect(claudeDefaultOverrides({}, { ANTHROPIC_MODEL: 'haiku' })).toEqual([
            { key: 'model', source: 'environment', value: 'haiku' },
        ]);
    });
});
