import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import type { RunningCaxri } from './support/helpers.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

/**
 * Every row that offers the refresh command says `Refresh`; an error row that opens the logs instead still says `Open
 * Logs`. Spelled out rather than read from `REFRESH_ACTION_LABEL`: a spec that imports the same constant the product
 * renders would pass through any rename. `status-fallback.test.ts` pins the product side to this same word.
 */
const refreshAction = 'Refresh';

const scenarios = [
    {
        id: 'not-installed',
        title: 'Vercel CLI not installed',
        action: refreshAction,
        icon: 'cloud',
    },
    {
        id: 'not-logged-in',
        title: 'Vercel CLI not signed in',
        action: refreshAction,
        icon: 'cloud',
    },
    {
        id: 'not-linked',
        title: 'Repository not linked to Vercel',
        action: refreshAction,
        icon: 'cloud',
    },
    {
        id: 'rate-limited',
        title: 'Vercel API limit reached',
        /**
         * A rate limit is a wait Caxri is already honouring, so the row offers nothing to press: the request a Refresh
         * would send is exactly the one the limiter is refusing. The hourglass says the same thing in the icon.
         */
        action: undefined,
        icon: 'hourglass',
    },
    { id: 'network', title: 'No network connection', action: refreshAction, icon: 'cloud' },
] as const;

for (const scenario of scenarios) {
    test(`Project Status shows the ${scenario.id} external fallback`, async () => {
        const directory = await mkdtemp(join(tmpdir(), `caxri-status-${scenario.id}-`));
        const root = join(directory, 'project');
        const bin = join(directory, 'bin');
        const requestLog = join(directory, 'requests.txt');
        await mkdir(root);
        await mkdir(bin);
        await writeFile(requestLog, '');
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'fixture@caxri.test'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Fixture'], { cwd: root });
        await writeFile(join(root, 'README.md'), 'External status fixture\n');
        await execFileAsync('git', ['add', 'README.md'], { cwd: root });
        await execFileAsync('git', ['commit', '-m', 'Initial fixture'], { cwd: root });
        await execFileAsync(
            'git',
            ['remote', 'add', 'origin', 'https://github.com/tjx666/project.git'],
            { cwd: root },
        );

        const githubResult =
            scenario.id === 'network'
                ? 'echo "fetch failed ECONNRESET" >&2; exit 1'
                : 'if [ "$1" = "api" ]; then printf \'%s\' \'{"data":{"repository":{"ref":null}}}\'; else echo "no pull requests found" >&2; exit 1; fi';
        await writeFile(
            join(bin, 'gh'),
            `#!/bin/sh\n# 用途：提供固定的 GitHub CLI 测试响应。\n${githubResult}\n`,
        );
        await chmod(join(bin, 'gh'), 0o755);
        if (scenario.id !== 'not-installed') {
            const vercelResult =
                scenario.id === 'not-linked'
                    ? "printf '%s' '{\"teams\":[]}'"
                    : scenario.id === 'not-logged-in'
                      ? 'echo "not logged in" >&2; exit 1'
                      : scenario.id === 'rate-limited'
                        ? 'echo "rate limit exceeded" >&2; exit 1'
                        : 'echo "fetch failed ECONNRESET" >&2; exit 1';
            await writeFile(
                join(bin, 'vc'),
                `#!/bin/sh\n# 用途：提供固定的 Vercel CLI 测试响应。\nprintf 'request\\n' >> ${JSON.stringify(requestLog)}\n${scenario.id === 'not-logged-in' ? `if [ "$(wc -l < ${JSON.stringify(requestLog)})" -gt 1 ]; then sleep 1; fi` : ''}\n${vercelResult}\n`,
            );
            await chmod(join(bin, 'vc'), 0o755);
        }

        let running: RunningCaxri | undefined;
        try {
            running = await launchCaxri({
                userDataDir: join(directory, 'user-data'),
                testRootPath: root,
                env: { PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/sh' },
            });
            await createShellSession(running.page);
            await running.page
                .getByRole('tablist', { name: 'Secondary Side Bar' })
                .getByRole('tab', { name: 'Status', exact: true })
                .click();
            const tree = running.page.getByRole('tree', { name: 'Project Status' });
            const message = tree.getByRole('treeitem', { name: new RegExp(`^${scenario.title},`) });
            await expect(message).toHaveAttribute('data-tree-item-variant', 'message');
            await expect(message.locator(`[data-theme-icon="${scenario.icon}"]`)).toBeVisible();
            const description = message.locator('[data-slot="empty-description"]');
            await expect(description).toBeVisible();
            expect(
                await description.evaluate(
                    (element) =>
                        element.scrollWidth <= element.clientWidth &&
                        element.scrollHeight <= element.clientHeight,
                ),
            ).toBe(true);
            const screenshot = test.info().outputPath(`${scenario.id}.png`);
            await tree.screenshot({ path: screenshot });
            await test.info().attach(scenario.id, { path: screenshot, contentType: 'image/png' });

            if (scenario.id === 'network')
                await expect(
                    tree.getByRole('treeitem', { name: /^No network connection,/ }),
                ).toHaveCount(1);
            else if (scenario.id === 'not-linked')
                await expect(
                    tree.getByRole('treeitem', { name: 'Deployments', exact: true }),
                ).toBeVisible();
            if (scenario.action === undefined) {
                await expect(message.getByRole('button')).toHaveCount(0);
                // Stated for the Project, not under the repository that reported it, so it appears exactly once.
                await expect(message).toHaveCount(1);
                return;
            }
            const action = message.getByRole('button', { name: scenario.action, exact: true });
            await expect(action).toBeEnabled();
            if (scenario.id === 'not-logged-in') {
                await tree.getByRole('treeitem', { name: 'Deployments', exact: true }).focus();
                await running.page.keyboard.press('ArrowDown');
                await expect(message).toBeFocused();
                const focusedScreenshot = test.info().outputPath('not-logged-in-focused.png');
                await tree.screenshot({ path: focusedScreenshot });
                await test.info().attach('not-logged-in-focused', {
                    path: focusedScreenshot,
                    contentType: 'image/png',
                });
                await running.page.keyboard.press('Enter');
                await expect(action).toHaveAttribute('aria-busy', 'true');
                const busyScreenshot = test.info().outputPath('not-logged-in-busy.png');
                await tree.screenshot({ path: busyScreenshot });
                await test.info().attach('not-logged-in-busy', {
                    path: busyScreenshot,
                    contentType: 'image/png',
                });
                await expect(action).toBeEnabled();
                const refreshedScreenshot = test.info().outputPath('not-logged-in-refreshed.png');
                await tree.screenshot({ path: refreshedScreenshot });
                await test.info().attach('not-logged-in-refreshed', {
                    path: refreshedScreenshot,
                    contentType: 'image/png',
                });
            } else {
                await action.click();
            }
            await expect(message).toBeVisible();
            if (scenario.id !== 'not-installed')
                await expect
                    .poll(
                        async () =>
                            (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean)
                                .length,
                    )
                    .toBeGreaterThan(1);
        } finally {
            await running?.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
