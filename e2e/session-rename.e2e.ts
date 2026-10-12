import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
    waitForRuntimeReady,
} from './support/helpers.ts';
import {
    chooseContextMenuItem,
    expectNoContextMenu,
    isContextMenuItemEnabled,
} from './support/native-context-menu.ts';

/**
 * Closes the Electron app during teardown without letting an already-closed app fail the test.
 */
async function closeAppQuietly(app: E2EApp): Promise<void> {
    try {
        await app.close();
    } catch {
        // The app may already be gone; teardown has nothing left to do.
    }
}

test('Session inline rename validates input and survives Renderer reload', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-rename-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const sessionId = await selectedSessionId(running.page);
        const card = sessionCard(running.page, sessionId);
        const restingHeight = (await card.boundingBox())?.height;
        const titleLeft = await card
            .locator('.session-title')
            .evaluate((element) => element.getBoundingClientRect().left);
        await card.dblclick();
        const input = card.getByRole('textbox', { name: 'Rename Untitled' });
        await expect(input).toBeFocused();
        // The input swaps in for the title line without resizing the row or shifting the text: a `flex-1` inside the
        // column once crushed it to 16px and shrank the row by 4px.
        expect((await card.boundingBox())?.height).toBe(restingHeight);
        expect(
            await input.evaluate((element) => ({
                height: element.getBoundingClientRect().height,
                textLeft:
                    element.getBoundingClientRect().left +
                    element.clientLeft +
                    Number(getComputedStyle(element).paddingLeft.replace('px', '')),
            })),
        ).toEqual({ height: 24, textLeft: titleLeft });
        expect(
            await input.evaluate((element) => ({
                end: (element as HTMLInputElement).selectionEnd,
                start: (element as HTMLInputElement).selectionStart,
                value: (element as HTMLInputElement).value,
            })),
        ).toEqual({ end: 8, start: 0, value: 'Untitled' });

        // The renaming row hides the hover Pin/Archive actions; they would cover the editor's right edge.
        await card.hover();
        await expect(
            running.page.locator('.session-row', { has: card }).locator('.session-row-actions'),
        ).toHaveCount(0);

        await input.fill(' '.repeat(3));
        await input.press('Enter');
        await expect(input).toHaveAttribute('aria-invalid', 'true');
        await expect(card.getByRole('alert')).toHaveText('Session name is required');
        await input.press('Escape');
        await expect(card.locator('strong')).toHaveText('Untitled');
        await expect(card).toBeFocused();

        await card.press('Enter');
        const blurInput = card.getByRole('textbox', { name: 'Rename Untitled' });
        await blurInput.fill('Blurred investigation');
        const filesTab = running.page.getByRole('tab', { name: 'Files', exact: true });
        await filesTab.click();
        await expect(card.getByRole('textbox')).toHaveCount(0);
        await expect(card.locator('strong')).toHaveText('Blurred investigation');
        await expect(filesTab).toBeFocused();

        await card.focus();
        await card.press('Enter');
        const emptyBlurInput = card.getByRole('textbox', {
            name: 'Rename Blurred investigation',
        });
        await emptyBlurInput.fill(' '.repeat(3));
        await filesTab.click();
        await expect(card.getByRole('textbox')).toHaveCount(0);
        await expect(card.locator('strong')).toHaveText('Blurred investigation');
        await expect(filesTab).toBeFocused();

        // Rename with AI needs an Agent conversation to name. A Shell Session offers neither the `Shift+Enter` gesture
        // nor the editor's AI button, rather than an action that can only fail into a toast.
        await card.focus();
        await expect(card).not.toHaveAttribute('aria-keyshortcuts', /Shift\+Enter/u);
        await card.press('Shift+Enter');
        await expect(card.getByRole('textbox')).toHaveCount(0);
        await card.press('Enter');
        const suggestInput = card.getByRole('textbox', { name: 'Rename Blurred investigation' });
        await expect(suggestInput).toBeFocused();
        await expect(
            card.getByRole('button', { name: 'Rename Blurred investigation with AI' }),
        ).toHaveCount(0);
        await suggestInput.press('Escape');
        await expect(card.locator('strong')).toHaveText('Blurred investigation');

        await card.focus();
        await card.press('Enter');
        const keyboardInput = card.getByRole('textbox', {
            name: 'Rename Blurred investigation',
        });
        await keyboardInput.fill('Manual investigation');
        await keyboardInput.press('Enter');
        await expect(card.locator('strong')).toHaveText('Manual investigation');
        await expect(card).toBeFocused();
        const state = await pageRequest<{
            sessions: Array<{ displayTitle: string; id: string; titleMode: string }>;
        }>(running.page, 'app.bootstrap');
        expect(state.sessions.find((session) => session.id === sessionId)).toMatchObject({
            displayTitle: 'Manual investigation',
            titleMode: 'manual',
        });

        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect(sessionCard(running.page, sessionId).locator('strong')).toHaveText(
            'Manual investigation',
        );
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * Enter already has coverage; the context menu's `Rename` had none, which is how #950 could be reported against a
 * shipped build with nothing to contradict it. The menu closes as the row swaps itself for the input, so this asserts
 * the input still holds focus once the popup is gone, the exact handoff a focus restore aimed at the unmounted trigger,
 * or a trap still alive through the exit animation, would break.
 */
test('The Session context menu renames a selected and an unselected row', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-rename-menu-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        const firstSessionId = await selectedSessionId(page);
        await createAdditionalShellSession(page);
        const secondSessionId = await selectedSessionId(page);
        expect(secondSessionId).not.toBe(firstSessionId);

        const selectedCard = sessionCard(page, secondSessionId);
        await selectedCard.click({ button: 'right' });
        expect(await isContextMenuItemEnabled(running.app, 'Rename')).toBe(true);
        /**
         * A real menu hands keyboard focus back to the window as it closes. The choice is delivered only after that
         * (issue #1348), so the input it opens keeps focus and plain typing, with no click into the field first,
         * replaces the selected title.
         */
        await chooseContextMenuItem(running.app, 'Rename', { refocusOnClose: true });
        const selectedInput = selectedCard.getByRole('textbox', { name: 'Rename Untitled' });
        await expect(selectedInput).toBeFocused();
        await expectNoContextMenu(running.app);
        await expect(selectedInput).toBeFocused();
        expect(
            await selectedInput.evaluate((element) => ({
                end: (element as HTMLInputElement).selectionEnd,
                start: (element as HTMLInputElement).selectionStart,
            })),
        ).toEqual({ end: 8, start: 0 });
        await page.keyboard.type('Renamed from the menu');
        await expect(selectedInput).toHaveValue('Renamed from the menu');
        await selectedInput.press('Enter');
        await expect(selectedCard.locator('strong')).toHaveText('Renamed from the menu');

        /**
         * An unselected row must reach the same state without the click first having to select it, and cancelling must
         * hand focus back without the ring that stands for keyboard navigation the user never performed.
         */
        const unselectedCard = sessionCard(page, firstSessionId);
        await unselectedCard.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Rename');
        const unselectedInput = unselectedCard.getByRole('textbox', { name: 'Rename Untitled' });
        await expect(unselectedInput).toBeFocused();
        await unselectedInput.press('Escape');
        await expect(unselectedCard.getByRole('textbox')).toHaveCount(0);
        await expect(unselectedCard.locator('strong')).toHaveText('Untitled');
        await expect(unselectedCard).toBeFocused();
        expect(await unselectedCard.evaluate((element) => element.matches(':focus-visible'))).toBe(
            false,
        );
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Activity renames the selected Session from the palette and an unselected row from its menu', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-activity-rename-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        const firstSessionId = await selectedSessionId(page);
        await createAdditionalShellSession(page);
        const secondSessionId = await selectedSessionId(page);
        await page.getByRole('button', { name: 'Show Activity' }).click();
        const activity = page.getByRole('tree', { name: 'Activity' });
        const selectedRow = activity.locator(`[data-session-id="${secondSessionId}"]`);
        const unselectedRow = activity.locator(`[data-session-id="${firstSessionId}"]`);

        await page.keyboard.press('Meta+Shift+P');
        const palette = page.getByRole('dialog', { name: 'Command Palette' });
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Rename Session');
        // The option's accessible name continues with its description, so anchor the title and exclude the
        // sibling `Rename Session with AI` command instead of matching the whole name exactly.
        await palette.getByRole('option', { name: /^Rename Session(?! with AI)/ }).click();
        const selectedInput = selectedRow.getByRole('textbox', { name: 'Rename Untitled' });
        await expect(selectedInput).toBeFocused();
        await expect(unselectedRow.getByRole('textbox')).toHaveCount(0);
        expect(
            await selectedInput.evaluate((element) => ({
                end: (element as HTMLInputElement).selectionEnd,
                start: (element as HTMLInputElement).selectionStart,
            })),
        ).toEqual({ end: 8, start: 0 });
        await selectedInput.fill('Activity renamed');
        await selectedInput.press('Enter');
        await expect(selectedRow).toContainText('Activity renamed');

        await unselectedRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Rename');
        const unselectedInput = unselectedRow.getByRole('textbox', { name: 'Rename Untitled' });
        await expect(unselectedInput).toBeFocused();
        await unselectedInput.fill('Should be cancelled');
        /**
         * The row's hover delay must not give a hidden detail card ownership of Escape.
         */
        await page.waitForTimeout(600);
        await unselectedInput.press('Escape');
        await expect(unselectedRow).toContainText('Untitled');
        await expect(unselectedRow.getByRole('textbox')).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
