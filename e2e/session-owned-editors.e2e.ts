import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    sessionCard,
    VISIBLE_SESSION,
    waitForSourceControlReady,
} from './support/helpers.ts';

async function prepareRepo(root: string, content: string): Promise<void> {
    await mkdir(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'committed\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), content);
}

test('kept-alive Git diff editors keep their own Session across Project switches', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-owned-editors-e2e-'));
    const roots = [join(testDirectory, 'alpha'), join(testDirectory, 'beta')];
    await prepareRepo(roots[0], 'alpha change\n');
    await prepareRepo(roots[1], 'beta change\n');
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: roots[0],
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    });
    try {
        const { page } = running;
        const alphaSession = await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        await waitForSourceControlReady(page);
        await page
            .locator('.git-repository-section')
            .getByRole('treeitem', { name: 'tracked.txt', exact: true })
            .click();
        await expect(page.locator(`${VISIBLE_SESSION} .git-file-diff`)).toBeVisible();

        const betaSession = await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        await waitForSourceControlReady(page);
        await page
            .locator('.git-repository-section')
            .getByRole('treeitem', { name: 'tracked.txt', exact: true })
            .click();
        await expect(page.locator(`${VISIBLE_SESSION} .git-file-diff`)).toBeVisible();

        await sessionCard(page, alphaSession).click();
        await expect(page.locator(`${VISIBLE_SESSION} .git-file-diff`)).toBeVisible();
        await sessionCard(page, betaSession).click();
        await expect(page.locator(`${VISIBLE_SESSION} .git-file-diff`)).toBeVisible();

        await waitForSourceControlReady(page);
        await page
            .locator('.git-repository-section')
            .getByRole('treeitem', { name: 'tracked.txt', exact: true })
            .click({ modifiers: ['Alt'] });
        await expect(page.locator(`${VISIBLE_SESSION} .git-file-diff`)).toHaveCount(0);
        await expect(
            page.locator(`${VISIBLE_SESSION} .monaco-editor:visible .view-lines`),
        ).toContainText('beta change');
        await sessionCard(page, alphaSession).click();
        await expect(page.locator(`${VISIBLE_SESSION} .git-file-diff`)).toBeVisible();
        await sessionCard(page, betaSession).click();
        await expect(page.locator(`${VISIBLE_SESSION} .git-file-diff`)).toHaveCount(0);
        await expect(
            page.locator(`${VISIBLE_SESSION} .monaco-editor:visible .view-lines`),
        ).toContainText('beta change');
        await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
        await page.screenshot({
            path: test.info().outputPath('session-owned-editor.png'),
            mask: [page.locator(`${VISIBLE_SESSION} .xterm`)],
        });
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
