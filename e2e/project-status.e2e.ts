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
    await execFileAsync('mkdir', ['-p', root, bin]);
    await execFileAsync('git', ['init', '-b', 'feature/status'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'fixture@caxri.test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Fixture'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'Project Status fixture\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'Initial fixture'], { cwd: root });
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
sleep "$(cat ${JSON.stringify(statusDelayPath)})"
printf 'request\n' >> ${JSON.stringify(statusRequestLogPath)}
status_title=$(cat ${JSON.stringify(statusTitlePath)})
printf '{"body":"Related to https://linear.app/lobehub/issue/LOBE-42/project-status","number":42,"title":"%s","url":"https://github.com/tjx666/project/pull/42","statusCheckRollup":[{"workflowName":"Test","name":"App","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-08-23T00:00:00.000Z","completedAt":"2026-08-23T00:02:05.000Z"}]}' "$status_title"
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
        `#!/bin/sh
case " $* " in
  *" teams ls "*) printf '%s' '{"teams":[{"slug":"tjx666"}]}' ;;
  *" githubCommitRef="*) printf '%s' '[{"created":1700000000000,"name":"project","readyState":"READY","target":"preview","url":"project-8ykp416o7-tjx666.vercel.app"},{"name":"project","readyState":"BUILDING","target":"preview","url":"project-building-tjx666.vercel.app"},{"name":"project","readyState":"QUEUED","target":"preview","url":"project-queued-tjx666.vercel.app"}]' ;;
  *" --environment production "*) printf '%s' '[{"created":1700000000000,"name":"project","readyState":"READY","target":"production","url":"project-production-tjx666.vercel.app"}]' ;;
  *" --environment preview "*) printf '%s' '[{"name":"project","readyState":"ERROR","target":"preview","url":"project-preview-tjx666.vercel.app"}]' ;;
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
                    const icon = element.querySelector<SVGElement>('[data-theme-icon="monitor"]');
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
        await expect(
            tree.getByRole('treeitem', { name: 'feature/status, default', exact: true }),
        ).toBeVisible();

        await expect(refreshButton).not.toHaveAttribute('aria-disabled', 'true');
        await refreshButton.hover();
        await expect(
            running.page
                .locator('.tooltip-popup:visible')
                .filter({ hasText: 'Refresh Project Status' }),
        ).toBeVisible();
        await running.page.mouse.move(0, 0);
        const pullRequestA = tree.getByRole('treeitem', { name: '#42 Status A', exact: true });
        /**
         * The first root load intentionally returns local data while its delivery metadata refresh continues in the
         * background. Wait for that refresh before measuring a manual request, otherwise the Server may correctly
         * coalesce the click with the in-flight load and the fixture would miscount it as a missing dispatch.
         */
        await expect(pullRequestA).toBeVisible();
        await writeFile(statusDelayPath, '0.4');
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
        await expect(pullRequestA.locator('[data-theme-icon="circle-x"]')).toHaveClass(
            /text-danger/,
        );
        await expect(
            tree.getByRole('treeitem', { name: 'Test / App, 2m 5s', exact: true }),
        ).toBeVisible();
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
            name: 'Collapse #42 Status A',
            exact: true,
        });
        await expect(collapsePullRequest).toHaveAttribute('aria-expanded', 'true');

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
            .getByRole('button', { name: 'Expand #42 Status A', exact: true })
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
            name: 'Deployments, 3 on preview',
            exact: true,
        });
        await expect(deployments).toBeVisible();
        await expect(
            tree.getByRole('treeitem', {
                name: 'Production, success · project-production-tjx666.vercel.app',
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            tree.getByRole('treeitem', {
                name: 'Preview, failure · project-preview-tjx666.vercel.app',
                exact: true,
            }),
        ).toBeVisible();

        const linearError = tree.getByRole('treeitem', { name: /linear: error/i });
        await expect(linearError).toBeVisible();
        await expect(running.page.getByRole('region', { name: 'Panel' })).toHaveCount(0);
        await linearError.click();
        await expect(running.page.getByRole('region', { name: 'Panel' })).toBeVisible();
        await expect(running.page.getByRole('tab', { name: 'Logs', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );

        await writeFile(statusTitlePath, 'Status B');
        await writeFile(statusDelayPath, '0.4');
        await deployments.click();
        await expect(deployments).toHaveAttribute('aria-expanded', 'true');
        const successfulDeployment = tree.getByRole('treeitem', {
            name: 'project-8ykp416o7-tjx666.vercel.app, preview · success',
            exact: true,
        });
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
        await expect(richTooltip).toContainText('preview');
        await expect(richTooltip).toContainText('success');
        await expect(richTooltip).toContainText('alias:');
        await expect(richTooltip).toContainText('inspect:');
        await expect(richTooltip).toContainText('created:');
        await expect(
            richTooltip.getByRole('button', {
                name: 'Open alias: project-8ykp416o7-tjx666.vercel.app',
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            richTooltip.getByRole('button', { name: 'Open inspect: logs', exact: true }),
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
        const buildingDeployment = tree.getByRole('treeitem', {
            name: /^project-building-tjx666\.vercel\.app, preview · /,
        });
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
        const aliasLink = richTooltip.getByRole('button', {
            name: 'Open alias: project-8ykp416o7-tjx666.vercel.app',
            exact: true,
        });
        const logsLink = richTooltip.getByRole('button', {
            name: 'Open inspect: logs',
            exact: true,
        });
        await running.page.keyboard.press('Tab');
        await expect(aliasLink).toBeFocused();
        await running.page.keyboard.press('Tab');
        await expect(logsLink).toBeFocused();
        await running.page.keyboard.press('Enter');
        await expect
            .poll(async () => (await treeCommandOpenedUrls(running))?.at(-1))
            .toBe('https://vercel.com/tjx666/project/8ykp416o7');
        await running.page.keyboard.press('Escape');
        await expect(richTooltip).toHaveCount(0);
        const production = tree.getByRole('treeitem', {
            name: 'Production, success · project-production-tjx666.vercel.app',
            exact: true,
        });
        await production.focus();
        await expect(richTooltip).toBeVisible();
        await expect(richTooltip).toContainText('Production');
        await expect(richTooltip).toContainText('success');
        await expect(
            richTooltip.getByRole('button', {
                name: 'Open alias: project-production-tjx666.vercel.app',
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            richTooltip.getByRole('button', { name: 'Open inspect: logs', exact: true }),
        ).toBeVisible();
        await expect(richTooltip).toContainText('created:');
        await running.page.keyboard.press('Escape');
        await expect(richTooltip).toHaveCount(0);
        const preview = tree.getByRole('treeitem', {
            name: 'Preview, failure · project-preview-tjx666.vercel.app',
            exact: true,
        });
        await preview.focus();
        await expect(richTooltip).toBeVisible();
        await expect(richTooltip).toContainText('Preview');
        await expect(richTooltip).toContainText('failure');
        await expect(
            richTooltip.getByRole('button', {
                name: 'Open alias: project-preview-tjx666.vercel.app',
                exact: true,
            }),
        ).toBeVisible();
        await expect(richTooltip.getByText('inspect:', { exact: true })).toHaveCount(0);
        await running.page.keyboard.press('Escape');
        await expect(richTooltip).toHaveCount(0);
        await production.focus();
        await expect(production).toHaveAttribute('aria-selected', 'true');
        const beforeStatusBRefresh = await refreshRequestCount();
        await refreshButton.click();
        await expect(refreshButton).toBeFocused();
        await expect(refreshButton).toHaveAttribute('aria-disabled', 'true');
        await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
        await expect(
            tree.getByRole('treeitem', { name: '#42 Status B', exact: true }),
        ).toBeVisible();
        await expect(pullRequestA).toHaveCount(0);
        await expect(deployments).toHaveAttribute('aria-expanded', 'true');
        await expect(production).toHaveAttribute('aria-selected', 'true');
        await expect(refreshButton).not.toHaveAttribute('aria-disabled', 'true');
        await expect(refreshButton).toBeFocused();
        expect(await refreshRequestCount()).toBe(beforeStatusBRefresh + 1);

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
            restoredTree.getByRole('treeitem', { name: '#42 Status B', exact: true }),
        ).toBeVisible();
        await writeFile(statusTitlePath, 'Status C');
        /**
         * The custom shortcut is already proven before relaunch. Use the restored extension's command palette entry
         * here so this recovery assertion starts a new provider generation only after command registration is ready.
         */
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Refresh Project Status', { exact: true }).click();
        await expect(
            restoredTree.getByRole('treeitem', { name: '#42 Status C', exact: true }),
        ).toBeVisible();
        const restoredDeployments = restoredTree.getByRole('treeitem', {
            name: 'Deployments, 3 on preview',
            exact: true,
        });
        await expect(restoredDeployments).toHaveAttribute('aria-expanded', 'true');
        await expect(
            restoredTree.getByRole('treeitem', {
                name: 'Production, success · project-production-tjx666.vercel.app',
                exact: true,
            }),
        ).toHaveAttribute('aria-selected', 'true');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
