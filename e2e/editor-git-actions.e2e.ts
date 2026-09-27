import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

test('Editor title actions open the file last-commit and pull-request diffs', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-git-actions-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
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
    const before = Array.from({ length: 120 }, (_, index) => `unchanged line ${index + 1}`);
    before[9] = 'before first change';
    before[99] = 'before second change';
    await writeFile(join(root, 'tracked.txt'), `${before.join('\n')}\n`, 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    const baseOid = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();

    await execFileAsync('git', ['switch', '-c', 'feature/editor-actions'], { cwd: root });
    const after = [...before];
    after[9] = 'after first change';
    after[99] = 'after second change';
    await writeFile(join(root, 'tracked.txt'), `${after.join('\n')}\n`, 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'change tracked file'], { cwd: root });
    const fileHeadOid = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();

    // Advance repository HEAD through an unrelated commit so the first action proves it follows the file's own last
    // commit rather than whichever commit happens to be at the branch tip.
    await writeFile(join(root, 'other.txt'), 'other\n', 'utf8');
    await execFileAsync('git', ['add', 'other.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'change another file'], { cwd: root });
    const headOid = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();

    const gh = join(bin, 'gh');
    await writeFile(
        gh,
        `#!/bin/sh\nprintf '%s' '${JSON.stringify({
            baseRefName: 'main',
            baseRefOid: baseOid,
            headRefName: 'feature/editor-actions',
            headRefOid: headOid,
            number: 42,
            title: 'Editor title actions',
            url: 'https://github.com/tjx666/project/pull/42',
        })}'\n`,
        'utf8',
    );
    await chmod(gh, 0o755);

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'tracked.txt', exact: true }).click();
        // The same `git.fileHead` read that used to drive the editor header annotation now only gates this action, so
        // its appearance is what says the file's last commit has resolved.
        await expect(
            running.page.getByRole('button', { name: 'Open Last Commit Changes' }),
        ).toBeVisible();

        // File actions are about the active Editor, not about switching tabs, so they remain after the initial Terminal
        // is closed and this file becomes the Workbench's only tab.
        const terminalTab = running.page.locator('.work-tab[data-terminal-id]');
        await terminalTab.hover();
        await terminalTab.getByRole('button', { name: 'Close Terminal' }).click();
        await expect(running.page.locator('.work-tab')).toHaveCount(1);
        const lastCommit = running.page.getByRole('button', {
            name: 'Open Last Commit Changes',
        });
        const pullRequest = running.page.getByRole('button', {
            name: 'Open Pull Request Changes',
        });
        await expect(lastCommit).toBeVisible();
        await expect(pullRequest).toBeVisible();

        const copyTabPaths = async (tabName: string): Promise<void> => {
            const tab = running.page.getByRole('tab', { name: tabName, exact: true }).first();
            await tab.click({ button: 'right' });
            await chooseContextMenuItem(running.app, 'Copy Path');
            const absolutePath = await realpath(join(root, 'tracked.txt'));
            await expect.poll(() => running.clipboard.textEquals(absolutePath)).toBe(true);
            await running.clipboard.claimText(absolutePath);
            await tab.click({ button: 'right' });
            await chooseContextMenuItem(running.app, 'Copy Relative Path');
            await expect.poll(() => running.clipboard.textEquals('tracked.txt')).toBe(true);
            await running.clipboard.claimText('tracked.txt');
        };
        await copyTabPaths('tracked.txt');

        // This file is now the Workbench's only tab, which renders no close button — closing it would just swap it for
        // the empty pane. `cmd+w` is the affordance that stays.
        await running.page.keyboard.press('Meta+w');
        await expect(running.page.locator('.work-tab')).toHaveCount(0);
        await running.page.getByRole('treeitem', { name: 'tracked.txt', exact: true }).click();
        await expect(lastCommit).toBeVisible();
        await expect(pullRequest).toBeVisible();

        await lastCommit.hover();
        await expect(running.page.locator('.tooltip-popup[data-open]')).toHaveText(
            'Open Last Commit Changes',
        );
        await lastCommit.click();
        await expect(
            running.page.getByRole('tab', {
                name: `tracked.txt (${fileHeadOid.slice(0, 7)})`,
                exact: true,
            }),
        ).toBeVisible();
        await expect(running.page.locator('.git-file-diff .monaco-diff-editor')).toBeVisible();
        await expect(running.page.locator('.git-file-diff')).toContainText('before');
        await expect(running.page.locator('.git-file-diff')).toContainText('after');
        await copyTabPaths(`tracked.txt (${fileHeadOid.slice(0, 7)})`);
        const nextChange = running.page.getByRole('button', { name: 'Next Change', exact: true });
        const previousChange = running.page.getByRole('button', {
            name: 'Previous Change',
            exact: true,
        });
        await expect(nextChange).toBeEnabled();
        await expect(previousChange).toBeEnabled();
        const modifiedLines = running.page.locator('.git-file-diff .modified .view-line');
        await modifiedLines.filter({ hasText: /^unchanged\s+line\s+1$/ }).click();
        await nextChange.click();
        await nextChange.click();
        await expect(modifiedLines.filter({ hasText: 'after second change' })).toBeInViewport();
        await previousChange.click();
        await expect(modifiedLines.filter({ hasText: 'after first change' })).toBeInViewport();
        await running.page.getByRole('button', { name: 'Open Current File', exact: true }).click();
        await expect(
            running.page.getByRole('tab', { name: 'tracked.txt', exact: true }).first(),
        ).toHaveAttribute('aria-selected', 'true');
        /**
         * The file opens where the diff was being read. `after first change` is line 10, and the diff surface publishes
         * no editor status of its own, so landing here proves the caret travelled from the diff editor rather than the
         * file tab defaulting to its first line. See issue #1147.
         */
        await expect(running.page.getByLabel(/^Editor position: Ln 10, Col /)).toBeVisible();
        await expect(nextChange).toHaveCount(0);

        await running.page.getByRole('tab', { name: 'tracked.txt', exact: true }).first().click();
        await pullRequest.click();
        await expect(running.page.locator('.git-file-diff .monaco-diff-editor')).toBeVisible();
        await expect(running.page.locator('.git-file-diff')).toContainText('before');
        await expect(running.page.locator('.git-file-diff')).toContainText('after');

        await running.page.getByRole('tab', { name: 'tracked.txt', exact: true }).first().click();
        await running.page
            .getByRole('combobox', { name: 'Switch branch from feature/editor-actions' })
            .click();
        await running.page.getByRole('option', { name: /^main / }).click();
        await expect(
            running.page.getByRole('combobox', { name: 'Switch branch from main' }),
        ).toBeVisible();
        await lastCommit.click();
        await expect(
            running.page.getByRole('tab', {
                name: `tracked.txt (${baseOid.slice(0, 7)})`,
                exact: true,
            }),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
