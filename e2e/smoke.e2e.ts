import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, typeTerminal } from './support/helpers.ts';

const packagedExecutable = process.env.CAXRI_PACKAGED_EXECUTABLE;

/**
 * Smallest end-to-end health check: launch, create a Project+Session with a shell Terminal, run a command, and see its
 * output. This is the fast gate behind `bun run test:smoke`; it is not a substitute for the full `bun run test:e2e`
 * suite.
 */
test('smoke: launches, creates a shell Session, and runs a Terminal command', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-smoke-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        if (packagedExecutable) {
            await running.app.evaluate(({ dialog }, projectRoot) => {
                dialog.showOpenDialog = () =>
                    Promise.resolve({ canceled: false, filePaths: [projectRoot] });
            }, root);
        }
        if (process.platform === 'darwin') {
            expect(await running.app.evaluate(() => process.title)).toBe(
                packagedExecutable ?? 'Caxri Dev',
            );
            if (!packagedExecutable) {
                expect(await running.app.evaluate(({ app }) => app.getName())).toBe(
                    'Caxri Desktop',
                );
            }
        }
        await expect(
            running.page.getByRole('heading', { name: 'Project-first development.' }),
        ).toBeVisible();
        await createShellSession(running.page);
        await typeTerminal(running.page, 'echo caxri-smoke-ok');
        await expect(running.page.locator('.xterm-rows')).toContainText('caxri-smoke-ok');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
