import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

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

test('offers at launch to restore the Terminal a quit with Stop Tasks ended, once', async () => {
    const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-e2e-quit-restore-'));
    const testRootPath = join(userDataDirectory, 'project');
    await mkdir(testRootPath);
    try {
        // The default close answers the quit prompt with "Quit and Stop Tasks".
        const first = await launchCaxri({ userDataDir: userDataDirectory, testRootPath });
        let terminalId: string;
        try {
            await createShellSession(first.page);
            // Nothing was stopped before this launch, so there is nothing to offer.
            await expect(first.page.getByText(/stopped at the last quit\b/u)).toHaveCount(0);
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

            const notice = page
                .locator('[data-sonner-toast]')
                .filter({ hasText: /1 Session was stopped at the last quit, .+\./ });
            await expect(notice).toBeVisible();
            await notice.getByRole('button', { name: 'Restore', exact: true }).click();
            await expect(page.getByText('Restored 1 Session.')).toBeVisible();
            await expect(notice).toHaveCount(0);
            await expect.poll(() => processState(page, terminalId)).toBe('running');
            const evidence = test.info().outputPath('quit-restore-restored.png');
            await page.screenshot({ path: evidence });
            await test.info().attach('quit-restore-restored', {
                path: evidence,
                contentType: 'image/png',
            });

            // The restore consumed the record.
            await runPaletteCommand(page, 'Restore Sessions Stopped at Last Quit');
            await expect(page.getByText('Nothing left to restore.')).toBeVisible();
        } finally {
            await closeAppQuietly(second.app);
        }
    } finally {
        await rm(userDataDirectory, { recursive: true, force: true });
    }
});

test('restores what Restart to Update stopped on the next start, without asking', async () => {
    const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-e2e-update-restore-'));
    const testRootPath = join(userDataDirectory, 'project');
    await mkdir(testRootPath);
    try {
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

        /**
         * Restart to Update needs a staged bundle and relaunches outside Playwright, so the stop is a plain "Quit and
         * Stop Tasks" whose record is then marked the way `terminal.terminateAll` with `reason: 'update'` writes it.
         * Desktop Main's choice of that reason is covered by `app-quit.test.ts`.
         */
        const database = new Database(join(userDataDirectory, 'caxri.db'));
        try {
            const row = database
                .prepare<[], { value_json: string }>(
                    "SELECT value_json FROM app_state WHERE key = 'quitStoppedSessions'",
                )
                .get();
            if (!row) throw new Error('The quit recorded nothing to restore');
            const record = JSON.parse(row.value_json) as Record<string, unknown>;
            database
                .prepare("UPDATE app_state SET value_json = ? WHERE key = 'quitStoppedSessions'")
                .run(JSON.stringify({ ...record, restartedForUpdate: true }));
        } finally {
            database.close();
        }

        const second = await launchCaxri({ userDataDir: userDataDirectory, testRootPath });
        try {
            const { page } = second;
            await expect.poll(() => processState(page, terminalId)).toBe('running');
            // The start claimed the record, so the launch notice never offers it.
            await expect(page.getByText(/stopped at the last quit\b/u)).toHaveCount(0);
            const evidence = test.info().outputPath('update-restore-restored.png');
            await page.screenshot({ path: evidence });
            await test.info().attach('update-restore-restored', {
                path: evidence,
                contentType: 'image/png',
            });
            await runPaletteCommand(page, 'Restore Sessions Stopped at Last Quit');
            await expect(page.getByText('Nothing left to restore.')).toBeVisible();
        } finally {
            await closeAppQuietly(second.app);
        }
    } finally {
        await rm(userDataDirectory, { recursive: true, force: true });
    }
});
