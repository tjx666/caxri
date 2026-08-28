import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

test('Git disclosure state survives Secondary Side Bar tab switches', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-source-control-disclosure-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'before\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'after\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const gitTab = running.page.getByRole('tab', { name: 'Git', exact: true });
        const statusTab = running.page.getByRole('tab', { name: 'Status', exact: true });
        await gitTab.click();

        const changes = running.page
            .locator('.git-repository-section')
            .getByRole('button', { name: 'Changes', exact: true });
        await expect(changes).toHaveAttribute('aria-expanded', 'true');
        await changes.click();
        await expect(changes).toHaveAttribute('aria-expanded', 'false');

        await statusTab.click();
        await expect(statusTab).toHaveAttribute('aria-selected', 'true');
        await gitTab.click();
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await expect(
            running.page
                .locator('.git-repository-section')
                .getByRole('button', { name: 'Changes', exact: true }),
        ).toHaveAttribute('aria-expanded', 'false');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
