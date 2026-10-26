import { rm } from 'node:fs/promises';

import { connectToServer } from '@caxri/client/supervise';

import { expect, test } from './support/fixtures.ts';
import { closeAppQuietly, launchCaxri, sessionCard } from './support/helpers.ts';
import { finishTwoTurnsAway, launchWithChat } from './support/session-return-fixture.ts';

/**
 * Stops a Server Core the first launch preserved, when a failure left it running past the second launch. Best effort: a
 * Server that already stopped answers nothing to connect to.
 */
async function stopPreservedServer(userDataDirectory: string): Promise<void> {
    let client: Awaited<ReturnType<typeof connectToServer>> | undefined;
    try {
        client = await connectToServer(userDataDirectory, 2_000);
        await client.request('host.stop', { confirmLivePtys: true });
    } catch {
        // Already stopped.
    } finally {
        client?.close();
    }
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the return hint survives a Desktop restart', async ({}, testInfo) => {
    // Server Core records the boundary only while a visible window holds OS focus, and keeps the Chat's turns across
    // the restart; only the boundary has to be durable.
    const { directory, launchOptions, running } = await launchWithChat({
        preserveHostOnClose: true,
        windowMode: 'visible',
    });
    let second: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    try {
        const chatId = await finishTwoTurnsAway(running.page);
        await running.app.close();

        // The second launch stops Server Core when it closes, so the test leaves nothing running.
        second = await launchCaxri({ ...launchOptions, preserveHostOnClose: false });
        await sessionCard(second.page, chatId).click();
        const hint = second.page.getByRole('status').filter({ hasText: 'new replies' });
        await expect(hint).toContainText('2 new replies');
        await second.page.screenshot({
            path: testInfo.outputPath('return-hint-after-restart.png'),
        });
    } finally {
        if (second) await closeAppQuietly(second.app);
        await closeAppQuietly(running.app);
        await stopPreservedServer(launchOptions.userDataDir);
        await rm(directory, { recursive: true, force: true });
    }
});
