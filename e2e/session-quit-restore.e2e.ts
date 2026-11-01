import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createShellSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';

interface BootstrapTerminals {
    selectedSessionId?: string;
    terminals: Array<{ id: string; lastProcessState?: string; sessionId: string }>;
}

async function processState(page: Page, terminalId: string): Promise<string | undefined> {
    const bootstrap = await pageRequest<BootstrapTerminals>(page, 'app.bootstrap');
    return bootstrap.terminals.find(({ id }) => id === terminalId)?.lastProcessState;
}

async function runPaletteCommand(page: Page, title: string): Promise<void> {
    await page.keyboard.press('Meta+Shift+P');
    const palette = page.getByRole('dialog');
    await palette.getByPlaceholder('Search projects, sessions, and commands…').fill(title);
    await palette.getByText(title, { exact: true }).click();
}

test('restores the Terminal a quit with Stop Tasks ended, once', async () => {
    const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-e2e-quit-restore-'));
    const testRootPath = join(userDataDirectory, 'project');
    await mkdir(testRootPath);
    try {
        // The default close answers the quit prompt with "Quit and Stop Tasks".
        const first = await launchCaxri({ userDataDir: userDataDirectory, testRootPath });
        let terminalId: string;
        try {
            await createShellSession(first.page);
            const bootstrap = await pageRequest<BootstrapTerminals>(first.page, 'app.bootstrap');
            const terminal = bootstrap.terminals.find(
                ({ sessionId }) => sessionId === bootstrap.selectedSessionId,
            );
            if (!terminal) throw new Error('The new Session has no Terminal');
            terminalId = terminal.id;
            await expect.poll(() => processState(first.page, terminalId)).toBe('running');
        } finally {
            await closeAppQuietly(first.app);
        }

        const second = await launchCaxri({ userDataDir: userDataDirectory, testRootPath });
        try {
            const { page } = second;
            expect(await processState(page, terminalId)).toBe('stopped');

            await runPaletteCommand(page, 'Restore Sessions Stopped at Last Quit');
            await expect(page.getByText('Restored 1 Session.')).toBeVisible();
            await expect.poll(() => processState(page, terminalId)).toBe('running');
            const evidence = test.info().outputPath('quit-restore-restored.png');
            await page.screenshot({ path: evidence });
            await test.info().attach('quit-restore-restored', {
                path: evidence,
                contentType: 'image/png',
            });

            // The restore consumed the record.
            await runPaletteCommand(page, 'Restore Sessions Stopped at Last Quit');
            await expect(
                page.getByText('No Sessions were stopped at the last quit.'),
            ).toBeVisible();
        } finally {
            await closeAppQuietly(second.app);
        }
    } finally {
        await rm(userDataDirectory, { recursive: true, force: true });
    }
});
