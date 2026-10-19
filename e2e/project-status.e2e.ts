import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import type { MessageBoxOptions } from 'electron';

import { expect, test } from './support/fixtures.ts';
import type { RunningCaxri } from './support/helpers.ts';
import { launchCaxri, openAddProjectDialog } from './support/helpers.ts';
import { stubPackagedProjectDialog } from './support/packaged-project-dialog.ts';

const packagedExecutable = process.env.CAXRI_PACKAGED_EXECUTABLE;

function treeCommandOpenedUrls(running: RunningCaxri): Promise<string[] | undefined> {
    return running.app.evaluate(() => {
        const target = globalThis as typeof globalThis & {
            caxriTreeCommandProbe?: { opened: string[] };
        };
        return target.caxriTreeCommandProbe?.opened;
    });
}

test('bundled Project Status extension renders and refreshes the current repository tree', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-status-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    const statusDelayPath = join(testDirectory, 'status-delay.txt');
    const statusRequestLogPath = join(testDirectory, 'status-requests.txt');
    const statusTitlePath = join(testDirectory, 'status-title.txt');
    const branchResponsePath = join(testDirectory, 'branch-response.json');
    const longCheckUrl = `https://github.com/tjx666/project/actions/runs/42/job/${'a'.repeat(180)}`;
    await execFileAsync('mkdir', ['-p', root, bin]);
    await execFileAsync('git', ['init', '-b', 'feature/status'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'fixture@caxri.test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Fixture'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'Project Status fixture\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'Initial fixture'], { cwd: root });
    const { stdout: branchHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    await writeFile(
        branchResponsePath,
        JSON.stringify({ data: { repository: { ref: { target: { oid: branchHead.trim() } } } } }),
    );
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/project.git'],
        { cwd: root },
    );
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/feature/status', 'HEAD'], {
        cwd: root,
    });
    await execFileAsync(
        'git',
        ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature/status'],
        { cwd: root },
    );
    await writeFile(statusDelayPath, '0');
    await writeFile(statusRequestLogPath, '');
    await writeFile(statusTitlePath, 'Status A');
    await writeFile(
        join(bin, 'gh'),
        `#!/bin/sh
if [ "$1" = "api" ]; then
  cat ${JSON.stringify(branchResponsePath)}
  exit 0
fi
if [ "$1 $2" = "pr list" ]; then printf '%s' '[{"number":42,"state":"MERGED","isDraft":false}]'; exit 0; fi
sleep "$(cat ${JSON.stringify(statusDelayPath)})"
printf 'request\n' >> ${JSON.stringify(statusRequestLogPath)}
status_title=$(cat ${JSON.stringify(statusTitlePath)})
printf '{"body":"Related to https://linear.app/example/issue/TASK-42/project-status","headRefName":"feature/status","state":"MERGED","mergeCommit":{"oid":"c3d4e5f60718293a4b5c6d7e8f90123456789abc"},"isDraft":false,"number":42,"title":"%s","url":"https://github.com/tjx666/project/pull/42","statusCheckRollup":[{"workflowName":"Test","name":"App","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-08-23T00:00:00.000Z","completedAt":"2026-08-23T00:02:05.000Z"},{"workflowName":"Test","name":"Packages","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-08-23T00:00:00.000Z","completedAt":"2026-08-23T00:01:00.000Z","detailsUrl":${JSON.stringify(longCheckUrl)}}]}' "$status_title"
`,
        'utf8',
    );
    await writeFile(
        join(bin, 'linear'),
        "#!/bin/sh\nprintf 'Linear fixture failed\\n' >&2\nexit 1\n",
        'utf8',
    );
    await writeFile(
        join(bin, 'vc'),
        String.raw`#!/bin/sh
case " $* " in
  *" teams ls "*) printf '%s' '{"teams":[{"slug":"tjx666"}]}' ;;
  *"meta-githubCommitRef="*"target=production"*) printf '%s' '[]' ;;
  *"target=production"*) printf '%s' '[{"uid":"dpl_Production123","created":1700000000000,"name":"project","readyState":"READY","target":"production","url":"project-production-tjx666.vercel.app","meta":{"githubCommitSha":"c3d4e5f60718293a4b5c6d7e8f90123456789abc","githubCommitMessage":"fix: restore the production alias","githubCommitOrg":"tjx666","githubCommitRepo":"project"}}]' ;;
  *"target=preview"*) printf '%s' '[{"uid":"dpl_Canceled123","name":"project","readyState":"CANCELED","target":"preview","url":"project-preview-tjx666.vercel.app","meta":{"githubCommitSha":"d4e5f60718293a4b5c6d7e8f90123456789abcde","githubCommitMessage":"refactor: split the status tree","githubCommitOrg":"tjx666","githubCommitRepo":"project"}}]' ;;
  *"meta-githubCommitRef="*) printf '%s' '[{"uid":"dpl_Ready123","created":1700000000000,"name":"project","readyState":"READY","target":"preview","url":"project-8ykp416o7-tjx666.vercel.app","meta":{"githubCommitSha":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678","githubCommitMessage":"feat: add the status rollup\n\nBody the row never shows.","githubCommitOrg":"tjx666","githubCommitRepo":"project","githubCommitAuthorLogin":"tjx666"}},{"uid":"dpl_Building123","name":"project","readyState":"BUILDING","target":"preview","url":"project-building-tjx666.vercel.app"},{"uid":"dpl_Queued123","name":"project","readyState":"QUEUED","target":"production","url":"project-queued-tjx666.vercel.app","meta":{"githubCommitSha":"b2c3d4e5f60718293a4b5c6d7e8f90123456789a","githubCommitMessage":"chore: bump the deploy target","githubCommitOrg":"tjx666","githubCommitRepo":"project"}}]' ;;
  *) printf '%s' '[{"name":"project","readyState":"READY","target":"production","url":"discovery.vercel.app"}]' ;;
esac
`,
        'utf8',
    );
    await Promise.all(['gh', 'linear', 'vc'].map((name) => chmod(join(bin, name), 0o755)));

    let running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await openAddProjectDialog(running.page);
        try {
            await running.page
                .getByRole('dialog')
                .getByRole('button', { name: 'Shell', exact: true })
                .click({ timeout: 5_000 });
        } catch {
            // The Shell button may already have been dismissed by an earlier auto-selection.
        }
        await expect(running.page.locator('.session-card')).toHaveCount(1);
        const statusTab = running.page.getByRole('tab', { name: 'Status', exact: true });
        await statusTab.click();
        await expect(statusTab.locator('img')).toHaveCount(0);
        await expect(statusTab.locator('svg')).toHaveCount(1);
        await expect(
            running.page.locator('.panel-caption-title', { hasText: 'Project Status' }),
        ).toHaveCount(1);
        const refreshButton = running.page.getByRole('button', {
            name: 'Refresh Project Status',
            exact: true,
        });
        await expect(refreshButton).toBeVisible();

        const tree = running.page.getByRole('tree', { name: 'Project Status' });
        const repo = tree.getByRole('treeitem', { name: 'project', exact: true });
        await expect(repo).toBeVisible();
        await expect(repo).toHaveAttribute('aria-expanded', 'true');
        await expect(repo).toHaveAttribute('data-tree-item-variant', 'header');
        await expect
            .poll(() =>
                repo.evaluate((element) => {
                    const icon = element.querySelector<SVGElement>('[data-theme-icon="repo"]');
                    const style = getComputedStyle(element);
                    return {
                        columnGap: style.columnGap,
                        fontSize: style.fontSize,
                        fontWeight: style.fontWeight,
                        height: style.height,
                        iconFlexShrink: icon ? getComputedStyle(icon).flexShrink : undefined,
                    };
                }),
            )
            .toEqual({
                columnGap: '8px',
                fontSize: '13px',
                fontWeight: '600',
                height: '32px',
                iconFlexShrink: '0',
            });
        const branchRow = tree.getByRole('treeitem', {
            // The branch row also names the pull request whose lifecycle glyph it now wears.
            name: 'feature/status, default, pull request #42 Merged',
            exact: true,
        });
        await expect(branchRow).toBeVisible();

        await expect(refreshButton).not.toHaveAttribute('aria-disabled', 'true');
        await refreshButton.hover();
        await expect(
            running.page
                .locator('.tooltip-popup:visible')
                .filter({ hasText: 'Refresh Project Status' }),
        ).toBeVisible();
        await running.page.mouse.move(0, 0);
        const pullRequestA = tree.getByRole('treeitem', {
            name: '#42 Status A, Merged, CI failed',
            exact: true,
        });
        /**
         * The first root load intentionally returns local data while its delivery metadata refresh continues in the
         * background. Wait for that refresh before measuring a manual request, otherwise the Server may correctly
         * coalesce the click with the in-flight load and the fixture would miscount it as a missing dispatch.
         */
        await expect(pullRequestA).toBeVisible();

        /**
         * Hover cards are asserted only after the background delivery-metadata refresh has settled: a tree re-render
         * under the cursor cancels the pending open and would make these checks flaky.
         */
        await branchRow.hover();
        const branchTooltip = running.page
            .locator('.tree-item-rich-tooltip:visible')
            .filter({ hasText: 'feature/status' });
        await expect(branchTooltip).toBeVisible();
        await expect(branchTooltip).toContainText('default');
        // No Status row falls back to the plain tooltip surface any more.
        await expect(running.page.locator('.tooltip-popup:visible')).toHaveCount(0);
        await running.page.mouse.move(0, 0);
        await pullRequestA.hover();
        // A row whose own destination has no more specific label publishes it once, as the trailing `link` row.
        const pullRequestTooltip = running.page
            .locator('.tree-item-rich-tooltip:visible')
            .filter({ hasText: '#42 Status A' });
        await expect(pullRequestTooltip).toBeVisible();
        // The same wording the row's accessible name uses, rather than the raw check state off the wire.
        await expect(pullRequestTooltip).toContainText('CI failed');
        await expect(
            pullRequestTooltip.getByRole('button', {
                name: 'Open link: github.com/tjx666/project/pull/42',
                exact: true,
            }),
        ).toBeVisible();
        await running.page.mouse.move(0, 0);
        // A 2s busy window: 0.4s was outlasted by CDP round trips under 3 parallel workers (issue #1846).
        await writeFile(statusDelayPath, '2');
        const refreshRequestCount = async (): Promise<number> =>
            (await readFile(statusRequestLogPath, 'utf8')).split('\n').filter(Boolean).length;
        const beforeInitialRefresh = await refreshRequestCount();
        await refreshButton.click();
        await expect(refreshButton).toHaveAttribute('aria-disabled', 'true');
        await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
        await refreshButton.evaluate((element) => (element as HTMLButtonElement).click());
        await expect.poll(refreshRequestCount).toBe(beforeInitialRefresh + 1);
        await expect(refreshButton).not.toHaveAttribute('aria-disabled', 'true');
        await expect(refreshButton).not.toHaveAttribute('aria-busy', 'true');
        expect(await refreshRequestCount()).toBe(beforeInitialRefresh + 1);
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'true');
        // The lifecycle glyph lives on the branch row, in GitHub's merged purple, and only there.
        await expect(branchRow.locator('[data-theme-icon="git-merge"]')).toHaveClass(/text-merged/);
        await expect(pullRequestA.locator('[data-theme-icon="git-merge"]')).toHaveCount(0);
        const appCheck = tree.getByRole('treeitem', { name: 'Test / App, 2m 5s', exact: true });
        const packagesCheck = tree.getByRole('treeitem', {
            name: 'Test / Packages, 1m',
            exact: true,
        });
        await expect(appCheck).toBeVisible();
        await expect(packagesCheck).toBeVisible();
        const appCheckBounds = await appCheck.boundingBox();
        const packagesCheckBounds = await packagesCheck.boundingBox();
        if (!appCheckBounds || !packagesCheckBounds)
            throw new Error('Project Status check bounds are unavailable');
        await running.page.mouse.move(
            appCheckBounds.x + appCheckBounds.width / 2,
            appCheckBounds.y + appCheckBounds.height / 2,
        );
        const appTooltip = running.page
            .locator('.tree-item-rich-tooltip:visible')
            .filter({ hasText: 'Test / App' });
        await expect(appTooltip).toBeVisible();
        // `failed`, not GitHub's raw `failure`: `status-labels.ts` owns the one word each state is called.
        await expect(appTooltip).toContainText('failed');
        await expect(appTooltip).toContainText('duration: 2m 5s');
        // The failing check exposes no details URL, so its card carries no link row and never invents one.
        await expect(appTooltip.getByRole('button')).toHaveCount(0);
        const pointer = {
            x: packagesCheckBounds.x + packagesCheckBounds.width / 2,
            y: packagesCheckBounds.y + packagesCheckBounds.height / 2,
        };
        await running.page.mouse.move(pointer.x, pointer.y);
        const packagesTooltip = running.page
            .locator('.tree-item-rich-tooltip:visible')
            .filter({ hasText: 'Test / Packages' });
        await expect(packagesTooltip).toBeVisible();
        await expect(packagesTooltip).toContainText('logs:');
        await packagesTooltip.evaluate(async (element) => {
            await Promise.allSettled(
                element.getAnimations().map((animation) => animation.finished),
            );
        });
        const tooltipLayout = await packagesTooltip.evaluate((element, currentPointer) => {
            const popupBounds = element.getBoundingClientRect();
            // The `logs` row holds the long details URL, so it is what must wrap inside the bounded card.
            const content = element.querySelector(':scope li:last-of-type button span');
            if (!content) throw new Error('Tooltip content is unavailable');
            const contentRange = document.createRange();
            contentRange.selectNodeContents(content);
            const textBounds = Array.from(contentRange.getClientRects());
            return {
                besidePointer:
                    popupBounds.right <= currentPointer.x - 8 ||
                    popupBounds.left >= currentPointer.x + 8,
                contentInsidePopup: textBounds.every(
                    (bounds) =>
                        bounds.left >= popupBounds.left - 0.5 &&
                        bounds.right <= popupBounds.right + 0.5,
                ),
                lineCount: new Set(textBounds.map((bounds) => Math.round(bounds.top))).size,
            };
        }, pointer);
        expect(tooltipLayout.besidePointer).toBe(true);
        expect(tooltipLayout.contentInsidePopup).toBe(true);
        expect(tooltipLayout.lineCount).toBeGreaterThanOrEqual(3);
        await running.page.mouse.move(0, 0);
        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & {
                caxriTreeCommandProbe?: { confirmations: string[]; opened: string[] };
            };
            target.caxriTreeCommandProbe = { confirmations: [], opened: [] };
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                target.caxriTreeCommandProbe!.confirmations.push(options.message);
                return Promise.resolve({
                    response: 0,
                    checkboxChecked: false,
                });
            };
            shell.openExternal = (url) => {
                target.caxriTreeCommandProbe!.opened.push(url);
                return Promise.resolve();
            };
        });
        await expect(pullRequestA).toHaveCSS('cursor', 'pointer');
        const collapsePullRequest = pullRequestA.getByRole('button', {
            name: 'Collapse #42 Status A, Merged, CI failed',
            exact: true,
        });
        await expect(collapsePullRequest).toHaveAttribute('aria-expanded', 'true');

        await pullRequestA.evaluate((element) => (element as HTMLElement).blur());
        await collapsePullRequest.hover();
        await expect(pullRequestTooltip).toBeVisible();
        const hoverSide = await pullRequestTooltip.getAttribute('data-side');
        expect(['left', 'right']).toContain(hoverSide);
        await collapsePullRequest.click();
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'false');
        await expect(pullRequestTooltip).toBeVisible();
        await expect(pullRequestTooltip).toHaveAttribute('data-side', hoverSide!);
        await pullRequestA
            .getByRole('button', {
                name: 'Expand #42 Status A, Merged, CI failed',
                exact: true,
            })
            .click();
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'true');
        await expect(pullRequestTooltip).toBeVisible();
        await expect(pullRequestTooltip).toHaveAttribute('data-side', hoverSide!);
        const tooltipScreenshot = test.info().outputPath('pointer-expanded-status-tooltip.png');
        await tree.screenshot({ path: tooltipScreenshot });
        await test.info().attach('pointer-expanded-status-tooltip', {
            path: tooltipScreenshot,
            contentType: 'image/png',
        });
        await running.page.mouse.move(0, 0);
        await expect(pullRequestTooltip).toHaveCount(0);

        // A click before the hover delay must not open a focus card that survives pointer departure.
        await pullRequestA.evaluate((element) => (element as HTMLElement).blur());
        await collapsePullRequest.click();
        await running.page.mouse.move(0, 0);
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'false');
        await expect(pullRequestTooltip).toHaveCount(0);
        await pullRequestA
            .getByRole('button', {
                name: 'Expand #42 Status A, Merged, CI failed',
                exact: true,
            })
            .click();
        await running.page.mouse.move(0, 0);
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'true');
        await expect(pullRequestTooltip).toHaveCount(0);

        await pullRequestA.click();
        await expect
            .poll(() => treeCommandOpenedUrls(running))
            .toEqual(['https://github.com/tjx666/project/pull/42']);
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'true');

        await collapsePullRequest.click();
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'false');
        await expect(
            tree.getByRole('treeitem', { name: 'Test / App, 2m 5s', exact: true }),
        ).toHaveCount(0);
        await expect.poll(() => treeCommandOpenedUrls(running)).toHaveLength(1);
        await pullRequestA
            .getByRole('button', {
                name: 'Expand #42 Status A, Merged, CI failed',
                exact: true,
            })
            .click();
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'true');
        await expect.poll(() => treeCommandOpenedUrls(running)).toHaveLength(1);

        await pullRequestA.focus();
        const composingEnterWasNotCanceled = await pullRequestA.evaluate((target) =>
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    bubbles: true,
                    cancelable: true,
                    isComposing: true,
                    key: 'Enter',
                }),
            ),
        );
        expect(composingEnterWasNotCanceled).toBe(true);
        await expect.poll(() => treeCommandOpenedUrls(running)).toHaveLength(1);
        await running.page.keyboard.press('Enter');
        await expect.poll(() => treeCommandOpenedUrls(running)).toHaveLength(2);
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'true');
        await running.page.keyboard.press('Space');
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'false');
        await expect.poll(() => treeCommandOpenedUrls(running)).toHaveLength(2);
        await running.page.keyboard.press('Space');
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'true');
        const deployments = tree.getByRole('treeitem', {
            name: 'Deployments, 3 on feature/status',
            exact: true,
        });
        await expect(deployments).toBeVisible();
        const productionDeployment = tree.getByRole('treeitem', {
            name: 'Production, passed · fix: restore the production alias · project-production-tjx666.vercel.app',
            exact: true,
        });
        await expect(productionDeployment).toBeVisible();
        // The visible row carries neither the unreadable alias nor the short SHA; both stay on the hover card.
        await expect(productionDeployment).not.toContainText('c3d4e5f');
        await expect(productionDeployment).not.toContainText('vercel.app');
        await expect(
            tree.getByRole('treeitem', {
                name: 'Preview, canceled · refactor: split the status tree · project-preview-tjx666.vercel.app',
                exact: true,
            }),
        ).toBeVisible();

        const linearError = tree.getByRole('treeitem', { name: /^Linear CLI: TASK-42 failed,/ });
        await expect(linearError).toBeVisible();
        await expect(linearError).toHaveAttribute('data-tree-item-variant', 'message');
        await expect(linearError.locator('[data-slot="empty-title"]')).toHaveText(
            'Linear CLI: TASK-42 failed',
        );
        await expect(linearError.locator('[data-slot="empty-description"]')).toHaveText(
            'Something went wrong while loading linked issues. Open Logs for details.',
        );
        /**
         * The keyboard steps above left focus on the pull request row, and a focus-opened card stays open by design so
         * its links remain reachable. Dismiss it before hovering, otherwise the interactive card covers the rows
         * below.
         */
        await running.page.keyboard.press('Escape');
        await expect(running.page.locator('.tree-item-rich-tooltip:visible')).toHaveCount(0);
        await linearError.hover();
        await expect(running.page.locator('.tree-item-rich-tooltip:visible')).toHaveCount(0);
        await running.page.mouse.move(0, 0);
        await expect(running.page.getByRole('region', { name: 'Panel' })).toHaveCount(0);
        await linearError.getByRole('button', { name: 'Open Logs', exact: true }).click();
        await expect(running.page.getByRole('region', { name: 'Panel' })).toBeVisible();
        await expect(running.page.getByRole('tab', { name: 'Logs', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );

        await writeFile(statusTitlePath, 'Status B');
        await writeFile(statusDelayPath, '2');
        await deployments.click();
        await expect(deployments).toHaveAttribute('aria-expanded', 'true');
        // Clicking focuses the group row and opens its own card; dismiss it so the leaf hover below is the only one.
        await running.page.keyboard.press('Escape');
        await expect(running.page.locator('.tree-item-rich-tooltip:visible')).toHaveCount(0);
        const successfulDeployment = tree.getByRole('treeitem', {
            name: 'feat: add the status rollup, preview · passed · project-8ykp416o7-tjx666.vercel.app',
            exact: true,
        });
        // Only the commit subject: no message body, no short SHA, and no alias the reader cannot parse. The
        // description also names the environment as text now (#1291): a Preview and a Production row for the
        // same commit used to be told apart only by an unlabelled trailing glyph.
        await expect(successfulDeployment).toContainText('feat: add the status rollup');
        await expect(successfulDeployment).not.toContainText('a1b2c3d');
        await expect(successfulDeployment).toContainText('Preview');
        await expect(successfulDeployment).not.toContainText('Body the row never shows');
        await expect(successfulDeployment).not.toContainText('vercel.app');
        await expect(successfulDeployment.locator('[data-theme-icon="eye-off"]')).toHaveCount(0);
        await expect(
            tree.getByRole('treeitem', {
                name: 'chore: bump the deploy target, production · queued · project-queued-tjx666.vercel.app',
                exact: true,
            }),
        ).toContainText('Production');
        await expect(successfulDeployment).not.toContainText('passed');
        const originalViewport = running.page.viewportSize();
        await running.page.setViewportSize({ width: 800, height: 720 });
        const successfulDeploymentBounds = await successfulDeployment.boundingBox();
        if (!successfulDeploymentBounds)
            throw new Error('Successful deployment bounds are unavailable');
        const deploymentPointer = {
            x: successfulDeploymentBounds.x + successfulDeploymentBounds.width / 2,
            y: successfulDeploymentBounds.y + successfulDeploymentBounds.height / 2,
        };
        await running.page.mouse.move(deploymentPointer.x, deploymentPointer.y);
        const richTooltip = running.page.locator('.tree-item-rich-tooltip:visible');
        await expect(richTooltip).toBeVisible();
        await expect(richTooltip).toContainText('Preview');
        await expect(richTooltip).toContainText('passed');
        await expect(richTooltip).toContainText('commit:');
        await expect(richTooltip).toContainText('author:');
        await expect(richTooltip).toContainText('alias:');
        await expect(richTooltip).toContainText('inspect:');
        await expect(richTooltip).toContainText('created:');
        await expect(
            richTooltip.getByRole('button', {
                name: 'Open commit: a1b2c3d feat: add the status rollup',
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            richTooltip.getByRole('button', {
                name: 'Open alias: project-8ykp416o7-tjx666.vercel.app',
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            richTooltip.getByRole('button', { name: 'Open inspect: details', exact: true }),
        ).toBeVisible();
        await expect
            .poll(() =>
                richTooltip.evaluate((element) => {
                    const box = element.getBoundingClientRect();
                    return {
                        bottom: box.bottom <= innerHeight,
                        left: box.left >= 0,
                        right: box.right <= innerWidth,
                        top: box.top >= 0,
                    };
                }),
            )
            .toEqual({ bottom: true, left: true, right: true, top: true });
        const richTooltipBounds = await richTooltip.boundingBox();
        if (!richTooltipBounds) throw new Error('Rich deployment tooltip bounds are unavailable');
        expect(
            richTooltipBounds.x >= deploymentPointer.x + 8 ||
                richTooltipBounds.x + richTooltipBounds.width <= deploymentPointer.x - 8,
        ).toBe(true);
        // A deployment without Git provenance (a direct CLI upload) still falls back to its alias.
        const buildingDeployment = tree.getByRole('treeitem', {
            name: /^project-building-tjx666\.vercel\.app, preview · /,
        });
        await expect(buildingDeployment).toContainText('project-building-tjx666.vercel.app');
        const buildingDeploymentBounds = await buildingDeployment.boundingBox();
        if (!buildingDeploymentBounds)
            throw new Error('Building deployment bounds are unavailable');
        await running.page.mouse.move(
            deploymentPointer.x,
            buildingDeploymentBounds.y + buildingDeploymentBounds.height / 2,
        );
        await expect
            .poll(() => buildingDeployment.evaluate((element) => element.matches(':hover')))
            .toBe(true);
        await running.page.mouse.move(deploymentPointer.x, deploymentPointer.y);
        await expect(richTooltip).toBeVisible();
        await richTooltip
            .getByRole('button', {
                name: 'Open alias: project-8ykp416o7-tjx666.vercel.app',
                exact: true,
            })
            .click();
        await expect
            .poll(async () => (await treeCommandOpenedUrls(running))?.at(-1))
            .toBe('https://project-8ykp416o7-tjx666.vercel.app/');
        await running.page.keyboard.press('Escape');
        await expect(richTooltip).toHaveCount(0);
        if (originalViewport) await running.page.setViewportSize(originalViewport);
        await running.page.mouse.move(400, 100);
        await refreshButton.focus();
        await successfulDeployment.focus();
        await expect(richTooltip).toBeVisible();
        const commitLink = richTooltip.getByRole('button', {
            name: 'Open commit: a1b2c3d feat: add the status rollup',
            exact: true,
        });
        const aliasLink = richTooltip.getByRole('button', {
            name: 'Open alias: project-8ykp416o7-tjx666.vercel.app',
            exact: true,
        });
        const logsLink = richTooltip.getByRole('button', {
            name: 'Open inspect: details',
            exact: true,
        });
        // The commit leads the card, so it is also the first link the keyboard reaches.
        await running.page.keyboard.press('Tab');
        await expect(commitLink).toBeFocused();
        await running.page.keyboard.press('Tab');
        await expect(aliasLink).toBeFocused();
        await running.page.keyboard.press('Tab');
        await expect(logsLink).toBeFocused();
        await running.page.keyboard.press('Enter');
        await expect
            .poll(async () => (await treeCommandOpenedUrls(running))?.at(-1))
            .toBe('https://vercel.com/tjx666/project/Ready123');
        await running.page.keyboard.press('Escape');
        await expect(richTooltip).toHaveCount(0);
        const production = tree.getByRole('treeitem', {
            name: 'Production, passed · fix: restore the production alias · project-production-tjx666.vercel.app',
            exact: true,
        });
        await production.focus();
        await expect(richTooltip).toBeVisible();
        await expect(richTooltip).toContainText('Production');
        await expect(richTooltip).toContainText('passed');
        await expect(
            richTooltip.getByRole('button', {
                name: 'Open alias: project-production-tjx666.vercel.app',
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            richTooltip.getByRole('button', { name: 'Open inspect: details', exact: true }),
        ).toBeVisible();
        await expect(richTooltip).toContainText('created:');
        await running.page.keyboard.press('Escape');
        await expect(richTooltip).toHaveCount(0);
        const preview = tree.getByRole('treeitem', {
            name: 'Preview, canceled · refactor: split the status tree · project-preview-tjx666.vercel.app',
            exact: true,
        });
        await preview.focus();
        await expect(richTooltip).toBeVisible();
        await expect(richTooltip).toContainText('Preview');
        await expect(richTooltip).toContainText('canceled');
        await expect(preview.locator('svg.lucide-circle-slash')).toBeVisible();
        await richTooltip.screenshot({
            path: 'test-results/canceled-deployment-tooltip.png',
            animations: 'disabled',
        });
        await expect(
            richTooltip.getByRole('button', {
                name: 'Open alias: project-preview-tjx666.vercel.app',
                exact: true,
            }),
        ).toBeVisible();
        await expect(richTooltip.getByText('inspect:', { exact: true })).toBeVisible();
        await running.page.keyboard.press('Escape');
        await expect(richTooltip).toHaveCount(0);
        await preview.click();
        await expect
            .poll(async () => (await treeCommandOpenedUrls(running))?.at(-1))
            .toBe('https://vercel.com/tjx666/project/Canceled123');
        await production.click();
        /**
         * The environment rows print only the environment, never the short SHA or the generated Vercel alias: the alias
         * survives in the accessible name this locator matches on, and both in the hover card asserted above.
         */
        await expect(production).toHaveText('Production');
        await expect(preview).toHaveText('Preview');
        await expect
            .poll(async () => (await treeCommandOpenedUrls(running))?.at(-1))
            .toBe('https://vercel.com/tjx666/project/Production123');
        await successfulDeployment.click();
        await expect
            .poll(async () => (await treeCommandOpenedUrls(running))?.at(-1))
            .toBe('https://vercel.com/tjx666/project/Ready123');
        await running.page.keyboard.press('Escape');
        await running.page.mouse.move(0, 0);
        await expect(richTooltip).toHaveCount(0);
        await tree.screenshot({
            path: 'test-results/deployment-details-links.png',
            animations: 'disabled',
        });
        await production.focus();
        await expect(production).toHaveAttribute('aria-selected', 'true');
        const beforeStatusBRefresh = await refreshRequestCount();
        await tree.evaluate((element) => {
            const target = globalThis as typeof window & {
                statusRefreshProbe?: {
                    observer: MutationObserver;
                    minimum: number;
                    initial: number;
                };
            };
            const initial = element.querySelectorAll('[role="treeitem"]').length;
            const probe = {
                initial,
                minimum: initial,
                observer: new MutationObserver(() => {
                    probe.minimum = Math.min(
                        probe.minimum,
                        element.querySelectorAll('[role="treeitem"]').length,
                    );
                }),
            };
            probe.observer.observe(element, { childList: true, subtree: true });
            target.statusRefreshProbe = probe;
        });
        await refreshButton.click();
        await expect(refreshButton).toBeFocused();
        await expect(refreshButton).toHaveAttribute('aria-disabled', 'true');
        await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
        await expect(
            tree.getByRole('treeitem', {
                name: '#42 Status B, Merged, CI failed',
                exact: true,
            }),
        ).toBeVisible();
        await expect(pullRequestA).toHaveCount(0);
        await expect(deployments).toHaveAttribute('aria-expanded', 'true');
        await expect(production).toHaveAttribute('aria-selected', 'true');
        await expect(refreshButton).not.toHaveAttribute('aria-disabled', 'true');
        await expect(refreshButton).toBeFocused();
        expect(await refreshRequestCount()).toBe(beforeStatusBRefresh + 1);
        const refreshRows = await running.page.evaluate(() => {
            const target = globalThis as typeof window & {
                statusRefreshProbe?: {
                    observer: MutationObserver;
                    minimum: number;
                    initial: number;
                };
            };
            const probe = target.statusRefreshProbe!;
            probe.observer.disconnect();
            delete target.statusRefreshProbe;
            return { minimum: probe.minimum, initial: probe.initial };
        });
        expect(refreshRows.minimum).toBe(refreshRows.initial);

        await running.app.close();
        running = await launchCaxri({
            executablePath: packagedExecutable,
            userDataDir: userData,
            testRootPath: root,
            env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
        });
        await running.page.getByRole('tab', { name: 'Status', exact: true }).click();
        const restoredTree = running.page.getByRole('tree', { name: 'Project Status' });
        /**
         * Activation restores the tree asynchronously. Wait for that request before forcing another refresh so the
         * fixture validates refresh persistence instead of racing two provider generations under CI load.
         */
        await expect(
            restoredTree.getByRole('treeitem', {
                name: '#42 Status B, Merged, CI failed',
                exact: true,
            }),
        ).toBeVisible();
        await writeFile(statusTitlePath, 'Status C');
        /**
         * The custom shortcut is already proven before relaunch. Use the restored extension's command palette entry
         * here so this recovery assertion starts a new provider generation only after command registration is ready.
         */
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Refresh Project Status', { exact: true }).click();
        await expect(
            restoredTree.getByRole('treeitem', {
                name: '#42 Status C, Merged, CI failed',
                exact: true,
            }),
        ).toBeVisible();
        const restoredDeployments = restoredTree.getByRole('treeitem', {
            name: 'Deployments, 3 on feature/status',
            exact: true,
        });
        await expect(restoredDeployments).toHaveAttribute('aria-expanded', 'true');
        await expect(
            restoredTree.getByRole('treeitem', {
                name: 'Production, passed · fix: restore the production alias · project-production-tjx666.vercel.app',
                exact: true,
            }),
        ).toHaveAttribute('aria-selected', 'true');
        await writeFile(
            branchResponsePath,
            JSON.stringify({ data: { repository: { ref: null } } }),
        );
        // A push/prune changes tracking refs without changing HEAD; the Git event must refresh publication automatically.
        await execFileAsync('git', ['update-ref', '-d', 'refs/remotes/origin/feature/status'], {
            cwd: root,
        });
        const unpublishedBranch = restoredTree.getByRole('treeitem', {
            name: 'feature/status, default · Not on origin, pull request #42 Merged',
            exact: true,
        });
        await expect(unpublishedBranch).toBeVisible();
        await unpublishedBranch.hover();
        const publicationTooltip = running.page
            .locator('.tree-item-rich-tooltip:visible')
            .filter({ hasText: 'feature/status' });
        await expect(publicationTooltip).toContainText('origin/feature/status');
        await expect(publicationTooltip).toContainText('checked');
        await expect(publicationTooltip.getByRole('button', { name: /Open link/ })).toHaveCount(0);
        await running.page.mouse.move(0, 0);
        await writeFile(
            branchResponsePath,
            JSON.stringify({ data: { repository: null }, errors: [{ message: 'unavailable' }] }),
        );
        await running.page
            .getByRole('button', { name: 'Refresh Project Status', exact: true })
            .click();
        // `Check failed`, not `Unknown`: a probe that errored and a remote nobody can probe are different answers.
        await expect(
            restoredTree.getByRole('treeitem', {
                name: 'feature/status, default · Check failed, pull request #42 Merged',
                exact: true,
            }),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
