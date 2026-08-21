import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';

test('Session history navigates back and forward from the Sidebar header and the shortcut', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-navigation-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const sessionA = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const sessionB = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const sessionC = await selectedSessionId(running.page);

        const back = running.page.locator('[data-session-history="back"]');
        const forward = running.page.locator('[data-session-history="forward"]');
        await expect(back).toBeEnabled();
        await expect(forward).toBeDisabled();

        /**
         * The shortcut has to fire with a Terminal focused: switching Sessions is precisely what the user wants while
         * an Agent holds the keyboard, so this is the binding's real usage, not an edge case.
         */
        const terminalInput = running.page.locator('.xterm-helper-textarea').last();
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();
        await running.page.keyboard.press('Control+Alt+ArrowLeft');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);
        await expect(forward).toBeEnabled();

        await running.page.keyboard.press('Control+Alt+ArrowLeft');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionA);
        await expect(back).toBeDisabled();

        await forward.click();
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);
        await expect(back).toBeEnabled();

        await running.page.keyboard.press('Control+Alt+ArrowRight');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionC);
        await expect(forward).toBeDisabled();

        await back.click();
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);
        await expect(forward).toBeEnabled();

        // An ordinary selection truncates the forward history, exactly like following a link in a browser.
        await sessionCard(running.page, sessionA).click();
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionA);
        await expect(forward).toBeDisabled();
        await expect(back).toBeEnabled();

        /**
         * The two extra mouse buttons drive the same history. Playwright's `mouse` API only models left/right/middle,
         * so they are dispatched over raw CDP — which is also the closest thing to a real device event available here.
         */
        const cdp = await running.page.context().newCDPSession(running.page);
        const pressSideButton = async (button: 'back' | 'forward'): Promise<void> => {
            const event = { button, clickCount: 1, x: 200, y: 200 };
            await cdp.send('Input.dispatchMouseEvent', {
                ...event,
                type: 'mousePressed',
                buttons: button === 'back' ? 8 : 16,
            });
            await cdp.send('Input.dispatchMouseEvent', {
                ...event,
                type: 'mouseReleased',
                buttons: 0,
            });
        };
        await pressSideButton('back');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);
        await pressSideButton('forward');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionA);

        /**
         * A global gesture must stand down behind a modal: switching the Session underneath an open dialog would leave
         * that dialog editing a Session the user can no longer see.
         */
        // Re-selecting the Session already on screen is a no-op that leaves the shortcut a non-editable focus target.
        await sessionCard(running.page, sessionA).click();
        await running.page.keyboard.press('Meta+,');
        const settingsDialog = running.page.getByRole('dialog');
        await expect(settingsDialog).toBeVisible();
        await pressSideButton('back');
        await expect(settingsDialog).toBeVisible();
        expect(await selectedSessionId(running.page)).toBe(sessionA);

        await running.page.keyboard.press('Escape');
        await expect(settingsDialog).toBeHidden();
        await pressSideButton('back');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
