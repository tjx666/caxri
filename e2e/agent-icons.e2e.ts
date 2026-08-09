import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { launchCaxri, openAddProjectDialog, pageRequest, selectedSessionId } from './helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);

test('production Dock assets are opaque so macOS does not add a white compatibility plate', async () => {
    for (const path of [
        join(projectRoot, 'build', 'icon.png'),
        join(projectRoot, 'build', 'icon.icns'),
    ]) {
        const { stdout } = await execFileAsync('sips', ['-g', 'hasAlpha', path]);
        expect(stdout).toContain('hasAlpha: no');
    }
});

test('Agent identities stay consistent across every shared surface', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-icons-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await openAddProjectDialog(running.page);
        const createDialog = running.page.getByRole('dialog');
        await expect(createDialog.locator('[data-agent-icon="claude"]')).toBeVisible();
        await expect(createDialog.locator('[data-agent-icon="codex"]')).toBeVisible();
        await expect(createDialog.locator('[data-agent-icon="shell"]')).toBeVisible();
        await createDialog.getByRole('button', { name: 'Codex' }).click();

        const sessionId = await selectedSessionId(running.page);
        await pageRequest(running.page, 'terminal.create', { kind: 'claude', sessionId });

        await expect(
            running.page.locator('.work-tab').locator('[data-agent-icon="codex"]'),
        ).toBeVisible();
        await expect(
            running.page.locator('.work-tab').locator('[data-agent-icon="claude"]'),
        ).toBeVisible();
        await expect(
            running.page
                .locator(`.session-card[data-session-id="${sessionId}"]`)
                .locator('[data-agent-icon="codex"]'),
        ).toBeVisible();

        const infoTab = running.page.getByRole('button', { name: 'Info', exact: true });
        await infoTab.click();
        await expect(
            running.page.locator('.terminal-info-card').locator('[data-agent-icon="claude"]'),
        ).toBeVisible();
        await expect(
            running.page.locator('.terminal-info-card').locator('[data-agent-icon="codex"]'),
        ).toBeVisible();

        /** Chromium on macOS may leave xterm focused after a pointer click on a button. This test
         * covers icons, so give its settings shortcut a deterministic non-editable focus target. */
        await infoTab.focus();
        await running.page.keyboard.press('Meta+,');
        const settingsDialog = running.page.getByRole('dialog');
        await expect(settingsDialog.locator('[data-agent-icon="unknown"]')).toBeVisible();
        await settingsDialog.getByLabel('Default Agent').click();
        await running.page.getByRole('option', { name: 'Codex', exact: true }).click();
        await expect(
            settingsDialog.locator('[data-slot="select-trigger"] [data-agent-icon="codex"]'),
        ).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Renderer build and package manifest include agent icon assets and attribution', async () => {
    const assets = await readdir(join(projectRoot, 'out', 'renderer', 'assets'));
    for (const name of ['claudecode-color-', 'codex-color-', 'grok-', 'opencode-']) {
        expect(assets.some((file) => file.startsWith(name) && file.endsWith('.svg'))).toBe(true);
    }

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
        build: { files: string[] };
    };
    expect(packageJson.build.files).toContain('licenses/**');
    await expect(
        readFile(join(projectRoot, 'licenses', 'LOBEHUB_ICONS_LICENSE.txt'), 'utf8'),
    ).resolves.toContain('Copyright (c) 2023 LobeHub');
});
