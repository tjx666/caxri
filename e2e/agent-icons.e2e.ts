import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

const projectRoot = resolve(import.meta.dirname, '..');

async function launch(
    userData: string,
    projectPath: string,
): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
        args: ['.', '--disable-gpu'],
        cwd: projectRoot,
        env: {
            ...process.env,
            CAXRI_E2E: '1',
            CAXRI_USER_DATA_DIR: userData,
            CAXRI_TEST_ROOT_PATH: projectPath,
        },
    });
    const page = await app.firstWindow();
    await expect(page.getByText('Runtime ready')).toBeVisible();
    return { app, page };
}

test('Agent identities stay consistent across every shared surface', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-icons-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launch(userData, root);
    try {
        await running.page.getByRole('button', { name: 'Add Project', exact: true }).last().click();
        const createDialog = running.page.getByRole('dialog');
        await expect(createDialog.locator('[data-agent-icon="claude"]')).toBeVisible();
        await expect(createDialog.locator('[data-agent-icon="codex"]')).toBeVisible();
        await expect(createDialog.locator('[data-agent-icon="shell"]')).toBeVisible();
        await createDialog.getByRole('button', { name: 'Codex' }).click();

        const sessionId = await running.page.evaluate(async () => {
            const bridge = (
                window as unknown as {
                    caxri: {
                        request<T>(method: string, params?: unknown): Promise<T>;
                    };
                }
            ).caxri;
            const state = await bridge.request<{ selectedSessionId?: string }>('app.bootstrap');
            if (!state.selectedSessionId) throw new Error('No Session selected');
            await bridge.request('terminal.create', {
                kind: 'claude',
                sessionId: state.selectedSessionId,
            });
            return state.selectedSessionId;
        });

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

        await running.page.getByRole('button', { name: 'Agent', exact: true }).click();
        await expect(
            running.page.locator('.agent-card').locator('[data-agent-icon="claude"]'),
        ).toBeVisible();
        await expect(
            running.page.locator('.agent-card').locator('[data-agent-icon="codex"]'),
        ).toBeVisible();

        await running.page.getByRole('button', { name: 'Settings', exact: true }).click();
        const settingsDialog = running.page.getByRole('dialog');
        await expect(settingsDialog.locator('[data-agent-icon="unknown"]')).toBeVisible();
        await settingsDialog.getByLabel('Default Agent').selectOption('codex');
        await expect(settingsDialog.locator('[data-agent-icon="codex"]')).toBeVisible();
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
