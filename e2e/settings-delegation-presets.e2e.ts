import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';
import { openSettingsPage, revealSettingsSection } from './support/settings.ts';

const SENTINEL = 'sentinel-private-value-7731';

const seededSettings = `// owner comment
{
    "agents.delegation": {
        "presets": [
            { "name": "keep-me", "provider": "claude", "useWhen": "Old wording" },
            { "name": "only-here", "provider": "codex", "useWhen": "Only in settings" }
        ]
    }
}
`;

const dianjiangFile = JSON.stringify({
    maxDepth: 2,
    agents: [
        { name: 'keep-me', harness: 'codex', useWhen: 'New wording' },
        { name: 'review', harness: 'claude', useWhen: 'Review a change', instructions: SENTINEL },
    ],
});

/**
 * Launches with a seeded `settings.jsonc` and a stubbed open dialog that returns `importPath`, then opens the
 * Delegation types and presets row in Settings.
 */
async function launchWithImport(importPath: string, directory: string) {
    const root = join(directory, 'project');
    const userDataDirectory = join(directory, 'user-data');
    await mkdir(root, { recursive: true });
    await mkdir(join(userDataDirectory, 'config'), { recursive: true });
    const settingsPath = join(userDataDirectory, 'config', 'settings.jsonc');
    await writeFile(settingsPath, seededSettings);
    const running = await launchCaxri({ userDataDir: userDataDirectory, testRootPath: root });
    await running.app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, importPath);
    await createProjectSession(running.page);
    const settings = await openSettingsPage(running.page);
    await revealSettingsSection(settings, 'Agents');
    const section = settings.getByRole('list', { name: 'Delegation presets' });
    await expect(section).toContainText('keep-me');
    await expect(section).toContainText('only-here');
    return { running, settings, settingsPath, section };
}

test('delegation presets import previews Merge and Replace before writing, keeping presets only in settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-import-e2e-'));
    const importPath = join(directory, 'dianjiang.json');
    await writeFile(importPath, dianjiangFile);
    const { running, settings, settingsPath, section } = await launchWithImport(
        importPath,
        directory,
    );
    try {
        await settings.getByRole('button', { name: 'Import from dianjiang…' }).click();
        const preview = settings.getByRole('region', { name: 'Delegation presets' });
        await expect(preview).toContainText('1 to add, 1 to change, 0 to remove');
        await expect(preview).toContainText('Adds: review');
        await expect(preview).not.toContainText('Removes:');
        await expect(preview).not.toContainText(SENTINEL);
        expect(await readFile(settingsPath, 'utf8')).toBe(seededSettings);

        await preview.getByRole('button', { name: /^Replace/ }).click();
        await expect(preview).toContainText('1 to add, 1 to change, 1 to remove');
        await expect(preview).toContainText('Removes: only-here');
        expect(await readFile(settingsPath, 'utf8')).toBe(seededSettings);

        await preview.getByRole('button', { name: /^Merge/ }).click();
        await expect(preview).toContainText('1 to add, 1 to change, 0 to remove');
        await preview.getByRole('button', { name: 'Import', exact: true }).click();

        await expect(section).toContainText('review');
        await expect(section).toContainText('only-here');
        await expect(section).toContainText('New wording');
        const written = await readFile(settingsPath, 'utf8');
        expect(written).toContain('// owner comment');
        expect(written).toContain('only-here');

        // Replace removes the preset the file does not list.
        await settings.getByRole('button', { name: 'Import from dianjiang…' }).click();
        const second = settings.getByRole('region', { name: 'Delegation presets' });
        await expect(second).toContainText('Already up to date');
        await second.getByRole('button', { name: /^Replace/ }).click();
        await expect(second).toContainText('0 to add, 0 to change, 1 to remove');
        await second.getByRole('button', { name: 'Import', exact: true }).click();
        await expect(section).not.toContainText('only-here');
        await expect(section).toContainText('review');
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('delegation presets import reports an invalid file without echoing its values', async () => {
    allowE2EErrors([
        { source: 'server-core', event: 'ipc.request_failed', code: 'VALIDATION', count: 1 },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-invalid-e2e-'));
    const importPath = join(directory, 'bad.json');
    await writeFile(
        importPath,
        JSON.stringify({
            agents: [{ name: 'review', harness: 'claude', useWhen: 'x', [SENTINEL]: SENTINEL }],
        }),
    );
    const { running, settings, settingsPath } = await launchWithImport(importPath, directory);
    try {
        await settings.getByRole('button', { name: 'Import from dianjiang…' }).click();
        const alert = settings.getByRole('alert');
        await expect(alert).toContainText('This file can’t be imported');
        await expect(alert).toContainText('unsupported field');
        await expect(settings).not.toContainText(SENTINEL);
        expect(await readFile(settingsPath, 'utf8')).toBe(seededSettings);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('delegation type bindings edit in Settings and write through without touching presets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-types-e2e-'));
    const { running, settings, settingsPath } = await launchWithImport(
        join(directory, 'unused.json'),
        directory,
    );
    try {
        await settings.getByRole('combobox', { name: 'Second opinion Agent' }).click();
        await running.page.getByRole('option', { name: 'Codex', exact: true }).click();
        const model = settings.getByRole('textbox', { name: 'Second opinion model' });
        await model.fill('gpt-5.5');
        await model.press('Enter');
        await settings.getByRole('combobox', { name: 'Second opinion effort' }).click();
        await running.page.getByRole('option', { name: 'high', exact: true }).click();
        await expect
            .poll(async () => JSON.stringify(await readSettings(settingsPath)))
            .toContain('"second-opinion":{"provider":"codex","model":"gpt-5.5","effort":"high"}');

        await settings.getByRole('button', { name: 'By calling Agent' }).first().click();
        await settings
            .getByRole('combobox', { name: 'Add an override for Second opinion' })
            .click();
        await running.page.getByRole('option', { name: 'When Codex asks' }).click();
        await settings
            .getByRole('combobox', { name: 'Second opinion, when Codex asks Agent' })
            .click();
        await running.page.getByRole('option', { name: 'Claude', exact: true }).click();
        await expect
            .poll(async () => (await readSettings(settingsPath)).callers?.codex?.types)
            .toMatchObject({ 'second-opinion': { provider: 'claude' } });

        const saved = await readSettings(settingsPath);
        expect(saved.presets.map((preset) => preset.name)).toEqual(['keep-me', 'only-here']);
        expect(await readFile(settingsPath, 'utf8')).toContain('// owner comment');
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * The saved `agents.delegation` value; the file is JSONC, so the leading line comment is stripped before parsing.
 */
async function readSettings(settingsPath: string): Promise<{
    presets: Array<{ name: string }>;
    callers?: Partial<Record<string, { types?: Record<string, unknown> }>>;
}> {
    const text = (await readFile(settingsPath, 'utf8')).replaceAll(/^\s*\/\/.*$/gm, '');
    return (JSON.parse(text) as Record<string, never>)['agents.delegation'];
}
