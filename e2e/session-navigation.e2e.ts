import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
    VISIBLE_TERMINAL_INPUT,
} from './support/helpers.ts';

test('Session history navigates back and forward from the PrimarySidebar header and the shortcut', async () => {
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
        const terminalInput = running.page.locator(VISIBLE_TERMINAL_INPUT).last();
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
         * so they are dispatched over raw CDP, which is also the closest thing to a real device event available here.
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
         * that dialog editing a Session the user can no longer see. Settings itself is a page, not a modal (issue
         * caxri#2369: a Session switch closes it, since the user asked to see that Session). The Archived Sessions
         * manager is still a real `Dialog` reachable straight from the PrimarySidebar, so it stands in here as the
         * modal this gesture must still stand down behind.
         */
        // Re-selecting the Session already on screen is a no-op that leaves the shortcut a non-editable focus target.
        await sessionCard(running.page, sessionA).click();
        await running.page.locator('aside .archived-sessions-entry').click();
        const archivedDialog = running.page.getByRole('dialog');
        await expect(archivedDialog).toBeVisible();
        await pressSideButton('back');
        await expect(archivedDialog).toBeVisible();

        /**
         * `session.select` is serialized by the Runtime while `app.bootstrap` is not, so reading the selection straight
         * after the gesture could still observe the state from before a leaked navigation. Selecting a Session through
         * that same queue is the barrier (it cannot resolve until a leaked selection has been applied) and it also
         * makes the two worlds diverge durably, because a leaked Back would have dropped the forward entries first.
         */
        await pageRequest(running.page, 'session.select', { sessionId: sessionC });
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionC);
        // The Runtime having applied the selection is not enough: the next Back is computed from the Renderer's own
        // history, which only learns about this Session once the PrimarySidebar has rendered it as the selected one.
        await expect(
            running.page.locator(
                `.session-card[aria-selected="true"][data-session-id="${sessionC}"]`,
            ),
        ).toBeVisible();

        // Base UI's own Dialog handles Escape internally, outside the app's `runCommand`/`isModalOpen` gate, so this
        // still closes the dialog even though it is the very thing that gate is guarding against.
        await running.page.keyboard.press('Escape');
        await expect(archivedDialog).toBeHidden();
        await pressSideButton('back');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionA);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
