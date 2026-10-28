import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';

import type { E2EApp } from './support/electron-app.ts';
import type { Page } from './support/fixtures.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest } from './support/helpers.ts';

const ERROR_TITLE = 'Automatic recovery paused for Codex after 3 attempts in 10 minutes.';
const SUCCESS_TITLE = 'Sent Esc and continue to Codex after a matched recovery rule.';
const FALLBACK_TITLE = 'The active worktree is no longer available. Returned to Fallback Project.';

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

/**
 * An error notification that expires on its own. A settings load error no longer qualifies: it stays until the file is
 * fixed or the user dismisses it, so a broken settings file cannot go unnoticed.
 */
const recoveryPaused: ServerEvent = {
    event: 'terminal.outputRecovery',
    payload: { provider: 'codex', status: 'rate-limited', terminalId: 'terminal-e2e' },
};

test('Sonner notifications expire, dedupe, run actions, and stay keyboard-dismissible', async () => {
    // The repeated error updates its mounted notification; only two error notifications are created.
    allowE2EErrors([{ source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 2 }]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-toasts-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const terminalInput = running.page.locator('.xterm-helper-textarea').first();
        await terminalInput.focus();
        await keepDocumentVisible(running.page);
        await running.page.clock.install();

        await publishServerEvent(running.app, recoveryPaused);
        await running.page.clock.runFor(1);
        const errorToast = toastWithTitle(running.page, ERROR_TITLE);
        await expect(errorToast).toBeVisible();
        await errorToast.getByRole('button', { name: 'Dismiss notification' }).focus();
        await running.page.clock.fastForward(3_900);
        await expect(errorToast).toBeVisible();
        await running.page.clock.runFor(400);
        await expect(errorToast).toHaveCount(0);
        await expect(terminalInput).toBeFocused();

        await publishServerEvent(running.app, recoveryPaused);
        await running.page.clock.runFor(1);
        const dedupedToast = toastWithTitle(running.page, ERROR_TITLE);
        await expect(dedupedToast).toBeVisible();
        await running.page.clock.fastForward(3_500);
        await publishServerEvent(running.app, recoveryPaused);
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
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `[data-settings-page]` is the
        // replacement scope for the former `role="dialog"` query. Keyboard focus must still follow the action into
        // the opened tab (its search field) instead of being stranded on the removed toast.
        const settingsTab = running.page.locator('[data-settings-page]');
        await expect(settingsTab).toBeVisible();
        await expect(settingsTab.getByLabel('Search settings')).toBeFocused();
        await expect(successToast).toHaveCount(0);
        await running.page.keyboard.press('Meta+w');
        await expect(settingsTab).toHaveCount(0);

        await publishServerEvent(running.app, {
            event: 'workbench.changed',
            payload: {
                reason: 'fallback',
                returnedProjectTitle: 'Fallback Project',
                sessionId: 'session-e2e',
                workbenchRootProjectId: 'project-e2e',
            },
        });
        await running.page.clock.runFor(1);
        const persistentToast = toastWithTitle(running.page, FALLBACK_TITLE);
        await expect(persistentToast).toBeVisible();
        await persistentToast.getByRole('button', { name: 'Notification options' }).focus();
        await running.page.keyboard.press('Enter');
        const muteButton = running.page.getByRole('button', {
            name: "Don't show this type again",
            exact: true,
        });
        await muteButton.hover();
        await running.page.clock.runFor(3_000);
        await expect(persistentToast).toBeVisible();
        await running.page.clock.runFor(10_000);
        await expect(muteButton).toBeVisible();
        await persistentToast.hover();
        await running.page.keyboard.press('Escape');
        await running.page.clock.runFor(250);
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

test('Notification center mutes a type, persists preferences, and restores reminders', async () => {
    allowE2EErrors([{ source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 }]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-notifications-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const fallback: ServerEvent = {
        event: 'workbench.changed',
        payload: {
            reason: 'fallback',
            returnedProjectTitle: 'Fallback Project',
            sessionId: 'session-e2e',
            workbenchRootProjectId: 'project-e2e',
        },
    };
    let running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await publishServerEvent(running.app, fallback);
        const reminder = toastWithTitle(running.page, FALLBACK_TITLE);
        await expect(reminder).toBeVisible();
        await reminder.getByRole('button', { name: 'Notification options' }).click();
        await running.page
            .getByRole('button', { name: "Don't show this type again", exact: true })
            .click();
        await expect(reminder).toHaveCount(0);
        await publishServerEvent(running.app, fallback);
        await running.page.getByRole('button', { name: 'Notifications', exact: true }).click();
        const center = running.page.getByRole('dialog', { name: 'Notifications', exact: true });
        await expect(center.getByText(FALLBACK_TITLE, { exact: true })).toBeVisible();
        await expect(center.getByText('2 occurrences')).toBeVisible();
        await expect(center.getByText('Muted', { exact: true })).toBeVisible();
        await expect(reminder).toHaveCount(0);
        await running.page.keyboard.press('Escape');
        await expect(center).toHaveCount(0);

        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await publishServerEvent(running.app, fallback);
        await running.page.getByRole('button', { name: 'Notifications', exact: true }).click();
        const restoredCenter = running.page.getByRole('dialog', {
            name: 'Notifications',
            exact: true,
        });
        await expect(restoredCenter.getByText('Muted', { exact: true })).toBeVisible();
        await expect(toastWithTitle(running.page, FALLBACK_TITLE)).toHaveCount(0);
        await restoredCenter
            .getByRole('button', { name: 'Notification settings', exact: true })
            .click();
        // Settings is a Workbench tab now, not a modal (issue caxri#1289).
        const settings = running.page.locator('[data-settings-page]');
        await expect(
            settings.getByRole('heading', { name: 'General', exact: true }),
        ).not.toBeInViewport();
        await expect(
            settings.getByRole('heading', { name: 'Notifications', exact: true }),
        ).toBeInViewport();
        const toggle = settings.getByRole('switch', {
            name: 'Worktree fallback reminders',
            exact: true,
        });
        await expect(toggle).not.toBeChecked();
        await toggle.click();
        await expect(toggle).toBeChecked();
        await expect
            .poll(async () => pageRequest(running.page, 'settings.get'))
            .toMatchObject({ value: { 'notifications.worktreeFallback': true } });
        await running.page.keyboard.press('Meta+w');
        await expect(settings).toHaveCount(0);
        await publishServerEvent(running.app, fallback);
        await expect(toastWithTitle(running.page, FALLBACK_TITLE)).toBeVisible();
        await publishServerEvent(running.app, recoveryPaused);
        await running.page
            .locator('footer')
            .getByRole('button', { name: /^Notifications/ })
            .click();
        const finalCenter = running.page.getByRole('dialog', {
            name: 'Notifications',
            exact: true,
        });
        await expect(finalCenter.getByText(ERROR_TITLE, { exact: true })).toBeVisible();
        await finalCenter
            .getByRole('button', { name: 'Clear all notifications', exact: true })
            .click();
        await expect(finalCenter.getByText('No recent notifications')).toBeVisible();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
