import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, VISIBLE_TERMINAL_INPUT } from './support/helpers.ts';
import { openSettingsTab } from './support/settings.ts';

/**
 * Mirrors `SURFACE_FAULT_KEY` in the Renderer; the value names the surface scope whose first surface throws next.
 */
const SURFACE_FAULT_KEY = 'caxri.test.surface-fault';

/**
 * A render failure inside one surface (a Terminal pane, the Settings page) shows a local fallback with Retry while the
 * sidebar and the rest of the window stay interactive, instead of the window-level crash screen.
 */
test('a surface render failure stays local to its surface', async () => {
    // Per fault, React logs the caught render error and the boundary logs it again; Main mirrors both.
    allowE2EErrors([
        { source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 4 },
        { source: 'desktop', event: 'renderer.console_error', code: 'CONSOLE_ERROR', count: 4 },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-surface-boundary-e2e-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const userDataDirectory = join(directory, 'user-data');
    const agentMode = await createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: { codex: {} },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userDataDirectory,
        testRootPath: root,
    });
    const { page } = running;
    const crashHeading = page.getByRole('heading', { name: 'Something went wrong' });
    const sidebar = page.locator('.session-primary-sidebar');
    try {
        await createShellSession(page);

        // Terminal pane: armed after the window rendered, then reloaded so the pane mounts under the fault.
        await page.evaluate((key) => sessionStorage.setItem(key, 'terminal'), SURFACE_FAULT_KEY);
        await page.reload();
        const terminalFailure = page
            .getByRole('alert')
            .filter({ hasText: 'This part of the window could not be displayed.' });
        await expect(terminalFailure).toBeVisible();
        await expect(crashHeading).toBeHidden();
        await expect(sidebar).toBeVisible();
        await terminalFailure.getByRole('button', { name: 'Retry' }).click();
        await expect(terminalFailure).toBeHidden();
        await expect(page.locator(VISIBLE_TERMINAL_INPUT)).toBeVisible();

        // Settings page: the page header and navigation stay, only the content is replaced.
        await page.evaluate((key) => sessionStorage.setItem(key, 'settings'), SURFACE_FAULT_KEY);
        const settings = await openSettingsTab(page);
        const settingsFailure = settings
            .getByRole('alert')
            .filter({ hasText: 'This part of the window could not be displayed.' });
        await expect(settingsFailure).toBeVisible();
        await expect(crashHeading).toBeHidden();
        await expect(sidebar).toBeVisible();
        await expect(
            settings.getByRole('navigation', { name: 'Settings categories' }),
        ).toBeVisible();
        await settingsFailure.getByRole('button', { name: 'Retry' }).click();
        await expect(settingsFailure).toBeHidden();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
