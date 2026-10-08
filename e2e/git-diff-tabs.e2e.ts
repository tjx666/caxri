import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    clickGitFileAction,
    clickGitGroupAction,
    createProjectSession,
    launchCaxri,
    pageRequest,
    waitForSourceControlReady,
} from './support/helpers.ts';

// Duplicated instead of imported: E2E runs against the packaged app and must not pull Renderer modules into the test
// process, which is how every other spec carries Renderer copy. `git-diff-resolution.test.ts` pins the constant to this
// exact string, so a reword breaks there first instead of only in CI.
const resolvedDiffReason =
    'This file no longer differs from what the diff compared. The change was committed or undone.';

const trackedCommitted = 'alpha\nbeta\ngamma\ndelta\n';
const trackedWorking = 'alpha\nbeta-changed\ngamma\ndelta\n';

test('Discard All Changes resolves the working diff in place without an error notification', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-discard-diff-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), trackedCommitted);
    await writeFile(join(root, 'sibling.txt'), 'sibling\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), trackedWorking);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        await repo
            .getByRole('treeitem', { name: 'tracked.txt', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        await repo.getByRole('treeitem', { name: 'tracked.txt', exact: true }).click();
        await expect(page.locator('.git-file-diff')).toBeVisible();
        const diffBreadcrumb = page.getByRole('button', {
            name: 'Browse tracked.txt',
            exact: true,
        });
        await diffBreadcrumb.click();
        await expect(
            page
                .getByRole('listbox', { name: 'Contents of Project root' })
                .getByRole('option', { name: 'sibling.txt', exact: true }),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(diffBreadcrumb).toBeFocused();
        await page.keyboard.press('Escape');
        await expect
            .poll(() =>
                page
                    .locator('.git-file-diff .monaco-diff-editor')
                    .evaluate((editor) => editor.contains(document.activeElement)),
            )
            .toBe(true);
        // The repository-wide destructive action stays out of sight until its caption row is hovered or focused, the
        // way VS Code hides `.resource-group > .actions`. `clickGitGroupAction` reveals it either way, so without this
        // line a regression that left the whole toolbar on screen would pass everywhere.
        await expect(repo.locator('.git-discard-all')).toBeHidden();
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
        });
        await clickGitGroupAction(repo, 'Discard All Changes');
        await expect(page.locator('.git-file-diff')).toBeVisible();
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        await clickGitGroupAction(repo, 'Discard All Changes');
        await expect(repo.getByText('Working tree clean.', { exact: true })).toBeVisible();
        // The tab survives its own diff being discarded. Closing it was how a background commit could make a document
        // the user was reading vanish without a word, so the surface now says what happened and leaves the close to
        // the user (`git-diff-resolution.ts` owns the wording).
        await expect(
            page.locator('[data-pane-tab-id]').filter({ hasText: 'tracked.txt' }),
        ).toHaveCount(1);
        await expect(page.locator('.git-file-diff')).toHaveCount(0);
        await expect(page.getByText(resolvedDiffReason, { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeVisible();
        await expect(page.getByText('Git change no longer exists', { exact: true })).toHaveCount(0);
        await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
        await page.screenshot({
            path: test.info().outputPath('discard-resolved-diff.png'),
            mask: [page.locator('.xterm')],
        });

        await writeFile(join(root, 'tracked.txt'), trackedWorking);
        await repo
            .getByRole('treeitem', { name: 'tracked.txt', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        await repo.getByRole('treeitem', { name: 'tracked.txt', exact: true }).click();
        await expect(page.locator('.git-file-diff')).toBeVisible();
        await clickGitFileAction(repo, 'tracked.txt', 'Discard changes in tracked.txt');
        await expect(repo.getByText('Working tree clean.', { exact: true })).toBeVisible();
        await expect(page.getByText(resolvedDiffReason, { exact: true })).toBeVisible();
        await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);

        /**
         * The same resolution inside the stacked Changes view. Two honest outcomes are possible and which one lands is
         * a race: the row can only carry the notice while the repository summary still lists the file, so if that
         * refresh wins the whole list reports a clean tree instead. Both are accepted. What must never come back is the
         * third outcome this fix removed: the file heading still on screen above an empty box, which reads as a
         * rendering failure rather than as news about the file.
         */
        await writeFile(join(root, 'tracked.txt'), trackedWorking);
        await clickGitGroupAction(repo, 'Open Changes');
        const stackedItem = page.locator('.git-multi-diff-item').filter({ hasText: 'tracked.txt' });
        await expect(stackedItem.locator('.monaco-diff-editor')).toBeVisible();
        await clickGitFileAction(repo, 'tracked.txt', 'Discard changes in tracked.txt');
        await expect
            .poll(async () => {
                if ((await stackedItem.count()) === 0)
                    return (await page
                        .locator('.empty-work', { hasText: 'Working tree clean.' })
                        .count()) > 0
                        ? 'clean'
                        : 'missing';
                return (await stackedItem.getByText(resolvedDiffReason, { exact: true }).count()) >
                    0
                    ? 'resolved'
                    : 'blank';
            })
            .toMatch(/^(clean|resolved)$/);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('A Source Control action that loses the race to a background refresh still runs against the fresh model', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-superseded-action-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), trackedCommitted);
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), trackedWorking);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        await repo
            .getByRole('treeitem', { name: 'tracked.txt', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        // A snapshot the Renderer did not ask for stands in for a watcher refresh that reaches the provider between the
        // click and the action: it advances the provider's model revision while the panel still holds the old one.
        const bootstrap = await pageRequest<{
            selectedSessionId: string;
            sessions: Array<{ id: string; workbenchProjectId: string }>;
        }>(page, 'app.bootstrap');
        const session = bootstrap.sessions.find(({ id }) => id === bootstrap.selectedSessionId)!;
        await pageRequest(page, 'viewContainers.viewOperation', {
            viewId: 'caxri.git.sourceControl',
            operation: 'source.snapshot',
            arguments: { refresh: 0 },
            requestId: 'e2e-background-refresh',
            context: {
                kind: 'session',
                sessionId: session.id,
                workbenchProjectId: session.workbenchProjectId,
            },
        });
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        await clickGitGroupAction(repo, 'Discard All Changes');
        await expect(repo.getByText('Working tree clean.', { exact: true })).toBeVisible();
        await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('A Source Control click that lands while the panel is refreshing runs once the refresh completes', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-refreshing-action-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), trackedCommitted);
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), trackedWorking);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        await repo
            .getByRole('treeitem', { name: 'tracked.txt', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        /**
         * A watcher refresh can start between Playwright's readiness check and its click, which is how CI lost a
         * discard: the click landed mid-refresh and was dropped. Clicking inside the same task that observes the tree
         * turn busy makes that window deterministic.
         */
        const clickedWhileBusy = await page.evaluate(
            () =>
                new Promise<boolean>((resolve) => {
                    const tree = document.querySelector('.git-repositories[role="tree"]')!;
                    const discard = document.querySelector<HTMLButtonElement>(
                        'button[aria-label="Discard changes in tracked.txt"]',
                    )!;
                    const observer = new MutationObserver(() => {
                        if (tree.getAttribute('aria-busy') !== 'true') return;
                        observer.disconnect();
                        discard.click();
                        resolve(true);
                    });
                    observer.observe(tree, { attributeFilter: ['aria-busy'] });
                    document
                        .querySelector<HTMLButtonElement>('button[aria-label="Refresh Git"]')!
                        .click();
                }),
        );
        expect(clickedWhileBusy).toBe(true);
        await expect(repo.getByText('Working tree clean.', { exact: true })).toBeVisible();
        await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Diff view options control layout, unchanged regions, and whitespace across tabs', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-diff-options-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    const lines = Array.from({ length: 80 }, (_, index) => `const line${index} = ${index};`);
    await writeFile(join(root, 'layout.ts'), `${lines.join('\n')}\n`);
    await writeFile(join(root, 'whitespace.ts'), 'const value = 1;\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    lines[40] = 'const changed = true;';
    await writeFile(join(root, 'layout.ts'), `${lines.join('\n')}\n`);
    await writeFile(join(root, 'whitespace.ts'), '  const value = 1;  \n');
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const page = running.page;
        await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        await repo
            .getByRole('treeitem', { name: 'layout.ts', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        await repo.getByRole('treeitem', { name: 'layout.ts', exact: true }).click();
        const diff = page.locator('.git-file-diff');
        await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
        await page.getByRole('button', { name: 'Diff View Options', exact: true }).click();
        await page.getByRole('switch', { name: 'Inline View', exact: true }).check();
        await page.getByRole('switch', { name: 'Collapse Unchanged Regions', exact: true }).check();
        await page.keyboard.press('Escape');
        await expect(diff.locator('.editor.modified')).toContainText('const line40 = 40;');
        await expect(diff.locator('.editor.modified')).toContainText('const changed = true;');
        await expect(diff.getByText('37 hidden lines', { exact: true }).first()).toBeVisible();
        await diff.screenshot({ path: test.info().outputPath('inline-collapsed.png') });
        await page.getByRole('button', { name: 'Diff View Options', exact: true }).click();
        await page.getByRole('switch', { name: 'Inline View', exact: true }).uncheck();
        await page
            .getByRole('switch', { name: 'Collapse Unchanged Regions', exact: true })
            .uncheck();
        await page.keyboard.press('Escape');
        await expect(diff.locator('.editor.modified')).not.toContainText('const line40 = 40;');
        await expect(diff.locator('.diff-hidden-lines')).toHaveCount(0);
        await repo
            .getByRole('treeitem', { name: 'whitespace.ts', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        await repo.getByRole('treeitem', { name: 'whitespace.ts', exact: true }).click();
        const next = page.getByRole('button', { name: 'Next Change', exact: true });
        await expect(next).toBeDisabled();
        await page.getByRole('button', { name: 'Diff View Options', exact: true }).click();
        await page
            .getByRole('switch', {
                name: 'Show Leading/Trailing Whitespace Differences',
                exact: true,
            })
            .check();
        await page.keyboard.press('Escape');
        await expect(next).toBeEnabled();
        await expect(diff.locator('.line-insert')).not.toHaveCount(0);
        await diff.screenshot({ path: test.info().outputPath('whitespace-differences.png') });
        await clickGitGroupAction(repo, 'Open Changes');
        await page.getByRole('button', { name: 'Diff View Options', exact: true }).click();
        await expect(
            page.getByRole('switch', {
                name: 'Show Leading/Trailing Whitespace Differences',
                exact: true,
            }),
        ).toBeChecked();
        await page.getByRole('switch', { name: 'Inline View', exact: true }).check();
        await page.getByRole('switch', { name: 'Collapse Unchanged Regions', exact: true }).check();
        await page.keyboard.press('Escape');
        const stacked = page.locator('.git-multi-diff .monaco-diff-editor').first();
        await expect(stacked).toBeVisible();
        await expect(stacked.locator('.editor.modified')).toContainText('const line40 = 40;');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * Two working diff tabs in one pane share the pane's single Editor slot. The regression this guards let Monaco keep the
 * diff widget it was first mounted with, so re-selecting the tracked tab recomputed its diff against the untracked
 * tab's empty original and rendered the whole file as removed.
 */
test('Switching between two working diff tabs keeps each diff pointed at its own file', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-diff-tabs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.ts'), trackedCommitted, 'utf8');
    await execFileAsync('git', ['add', 'tracked.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'tracked.ts'), trackedWorking, 'utf8');
    await writeFile(join(root, 'fresh.ts'), 'fresh-one\nfresh-two\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const page = running.page;
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        await expect(repo.getByRole('treeitem', { name: 'Changes', exact: true })).toBeVisible();

        const diff = page.locator('.git-file-diff');
        const original = diff.locator('.monaco-diff-editor .editor.original');
        const modified = diff.locator('.monaco-diff-editor .editor.modified');
        const deletedLines = diff.locator('.monaco-diff-editor .line-delete');
        const trackedTab = page.getByRole('tab', { name: 'tracked.ts', exact: true });
        const freshTab = page.getByRole('tab', { name: 'fresh.ts', exact: true });

        const expectTrackedDiff = async (): Promise<void> => {
            await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
            await expect(original).toContainText('alpha');
            await expect(original).toContainText('beta');
            await expect(original).toContainText('gamma');
            await expect(original).not.toContainText('beta-changed');
            await expect(original).not.toContainText('fresh-one');
            await expect(modified).toContainText('beta-changed');
            /**
             * Inline layout duplicates the removed line in its gutter; side-by-side layout has one overlay. Either way
             * only one source line changed. A stale model pair instead marks every line of the file removed.
             */
            await expect.poll(() => deletedLines.count()).toBeGreaterThan(0);
            await expect.poll(() => deletedLines.count()).toBeLessThanOrEqual(2);
        };
        const expectFreshDiff = async (): Promise<void> => {
            await expect(diff).toContainText('fresh-one');
            await expect(diff).toContainText('fresh-two');
            await expect(diff).not.toContainText('alpha');
            /**
             * An absent original must not appear as a deleted blank line.
             */
            await expect(diff.locator('.line-delete')).toHaveCount(0);
            await expect(diff.locator('.git-added-line')).not.toHaveCount(0);
            await expect(
                page.getByRole('button', { name: 'Next Change', exact: true }),
            ).toBeEnabled();
            await page.getByRole('button', { name: 'Next Change', exact: true }).click();
            await expect(diff.getByRole('textbox', { name: 'Added file contents' })).toBeFocused();
        };

        await repo
            .getByRole('treeitem', { name: 'tracked.ts', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        await repo.getByRole('treeitem', { name: 'tracked.ts', exact: true }).click();
        await expect(trackedTab).toBeVisible();
        await expectTrackedDiff();

        await repo
            .getByRole('treeitem', { name: 'fresh.ts', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        await repo.getByRole('treeitem', { name: 'fresh.ts', exact: true }).click();
        await expect(freshTab).toBeVisible();
        await expectFreshDiff();

        /**
         * VS Code parity: the change the Git view lists also paints the tab that holds the file. Both tabs above are
         * still located by their bare filename, which is the other half of the contract: the status letter is
         * `aria-hidden` so a decorated tab is never renamed to "tracked.ts M".
         */
        await expect(trackedTab.locator('.tab-label')).toHaveClass(/text-git-modified/);
        await expect(trackedTab.locator('.status-modified')).toHaveText('M');
        await expect(trackedTab).toHaveAccessibleDescription('Git: modified.');
        await expect(freshTab.locator('.tab-label')).toHaveClass(/text-git-untracked/);
        await expect(freshTab.locator('.status-untracked')).toHaveText('?');

        await trackedTab.click();
        await expectTrackedDiff();

        await freshTab.click();
        await expectFreshDiff();

        await page.setViewportSize({ width: 1000, height: 700 });
        await expectFreshDiff();
        await diff.screenshot({ path: test.info().outputPath('added-file-narrow.png') });

        await page.setViewportSize({ width: 1800, height: 1000 });
        await expectFreshDiff();
        await diff.screenshot({ path: test.info().outputPath('added-file-wide.png') });

        await trackedTab.click();
        await expectTrackedDiff();

        /**
         * A live file can cross between two-sided and all-deleted without changing its tab identity.
         */
        await writeFile(join(root, 'tracked.ts'), '', 'utf8');
        await expect(diff).toContainText('alpha');
        await expect(diff.locator('.git-deleted-line')).not.toHaveCount(0);
        await expect(diff.locator('.line-insert, .git-added-line')).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: 'Previous Change', exact: true }),
        ).toBeEnabled();
        await page.getByRole('button', { name: 'Previous Change', exact: true }).click();
        await expect(diff.getByRole('textbox', { name: 'Deleted file contents' })).toBeFocused();
        await diff.screenshot({ path: test.info().outputPath('emptied-file.png') });

        await writeFile(join(root, 'tracked.ts'), trackedWorking, 'utf8');
        await expectTrackedDiff();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Opening a diff lands on the first change instead of the top of the file', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-diff-first-change-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    /**
     * The change sits far past any plausible viewport, which is the whole failure: a diff that opens at line 1 renders
     * none of it, so the file reads as unchanged. Monaco virtualizes lines, so an unreached change is absent from the
     * DOM rather than merely scrolled out of view.
     */
    const lines = Array.from({ length: 400 }, (_, index) => `const line${index} = ${index};`);
    await writeFile(join(root, 'long.ts'), `${lines.join('\n')}\n`, 'utf8');
    await execFileAsync('git', ['add', 'long.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(
        join(root, 'long.ts'),
        `${lines.with(389, 'const line389 = 389 + 1;').join('\n')}\n`,
        'utf8',
    );

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        await repo
            .getByRole('treeitem', { name: 'long.ts', exact: true })
            .waitFor({ state: 'visible' });
        await waitForSourceControlReady(page);
        await repo.getByRole('treeitem', { name: 'long.ts', exact: true }).click();
        const diff = page.locator('.git-file-diff');
        await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
        const insertedLine = diff.locator('.monaco-diff-editor .editor.modified .line-insert');
        await expect(insertedLine.first()).toBeInViewport();
        await expect(diff.locator('.editor.modified')).toContainText('const line389 = 389 + 1;');
        await page.screenshot({
            path: test.info().outputPath('diff-first-change.png'),
            mask: [page.locator('.xterm')],
        });
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
