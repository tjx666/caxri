import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from './fixtures.ts';

import { createShellSession, launchCaxri, typeTerminal } from './helpers.ts';

const execFileAsync = promisify(execFile);

/**
 * Smallest end-to-end health check: launch, create a Project+Session with a
 * shell Terminal, run a command, and see its output. This is the fast gate
 * behind `bun run test:smoke` — it is not a substitute for the full `bun run test:e2e` suite.
 */
test('smoke: launches, creates a shell Session, and runs a Terminal command', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-smoke-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        if (process.platform === 'darwin') {
            expect(await running.app.evaluate(() => process.title)).toBe('Caxri Dev');
        }
        await expect(
            running.page.getByRole('heading', { name: 'Project-first development.' }),
        ).toBeVisible();
        await createShellSession(running.page);
        await typeTerminal(running.page, 'echo caxri-smoke-ok');
        await expect(running.page.locator('.xterm-rows')).toContainText('caxri-smoke-ok');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
