import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    typeTerminal,
    VISIBLE_SESSION,
    waitForRuntimeReady,
} from './support/helpers.ts';

/**
 * Terminate and Close ends work, not the Server: the window reopened from the Dock attaches to the same Server Core,
 * whose Terminal Host must still launch the stopped Terminal again and start new ones.
 */
test('Terminate and Close stops the Terminal and the reopened window can run Terminals again', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminate-close-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await expect.poll(() => pageRequest<number>(running.page, 'terminal.runningCount')).toBe(1);
        const hostBefore = await pageRequest<{ pid: number }>(running.page, 'host.status');
        // The close prompt's buttons are Keep Running, Terminate and Close, Cancel.
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
        });
        const closed = running.page.waitForEvent('close');
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
        );
        await closed;
        await expect
            .poll(() =>
                running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
            )
            .toBe(0);

        const reopenedPromise = running.app.waitForEvent('window');
        await running.app.evaluate(({ app }) => app.emit('activate'));
        const reopened = await reopenedPromise;
        await waitForRuntimeReady(reopened);
        expect(await pageRequest<{ pid: number }>(reopened, 'host.status')).toMatchObject({
            pid: hostBefore.pid,
        });
        expect(await pageRequest<number>(reopened, 'terminal.runningCount')).toBe(0);

        const stopped = reopened.locator(`${VISIBLE_SESSION} [data-terminal-exit-state="stopped"]`);
        await stopped.getByRole('button', { name: 'Restart Terminal' }).click();
        await expect(stopped).toHaveCount(0);
        await expect.poll(() => pageRequest<number>(reopened, 'terminal.runningCount')).toBe(1);
        await typeTerminal(reopened, String.raw`printf 'TERMINATE_AND_CLOSE_RESTART_OK\n'`);
        await expect(reopened.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'TERMINATE_AND_CLOSE_RESTART_OK',
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
