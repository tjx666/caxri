import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import { GitPullRequestErrorMessage } from 'caxri';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('Git Pull Request mode shows committed PR changes instead of the working tree', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-pr-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const nested = join(root, 'nested');
    const bin = join(testDirectory, 'bin');
    await execFileAsync('mkdir', ['-p', root, bin]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    /**
     * The Server-wide GitHub projection keys records by `owner/repo`, so a pull-request read resolves `origin` before
     * it consults the shared store. A repository with no GitHub remote never reaches `gh` at all.
     */
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/project.git'],
        { cwd: root },
    );
    await writeFile(join(root, 'tracked.txt'), 'before\n', 'utf8');
    await writeFile(join(root, 'deleted-at-head.txt'), 'deleted first\ndeleted second\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt', 'deleted-at-head.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    const baseOid = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();
    await execFileAsync('git', ['switch', '-c', 'feature/pull-request'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'after\n', 'utf8');
    await writeFile(join(root, 'pr-only.txt'), 'pull request first\npull request second\n', 'utf8');
    await execFileAsync('git', ['rm', 'deleted-at-head.txt'], { cwd: root });
    await execFileAsync('git', ['add', 'tracked.txt', 'pr-only.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'pull request changes'], { cwd: root });
    const headOid = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();
    await writeFile(join(root, 'working-only.txt'), 'working tree\n', 'utf8');
    await execFileAsync('mkdir', ['-p', nested]);
    await execFileAsync('git', ['init', '-b', 'nested-main'], { cwd: nested });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: nested });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: nested });
    // A distinct slug so the nested repository gets its own record instead of joining the root repository's.
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/nested.git'],
        { cwd: nested },
    );
    await writeFile(join(nested, 'nested.txt'), 'nested\n', 'utf8');
    await execFileAsync('git', ['add', 'nested.txt'], { cwd: nested });
    await execFileAsync('git', ['commit', '-m', 'nested initial'], { cwd: nested });

    const gh = join(bin, 'gh');
    const refreshGate = join(testDirectory, 'refresh-gate');
    const refreshStarted = join(testDirectory, 'refresh-started');
    await writeFile(
        gh,
        `#!/bin/sh\nif [ -e '${refreshGate}' ]; then\n  touch '${refreshStarted}'\n  while [ -e '${refreshGate}' ]; do sleep 0.05; done\nfi\nprintf '%s' '${JSON.stringify(
            {
                baseRefName: 'main',
                baseRefOid: baseOid,
                headRefName: 'feature/pull-request',
                headRefOid: headOid,
                number: 42,
                title: 'Committed pull request range',
                url: 'https://github.com/tjx666/project/pull/42',
            },
        )}'\n`,
        'utf8',
    );
    await chmod(gh, 0o755);

    /**
     * The unrelated nested PR must fail offline, without contacting a real GitHub repository.
     */
    const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
    const git = join(bin, 'git');
    await writeFile(
        git,
        `#!/usr/bin/env node
// 为 Electron 固定测试拦截 fetch，其余 Git 操作交给真实 Git。
const { spawnSync } = require('node:child_process');
if (process.argv[2] === 'fetch') process.exit(1);
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
        'utf8',
    );
    await chmod(git, 0o755);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        /**
         * The deterministic gh fixture intentionally reports the root PR for every repository. Runtime rejects the root
         * OIDs in the unrelated nested repository; Git owns that raw-domain failure and projects it into inline
         * provider state, so the successful outer Source Control snapshot must not surface a second Main-process
         * error.
         */
        allowE2EErrors([
            { source: 'server-core', event: 'ipc.request_failed', code: 'GIT', count: 3 },
        ]);
        await createProjectSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const files = running.page.locator('.git-files');
        await expect(files.locator('.git-row[data-path="working-only.txt"]')).toBeVisible();

        // Scope every mode switch to its own toolbar: the repository group heading is also named
        // `Pull Request Changes` in that mode, so an unscoped role lookup matches two buttons.
        const modeSwitch = running.page.locator('.git-mode-switch');
        await modeSwitch.getByRole('button', { name: 'Pull Request Changes' }).click();
        // One group and no history: the repository row stands in for the `PR #42 Changes` caption.
        await expect(running.page.locator('.git-changes-caption')).toHaveCount(0);
        await expect(files.locator('.git-row[data-path="pr-only.txt"]')).toBeVisible();
        await expect(
            running.page.getByText(GitPullRequestErrorMessage.missingCommits, { exact: true }),
        ).toBeVisible();
        await running.page
            .locator('.git-repository-section')
            .last()
            .screenshot({
                path: test.info().outputPath('pr-missing-commits.png'),
            });
        await running.page.evaluate(() => {
            const heading = document.querySelector('.git-heading');
            let hasFlickered = false;
            const observer = new MutationObserver(() => {
                const repo = document.querySelector('[data-git-repository-id]');
                hasFlickered ||=
                    !heading?.isConnected ||
                    Boolean(repo?.querySelector('[aria-label="Loading pull request changes…"]'));
            });
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
            });
            Object.assign(globalThis, {
                stopModeFlickerObserver: () => {
                    observer.disconnect();
                    return hasFlickered;
                },
            });
        });
        await modeSwitch.getByRole('button', { name: 'Working Tree Changes', exact: true }).click();
        await expect(files.locator('.git-row[data-path="working-only.txt"]')).toBeVisible();
        await modeSwitch.getByRole('button', { name: 'Pull Request Changes', exact: true }).click();
        // One group and no history: the repository row stands in for the `PR #42 Changes` caption.
        await expect(running.page.locator('.git-changes-caption')).toHaveCount(0);
        await expect(files.locator('.git-row[data-path="pr-only.txt"]')).toBeVisible();
        await expect(
            modeSwitch.getByRole('button', { name: 'Pull Request Changes', exact: true }),
        ).toBeEnabled();
        expect(
            await running.page.evaluate(() =>
                (
                    globalThis as unknown as { stopModeFlickerObserver: () => boolean }
                ).stopModeFlickerObserver(),
            ),
        ).toBe(false);
        await running.page.screenshot({ path: test.info().outputPath('pr-mode-switch.png') });
        await expect(files.locator('.git-row[data-path="deleted-at-head.txt"]')).toBeVisible();
        await expect(files.locator('.git-row[data-path="tracked.txt"]')).toBeVisible();
        await expect(files.locator('.git-row[data-path="working-only.txt"]')).toHaveCount(0);
        await expect(
            running.page.getByText(GitPullRequestErrorMessage.missingCommits, { exact: true }),
        ).toBeVisible();
        await expect(running.page.locator('.toast')).toHaveCount(0);

        await files.locator('.git-row[data-path="tracked.txt"]').click();
        await expect(running.page.locator('.git-file-diff .monaco-diff-editor')).toBeVisible();
        await expect(running.page.locator('.git-file-diff')).toContainText('before');
        await expect(running.page.locator('.git-file-diff')).toContainText('after');

        await writeFile(refreshGate, 'pending', 'utf8');
        await running.page
            .getByRole('button', { name: 'Refresh Pull Request', exact: true })
            .click();
        await expect
            .poll(async () => {
                try {
                    await stat(refreshStarted);
                    return true;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                    throw error;
                }
            })
            .toBe(true);
        // One group and no history: the repository row stands in for the `PR #42 Changes` caption.
        await expect(running.page.locator('.git-changes-caption')).toHaveCount(0);
        await expect(files.locator('.git-row[data-path="tracked.txt"]')).toBeVisible();
        await running.page.screenshot({ path: test.info().outputPath('pr-refresh.png') });
        await rm(refreshGate);
        await expect(
            running.page.getByText(GitPullRequestErrorMessage.missingCommits, { exact: true }),
        ).toBeVisible();
        await expect(files.locator('.git-row[data-path="pr-only.txt"]')).toBeVisible();

        const diff = running.page.locator('.git-file-diff');
        await files.locator('.git-row[data-path="pr-only.txt"]').click();
        const addedEditor = diff.locator('.git-single-diff-editor');
        await expect(addedEditor).toBeVisible();
        await expect(diff.locator('.monaco-diff-editor')).toHaveCount(0);
        await expect(diff).toContainText('pull request first');
        await expect(diff).toContainText('pull request second');
        const addedLines = addedEditor.locator('.view-lines');
        const addedText = (await addedLines.textContent()) ?? '';
        await addedEditor.getByRole('textbox', { name: 'Added file contents' }).press('x');
        await expect(addedLines).toHaveText(addedText);
        await expect(diff.locator('.git-added-line')).not.toHaveCount(0);
        await expect(diff.locator('.git-deleted-line')).toHaveCount(0);
        await expect(diff.locator('.git-deleted-indicator')).toHaveCount(0);
        const addedIndicator = diff.locator('.git-added-indicator').first();
        await expect(addedIndicator).toBeAttached();
        expect(
            await addedIndicator.evaluate((element) =>
                getComputedStyle(element, '::before').content.replaceAll(/["']/g, ''),
            ),
        ).toBe('+');
        await diff.screenshot({ path: test.info().outputPath('git-pr-added-file-diff.png') });

        await files.locator('.git-row[data-path="deleted-at-head.txt"]').click();
        const deletedEditor = diff.locator('.git-single-diff-editor');
        await expect(deletedEditor).toBeVisible();
        await expect(diff.locator('.monaco-diff-editor')).toHaveCount(0);
        await expect(diff).toContainText('deleted first');
        await expect(diff).toContainText('deleted second');
        const deletedLines = deletedEditor.locator('.view-lines');
        const deletedText = (await deletedLines.textContent()) ?? '';
        await deletedEditor.getByRole('textbox', { name: 'Deleted file contents' }).press('x');
        await expect(deletedLines).toHaveText(deletedText);
        await expect(diff.locator('.git-deleted-line')).not.toHaveCount(0);
        await expect(diff.locator('.git-added-line')).toHaveCount(0);
        await expect(diff.locator('.git-added-indicator')).toHaveCount(0);
        const deletedIndicator = diff.locator('.git-deleted-indicator').first();
        await expect(deletedIndicator).toBeAttached();
        expect(
            await deletedIndicator.evaluate((element) =>
                getComputedStyle(element, '::before').content.replaceAll(/["']/g, ''),
            ),
        ).toBe('−');
        await diff.screenshot({ path: test.info().outputPath('git-pr-deleted-file-diff.png') });

        /**
         * Option-click is the app-wide recursive disclosure gesture, so the repository row collapses its folders with
         * it, and the pull-request page moved to Command-click (issue #1129). Pull Request mode folds its one group
         * into the repository row, so both gestures land there.
         */
        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & { caxriOpenedLinks?: string[] };
            target.caxriOpenedLinks = [];
            // github.com is untrusted in a fresh profile; answer the native prompt with "Open Once".
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
            shell.openExternal = (url) => {
                target.caxriOpenedLinks!.push(url);
                return Promise.resolve();
            };
        });
        const repo = running.page.locator('.git-repository-section').first();
        const header = repo.locator('.git-repository-row');
        await expect(header).toHaveAttribute('aria-expanded', 'true');
        await header.click({ modifiers: ['Alt'] });
        await expect(header).toHaveAttribute('aria-expanded', 'false');
        await expect(repo.locator('.git-files')).toHaveCount(0);
        await header.click({ modifiers: ['Meta'] });
        await expect(header).toHaveAttribute('aria-expanded', 'false');
        await expect
            .poll(() =>
                running.app.evaluate(
                    () =>
                        (globalThis as typeof globalThis & { caxriOpenedLinks?: string[] })
                            .caxriOpenedLinks ?? [],
                ),
            )
            .toContain('https://github.com/tjx666/project/pull/42');
        await header.click({ modifiers: ['Alt'] });
        await expect(header).toHaveAttribute('aria-expanded', 'true');
        await expect(repo.locator('.git-row[data-path="pr-only.txt"]')).toBeVisible();
    } finally {
        await rm(refreshGate, { force: true });
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
