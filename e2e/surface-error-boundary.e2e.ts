import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeClaudeChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    createShellSession,
    launchCaxri,
    VISIBLE_SESSION,
    VISIBLE_TERMINAL_INPUT,
} from './support/helpers.ts';
import { openSettingsPage } from './support/settings.ts';

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
        { source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 6 },
        { source: 'desktop', event: 'renderer.console_error', code: 'CONSOLE_ERROR', count: 6 },
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
        const settings = await openSettingsPage(page, { advanced: false });
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
        await page.keyboard.press('Escape');

        // Activity queue: the sidebar keeps its header and offers the way back to the Project tree.
        await page.evaluate((key) => sessionStorage.setItem(key, 'activity'), SURFACE_FAULT_KEY);
        await page.locator('.primary-sidebar-activity-toggle').click();
        const activityFailure = sidebar
            .getByRole('alert')
            .filter({ hasText: 'This part of the window could not be displayed.' });
        await expect(activityFailure).toBeVisible();
        await expect(crashHeading).toBeHidden();
        await activityFailure.getByRole('button', { name: 'Show Projects' }).click();
        await expect(activityFailure).toBeHidden();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * A render failure inside one composer strip section (goal, plan, delegated Sessions, background work, queue) shows an
 * inline fault row in the strip while the transcript and the message box stay mounted, with no reload.
 */
test('a composer strip section render failure leaves the transcript and message box mounted', async () => {
    // The caught render error is logged by React and again by the boundary; Main mirrors both.
    allowE2EErrors([
        { source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 2 },
        { source: 'desktop', event: 'renderer.console_error', code: 'CONSOLE_ERROR', count: 2 },
    ]);
    const created = await mkdtemp(join(tmpdir(), 'caxri-strip-boundary-e2e-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        // Armed before the Chat exists, so the first strip section that mounts takes the fault.
        await page.evaluate((key) => sessionStorage.setItem(key, 'chat-strip'), SURFACE_FAULT_KEY);
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const failure = chat
            .getByRole('alert')
            .filter({ hasText: 'This item could not be displayed.' });
        await expect(failure).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeHidden();
        // The message box still works: the Chat's own boundary did not take over.
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('still here');
        await message.press('Enter');
        await expect(chat.getByText('You said: still here')).toBeVisible();
        await failure.getByRole('button', { name: 'Retry' }).click();
        await expect(failure).toBeHidden();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
