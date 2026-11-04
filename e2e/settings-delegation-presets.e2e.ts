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
 * Delegation presets row in Settings.
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
        await expect(preview).not.toContainText(SENTINEL);
        expect(await readFile(settingsPath, 'utf8')).toBe(seededSettings);

        await preview.getByRole('button', { name: /^Replace/ }).click();
        await expect(preview).toContainText('1 to add, 1 to change, 1 to remove');
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
