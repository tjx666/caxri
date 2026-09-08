import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';

import type { E2EApp } from './support/electron-app.ts';
import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri } from './support/helpers.ts';

const ERROR_TITLE = 'File not found';
const SUCCESS_TITLE = 'Sent Esc and continue to Codex after a matched recovery rule.';
const PERSISTENT_TITLE =
    'The active worktree is no longer available. Returned to Fallback Project.';

async function publishServerEvent(app: E2EApp, event: ServerEvent): Promise<void> {
    await app.evaluate(({ BrowserWindow }, nextEvent) => {
        const window = BrowserWindow.getAllWindows().at(0);
        if (!window) throw new Error('Caxri window is unavailable');
        window.webContents.send('caxri:event', nextEvent);
    }, event);
}

async function keepDocumentVisible(page: Page): Promise<void> {
    /**
     * Hidden Electron windows make Sonner pause its timer. Keep the override page-local so this lifecycle test can use
     * the normal hidden E2E launch without changing the product or taking desktop focus.
     */
    await page.addInitScript(() => {
        Object.defineProperties(document, {
            hidden: {
                configurable: true,
                value: false,
            },
            visibilityState: {
                configurable: true,
                value: 'visible',
            },
        });
    });
    await page.evaluate(() => {
        Object.defineProperties(document, {
            hidden: {
                configurable: true,
                value: false,
            },
            visibilityState: {
                configurable: true,
                value: 'visible',
            },
        });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
}

function toastWithTitle(page: Page, title: string) {
    return page.locator('[data-sonner-toast]').filter({ hasText: title });
}

function settingsError(error: string): ServerEvent {
    return { event: 'settings.changed', payload: { source: '{}', error } };
}

test('Sonner notifications expire, dedupe, run actions, and stay keyboard-dismissible', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-toasts-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await keepDocumentVisible(running.page);
        await running.page.clock.install();

        await publishServerEvent(running.app, settingsError(ERROR_TITLE));
        await running.page.clock.runFor(1);
        const errorToast = toastWithTitle(running.page, ERROR_TITLE);
        await expect(errorToast).toBeVisible();
        await running.page.clock.fastForward(3_900);
        await expect(errorToast).toBeVisible();
        await running.page.clock.runFor(400);
        await expect(errorToast).toHaveCount(0);

        await publishServerEvent(running.app, settingsError(ERROR_TITLE));
        await running.page.clock.runFor(1);
        const dedupedToast = toastWithTitle(running.page, ERROR_TITLE);
        await expect(dedupedToast).toBeVisible();
        await running.page.clock.fastForward(3_500);
        await publishServerEvent(running.app, settingsError(ERROR_TITLE));
        await running.page.clock.runFor(1);
        await expect(running.page.locator('[data-sonner-toast]')).toHaveCount(1);
        await running.page.clock.fastForward(1_000);
        await expect(dedupedToast).toBeVisible();
        await running.page.clock.runFor(3_500);
        await expect(dedupedToast).toHaveCount(0);

        await publishServerEvent(running.app, {
            event: 'terminal.outputRecovery',
            payload: { provider: 'codex', status: 'recovered', terminalId: 'terminal-e2e' },
        });
        await running.page.clock.runFor(1);
        const successToast = toastWithTitle(running.page, SUCCESS_TITLE);
        await expect(successToast).toBeVisible();
        await successToast.getByRole('button', { name: 'Open Settings' }).press('Enter');
        const settingsDialog = running.page.getByRole('dialog');
        await expect(settingsDialog).toBeVisible();
        await running.page.clock.runFor(250);
        await expect(successToast).toHaveCount(0);
        await running.page.keyboard.press('Escape');
        await expect(settingsDialog).toHaveCount(0);

        await publishServerEvent(running.app, {
            event: 'workbench.changed',
            payload: {
                reason: 'fallback',
                returnedProjectTitle: 'Fallback Project',
                sessionId: 'session-e2e',
                workbenchProjectId: 'project-e2e',
            },
        });
        await running.page.clock.runFor(1);
        const persistentToast = toastWithTitle(running.page, PERSISTENT_TITLE);
        await expect(persistentToast).toBeVisible();
        await running.page.clock.runFor(4_100);
        await expect(persistentToast).toBeVisible();
        const closeButton = persistentToast.getByRole('button', {
            name: 'Dismiss notification',
        });
        await closeButton.focus();
        await expect(closeButton).toBeFocused();
        await closeButton.press('Enter');
        await running.page.clock.runFor(250);
        await expect(persistentToast).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
