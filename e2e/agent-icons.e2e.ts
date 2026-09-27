import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    launchCaxri,
    openAddProjectDialog,
    openPanelView,
    openSettingsTab,
    pageRequest,
    waitForCreatedSession,
    waitForRuntimeReady,
} from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');

test('production Dock assets are opaque so macOS does not add a white compatibility plate', async () => {
    const results = await Promise.all(
        [join(projectRoot, 'build', 'icon.png'), join(projectRoot, 'build', 'icon.icns')].map(
            (path) => execFileAsync('sips', ['-g', 'hasAlpha', path]),
        ),
    );
    for (const { stdout } of results) {
        expect(stdout).toContain('hasAlpha: no');
    }
});

test('Agent identities stay consistent across every shared surface', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-icons-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: {}, codex: {} },
    });

    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await openAddProjectDialog(running.page);
        const projectDialog = running.page.getByRole('dialog');
        await expect(projectDialog.locator('[data-agent-icon="claude"]')).toBeVisible();
        await expect(projectDialog.locator('[data-agent-icon="codex"]')).toBeVisible();
        await expect(projectDialog.locator('[data-agent-icon="shell"]')).toBeVisible();
        await projectDialog.getByRole('button', { name: 'Codex' }).click();

        const sessionId = await waitForCreatedSession(running.page);
        const workTabs = running.page.locator('.work-tab');
        const codexTab = workTabs.filter({
            has: running.page.locator('[data-agent-icon="codex"]'),
        });
        await expect(codexTab).toBeVisible();
        const codexTerminalId = await codexTab.getAttribute('data-terminal-id');
        expect(codexTerminalId).toBeTruthy();
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${codexTerminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        const claudeTerminal = await pageRequest<{ id: string }>(running.page, 'terminal.create', {
            kind: 'claude',
            sessionId,
        });
        /**
         * This spec deliberately creates the secondary Terminal through IPC because the UI only exposes a generic Shell
         * action. The request returning proves Server creation, not that a loaded Renderer has consumed
         * `state.changed`. Icon coverage does not own that event-delivery contract, so make the durable bootstrap
         * snapshot the boundary before reloading and asserting every shared Renderer surface.
         */
        await expect
            .poll(async () => {
                const bootstrap = await pageRequest<{
                    sessionStates: Array<{ sessionId: string }>;
                    terminals: Array<{ id: string }>;
                }>(running.page, 'app.bootstrap');
                const state = bootstrap.sessionStates.find(
                    (candidate) => candidate.sessionId === sessionId,
                );
                return (
                    bootstrap.terminals.some((terminal) => terminal.id === claudeTerminal.id) &&
                    JSON.stringify(state).includes(claudeTerminal.id)
                );
            })
            .toBe(true);
        await running.page.reload();
        await waitForRuntimeReady(running.page);

        const claudeTab = running.page.locator(
            `.work-tab[data-terminal-id="${claudeTerminal.id}"]`,
        );
        await expect(codexTab.locator('[data-agent-icon="codex"]')).toBeVisible();
        await expect(claudeTab.locator('[data-agent-icon="claude"]')).toBeVisible();
        await claudeTab.getByRole('tab').click();
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${claudeTerminal.id}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        await expect(
            running.page
                .locator(`.session-card[data-session-id="${sessionId}"]`)
                .locator('[data-agent-icon="codex"]'),
        ).toBeVisible();

        const infoTab = await openPanelView(running.page, 'Info');
        await expect(
            running.page.locator('.terminal-info-card').locator('[data-agent-icon="claude"]'),
        ).toBeVisible();
        await expect(
            running.page.locator('.terminal-info-card').locator('[data-agent-icon="codex"]'),
        ).toBeVisible();

        /**
         * Chromium on macOS may leave xterm focused after a pointer click on a button. This test covers icons, so give
         * its settings shortcut a deterministic non-editable focus target.
         */
        await infoTab.focus();
        const settingsTab = await openSettingsTab(running.page);
        await expect(settingsTab.locator('[data-agent-icon="unknown"]')).toBeVisible();
        await settingsTab.getByLabel('Default Agent').click();
        await running.page.getByRole('option', { name: 'Codex', exact: true }).click();
        await expect(
            settingsTab.locator('[data-slot="select-trigger"] [data-agent-icon="codex"]'),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
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
