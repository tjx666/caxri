import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';

/**
 * A Session restored from the Archived Sessions dialog has to land where the user is looking. Returning it to the
 * position it held before archiving drops it back into the middle of a long list, so the restore the user just asked
 * for produces nothing they can see (#957). Reopen Closed Item is the deliberate exception: it reverses a single
 * archive, and promoting there would let one accidental archive rewrite an order built by dragging.
 */
test('a restored Session goes to the top while Reopen Closed Item puts it back in place', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-restore-order-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        const oldest = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const middle = await selectedSessionId(running.page);
        await pageRequest(running.page, 'session.rename', {
            sessionId: middle,
            title: 'Middle',
        });
        await createAdditionalShellSession(running.page);
        const newest = await selectedSessionId(running.page);
        const sidebarOrder = () =>
            running.page
                .locator('aside .session-card')
                .evaluateAll((cards) =>
                    cards.map((card) => (card as HTMLElement).dataset.sessionId),
                );
        await expect.poll(sidebarOrder).toEqual([newest, middle, oldest]);

        // The bottom row is the one whose restore stays invisible when it returns to its old position.
        const oldestRow = sessionCard(running.page, oldest).locator('..');
        await oldestRow.hover();
        await oldestRow.getByRole('button', { name: /^Archive / }).click();
        await expect.poll(sidebarOrder).toEqual([newest, middle]);

        await running.page.locator('aside .archived-sessions-entry').click();
        const dialog = running.page.getByRole('dialog');
        await dialog.getByRole('button', { name: /^Restore / }).click();
        await dialog.getByRole('button', { name: 'Done' }).click();
        await expect(dialog).toHaveCount(0);
        await expect.poll(sidebarOrder).toEqual([oldest, newest, middle]);

        const middleRow = sessionCard(running.page, middle).locator('..');
        await middleRow.hover();
        await middleRow.getByRole('button', { name: /^Archive / }).click();
        await expect.poll(sidebarOrder).toEqual([oldest, newest]);
        // Archiving raises no notice; Reopen Closed Item is how it is taken back.
        await expect(running.page.locator('[data-sonner-toast]')).toHaveCount(0);
        await running.page.keyboard.press('Meta+Shift+T');
        await expect.poll(sidebarOrder).toEqual([oldest, newest, middle]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
