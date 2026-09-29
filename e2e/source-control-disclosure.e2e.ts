import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

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
    await execFileAsync('mkdir', ['-p', join(root, '.agents', 'acceptance', 'references')]);
    await writeFile(
        join(root, '.agents', 'acceptance', 'references', 'dev-server.md'),
        'new file\n',
        'utf8',
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const gitTab = running.page.getByRole('tab', { name: 'Git', exact: true });
        const statusTab = running.page.getByRole('tab', { name: 'Status', exact: true });
        await gitTab.click();

        const repo = running.page.locator('.git-repository-section');
        const changes = repo.getByRole('treeitem', { name: 'Changes', exact: true });
        await expect(changes).toHaveAttribute('aria-expanded', 'true');
        const agents = repo.getByRole('treeitem', { name: '.agents', exact: true });
        const acceptance = repo.getByRole('treeitem', { name: 'acceptance', exact: true });
        const references = repo.getByRole('treeitem', { name: 'references', exact: true });
        await expect(references).toHaveAttribute('aria-expanded', 'true');
        await expect(repo.locator('[data-disclosure="git-directory"]')).toHaveCount(0);

        await agents.click({ modifiers: ['Alt'] });
        await expect(agents).toHaveAttribute('aria-expanded', 'false');
        await expect(acceptance).toHaveCount(0);

        await agents.click();
        await expect(acceptance).toHaveAttribute('aria-expanded', 'false');
        await expect(references).toHaveCount(0);
        await agents.click();
        await agents.click({ modifiers: ['Alt'] });
        await expect(references).toHaveAttribute('aria-expanded', 'true');
        await expect(repo.getByText('dev-server.md', { exact: true })).toBeVisible();

        await changes.click();
        await expect(changes).toHaveAttribute('aria-expanded', 'false');

        await statusTab.click();
        await expect(statusTab).toHaveAttribute('aria-selected', 'true');
        await gitTab.click();
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await expect(
            running.page
                .locator('.git-repository-section')
                .getByRole('treeitem', { name: 'Changes', exact: true }),
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

test('Source Control keeps its caption and recovery action without a repository', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-source-control-empty-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const panel = running.page.locator('.git-panel');
        await expect(panel.getByText('Source Control', { exact: true })).toBeVisible();
        await expect(panel.getByText('No Session selected')).toBeVisible();
        await expect(panel.getByText('No Session selected')).toHaveAttribute('tabindex', '0');
        await expect(panel.getByRole('button', { name: 'Refresh Source Control' })).toBeDisabled();

        await createShellSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        await expect(panel.getByText('Source Control', { exact: true })).toBeVisible();
        await expect(panel.getByText('No Git repository')).toBeVisible();
        await expect(panel.getByText('No Git repository')).toHaveAttribute('tabindex', '0');
        await expect(panel.getByText('This Project root is not a repository yet.')).toBeVisible();
        await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(panel.getByText('No Git repository')).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Refresh Source Control' })).toBeEnabled();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Source Control reports a Git failure without calling the Project a non-repository', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-source-control-failure-e2e-'));
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    await mkdir(root);
    await mkdir(bin);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    const git = join(bin, 'git');
    await writeFile(
        git,
        '#!/bin/sh\n# 用于测试模拟 Git 命令失败，不修改仓库状态。\nprintf "simulated Git failure\\n" >&2\nexit 1\n',
    );
    await chmod(git, 0o755);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
    });
    try {
        await createShellSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const panel = running.page.locator('.git-panel');
        await expect(panel.getByText('Source Control', { exact: true })).toBeVisible();
        await expect(panel.getByText('Git is not available')).toBeVisible();
        await expect(panel.getByText('Git is not available')).toHaveAttribute('tabindex', '0');
        await expect(
            panel.getByText('Source Control is unavailable right now.', { exact: false }),
        ).toBeVisible();
        await expect(panel.getByText('No Git repository')).toHaveCount(0);
        await panel.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(panel.getByText('Git is not available')).toBeVisible();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Source Control explains an Xcode license block and recovers after Retry', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-source-control-license-e2e-'));
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    await mkdir(root);
    await mkdir(bin);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    const git = join(bin, 'git');
    await writeFile(
        git,
        '#!/bin/sh\n# 用于模拟 Xcode 许可阻塞，仅修改临时测试目录。\nprintf "You have not agreed to the Xcode license agreements. Please run sudo xcodebuild -license\\n" >&2\nexit 69\n',
    );
    await chmod(git, 0o755);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
    });
    try {
        await createShellSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const panel = running.page.locator('.git-panel');
        await expect(panel.getByText('Git is not available')).toBeVisible();
        await expect(
            panel.getByText('Run sudo xcodebuild -license in Terminal', { exact: false }),
        ).toBeVisible();
        await expect(panel.getByText('No Git repository')).toHaveCount(0);

        await rm(git);
        const retry = panel.getByRole('button', { name: 'Retry', exact: true });
        const repo = panel.locator('.git-repository-section');
        /**
         * The failed snapshot's change event queues follow-up refreshes. One of them can start after `rm(git)` and
         * recover the panel on its own: Retry turns disabled for that fetch and then unmounts, so a plain `click()`
         * waits out its timeout on a button that no longer exists (https://github.com/tjx666/caxri/issues/1418).
         * Recovery is the contract; Retry is clicked whenever it is still offered and enabled.
         */
        await expect(async () => {
            if ((await retry.count()) > 0 && (await retry.isEnabled()))
                await retry.click({ timeout: 1_000 });
            await expect(repo).toBeVisible({ timeout: 1_000 });
        }).toPass();
        await expect(panel.getByText('Git is not available')).toHaveCount(0);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
