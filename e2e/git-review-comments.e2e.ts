import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    clickGitGroupAction,
    createProjectSession,
    launchCaxri,
    waitForSourceControlReady,
} from './support/helpers.ts';

test('Git diff review comments collect across files and reach one Agent Terminal', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-review-comments-e2e-'));
    const root = join(testDirectory, 'project');
    const userData = join(testDirectory, 'user-data');
    const capture = join(testDirectory, 'agent-input.txt');
    await mkdir(root, { recursive: true });
    await writeFile(capture, '');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'first.txt'), 'first\noriginal\nlast\n');
    await writeFile(join(root, 'second.txt'), 'one\noriginal\nthree\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'first.txt'), 'first\nchanged first\nlast\n');
    await writeFile(join(root, 'second.txt'), 'one\nchanged second\nthree\n');
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { inputCapture: { path: capture, encoding: 'raw' } } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'codex');
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        await repo
            .getByRole('treeitem', { name: 'first.txt', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        await repo.getByRole('treeitem', { name: 'first.txt', exact: true }).click();
        const single = page.locator('.git-file-diff .editor.modified');
        await expect(single).toBeVisible();
        await single.locator('.view-line').filter({ hasText: 'changed first' }).click();
        await page.keyboard.press('Meta+Shift+M');
        await page.getByRole('textbox', { name: 'Review comment' }).fill('Fix the first change');
        await page.getByRole('textbox', { name: 'Review comment' }).press('Meta+Enter');
        await expect(page.getByRole('button', { name: 'Send 1 comment to Agent' })).toBeVisible();

        await single.locator('.view-line').filter({ hasText: 'first' }).first().click();
        await page.keyboard.press('Meta+Shift+M');
        const draft = single.locator('.git-review-card').filter({ hasText: 'modified L1' });
        await draft.getByRole('textbox', { name: 'Review comment' }).fill('Keep this draft');
        await single.locator('.view-line').filter({ hasText: 'last' }).click();
        await page.keyboard.press('Meta+Shift+M');
        await expect(draft.getByRole('textbox', { name: 'Review comment' })).toHaveValue(
            'Keep this draft',
        );
        await single
            .locator('.git-review-card')
            .filter({ hasText: 'modified L3' })
            .getByRole('button', { name: 'Delete' })
            .click();
        await draft.getByRole('button', { name: 'Delete' }).click();

        await clickGitGroupAction(repo, 'Open Changes');
        const second = page.locator('.git-multi-diff-item').filter({ hasText: 'second.txt' });
        await expect(second.locator('.editor.modified')).toBeVisible();
        await second
            .locator('.editor.modified .view-line')
            .filter({ hasText: 'changed second' })
            .click();
        await page.keyboard.press('Meta+Shift+M');
        await page.getByRole('textbox', { name: 'Review comment' }).fill('Fix the second change');
        await page.getByRole('textbox', { name: 'Review comment' }).press('Meta+Enter');
        await expect(page.getByRole('button', { name: 'Send 2 comments to Agent' })).toBeVisible();
        await expect(second.locator('.git-review-card')).toContainText('Fix the second change');
        await page.screenshot({ path: test.info().outputPath('review-comments.png') });
        await page.getByRole('button', { name: 'Send 2 comments to Agent' }).click();
        const preview = page.getByRole('dialog', { name: 'Send review comments to Agent' });
        await expect(preview).toContainText('Fix the first change');
        await expect(preview).toContainText('Fix the second change');
        await preview.getByRole('button', { name: 'Send 2 comments' }).click();
        await expect.poll(async () => readFile(capture, 'utf8')).toContain('Fix the first change');
        await expect.poll(async () => readFile(capture, 'utf8')).toContain('Fix the second change');
        await page.getByRole('tab', { name: 'Changes: project' }).click();
        await expect(page.getByRole('button', { name: 'Send 0 comments to Agent' })).toBeDisabled();
        await expect(second.locator('.git-review-card')).toContainText('sent');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Review comments become outdated after a changed line and survive a missing Agent', async () => {
    allowE2EErrors([{ source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 }]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-review-outdated-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'one\noriginal\nthree\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'one\nchanged\nthree\n');
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        await repo.getByRole('treeitem', { name: 'tracked.txt', exact: true }).click();
        const modified = page.locator('.git-file-diff .editor.modified');
        await modified.locator('.view-line').filter({ hasText: 'changed' }).click();
        await page.keyboard.press('Meta+Shift+M');
        await page.getByRole('textbox', { name: 'Review comment' }).fill('Keep the old behavior');
        await page.getByRole('textbox', { name: 'Review comment' }).press('Meta+Enter');
        await page.getByRole('button', { name: 'Send 1 comment to Agent' }).click();
        await page
            .getByRole('dialog', { name: 'Send review comments to Agent' })
            .getByRole('button', { name: 'Send 1 comment' })
            .click();
        await expect(page.getByText('No running Agent Terminal in this Session')).toBeVisible();
        await page.screenshot({
            path: test.info().outputPath('missing-agent.png'),
            mask: [page.locator('.xterm')],
        });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Send 1 comment to Agent' })).toBeEnabled();
        await writeFile(join(root, 'tracked.txt'), 'one\nchanged again\nthree\n');
        await page.getByRole('button', { name: 'Refresh Git', exact: true }).click();
        await expect(page.locator('.git-review-card')).toContainText('outdated');
        await expect(page.getByRole('button', { name: 'Send 0 comments to Agent' })).toBeDisabled();
        await page.screenshot({
            path: test.info().outputPath('outdated-comment.png'),
            mask: [page.locator('.xterm')],
        });
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
