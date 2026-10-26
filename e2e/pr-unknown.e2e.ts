import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, sessionCard } from './support/helpers.ts';

const view = JSON.stringify({
    number: 42,
    title: 'Fixture pull request',
    url: 'https://github.com/tjx666/project/pull/42',
    state: 'OPEN',
    isDraft: false,
    statusCheckRollup: [],
});

const scenarios = [
    {
        id: 'not-installed',
        label: 'PR needs gh',
        hint: 'GitHub CLI is not installed. Run "brew install gh" in a terminal, then refresh.',
    },
    {
        id: 'not-logged-in',
        label: 'PR needs login',
        hint: 'GitHub CLI is not signed in. Run "gh auth login" in a terminal, then refresh. A GH_TOKEN environment variable alone is not enough: Caxri does not forward personal shell credentials to CLI checks.',
    },
    {
        id: 'rate-limited',
        label: 'PR rate limited',
        /**
         * `hint` is the stable opening of the sentence; the rest names the limiter's own resume deadline, whose clock
         * time moves with the run, so the accessible name is matched by shape instead of by literal.
         *
         * The deadline is required, not optional: this fixture's `gh` fails every call including the `api graphql`
         * rateLimit probe, so the limiter cannot read GitHub's own reset and always falls back to its fixed 15-minute
         * pause. Accepting the deadline-free wording here would let the whole `retryAt` path break without failing this
         * test.
         */
        hint: 'GitHub API rate limit reached.',
        hintPattern: /GitHub API rate limit reached\. Caxri retries after \d{1,2}:\d{2} [AP]M\./,
    },
    { id: 'has-pr' },
    { id: 'no-pr' },
] as const;

const POLL_INTERVAL_MS = 2_000;

for (const scenario of scenarios) {
    test(`PR status distinguishes ${scenario.id}`, async () => {
        test.setTimeout(60_000);
        const directory = await mkdtemp(join(tmpdir(), `caxri-pr-unknown-${scenario.id}-`));
        const root = join(directory, 'project');
        const bin = join(directory, 'bin');
        const ready = join(directory, 'gh-ready');
        const requests = join(directory, 'gh-requests');
        await mkdir(root);
        await mkdir(bin);
        await writeFile(requests, '');
        await execFileAsync('git', ['init', '-b', 'feature/pr-unknown'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'fixture@caxri.test'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Fixture'], { cwd: root });
        await writeFile(join(root, 'README.md'), 'PR status fixture\n');
        await execFileAsync('git', ['add', 'README.md'], { cwd: root });
        await execFileAsync('git', ['commit', '-m', 'Initial fixture'], { cwd: root });
        await execFileAsync(
            'git',
            ['remote', 'add', 'origin', 'https://github.com/tjx666/project.git'],
            { cwd: root },
        );

        if (scenario.id !== 'not-installed') {
            const response =
                scenario.id === 'rate-limited'
                    ? 'echo "rate limit exceeded" >&2; exit 1'
                    : `if [ "$1 $2 $3" = "api graphql -f" ]; then printf '%s' '{"data":{"rateLimit":{"limit":5000,"remaining":5000,"used":0,"resetAt":"2100-01-01T00:00:00Z"}}}'; exit 0; fi
if [ "$1 $2" = "pr list" ]; then printf '%s' '${scenario.id === 'no-pr' ? '[]' : '[{"number":42,"state":"OPEN"}]'}'; exit 0; fi
${scenario.id === 'no-pr' ? 'echo "no pull requests found" >&2; exit 1' : `printf '%s' '${view}'`}`;
            await writeFile(
                join(bin, 'gh'),
                `#!/bin/sh
# 用途：为 PR 状态验收提供固定的 GitHub CLI 响应，读取临时恢复标记。
printf '%s\n' "$1 $2" >> ${JSON.stringify(requests)}
# Server reads the token via \`gh auth token\` before every gh call (#2166); the signed-out state must come from the real call.
if [ "$1 $2" = "auth token" ]; then printf 'fixture-token'; exit 0; fi
${scenario.id === 'not-logged-in' ? `if [ ! -f ${JSON.stringify(ready)} ]; then echo "not logged in" >&2; exit 1; fi` : ''}
${response}
`,
            );
            await chmod(join(bin, 'gh'), 0o755);
        }

        const running = await launchCaxri({
            userDataDir: join(directory, 'user-data'),
            testRootPath: root,
            env: {
                /**
                 * The `not-logged-in` recovery below waits for the status bar's own poll to re-ask a now-working `gh`.
                 * That cadence is a minute in production, which is a minute of the single-worker CI pool spent on a
                 * timer; `renderer/src/lib/poll-scheduler.ts` owns this bounded cap and `poll-scheduler.test.ts` pins
                 * it. What the workflow proves (the indicator clears itself rather than latching) is unchanged.
                 */
                CAXRI_E2E_MAX_POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
                PATH: `${bin}:/usr/bin:/bin`,
                SHELL: '/bin/sh',
            },
        });
        try {
            const sessionId = await createProjectSession(running.page);
            const statusBar = running.page.locator('footer.statusbar');
            // Every unavailable reason states itself; a readable pull request shows `#42` instead.
            const unavailable = statusBar.locator('.statusbar-info').filter({ hasText: /^PR / });
            const row = sessionCard(running.page, sessionId);
            if ('hint' in scenario) {
                await expect(unavailable).toBeVisible();
                await expect(unavailable).toHaveText(scenario.label);
                await expect(unavailable).toHaveAttribute(
                    'aria-label',
                    'hintPattern' in scenario
                        ? new RegExp(
                              String.raw`^${scenario.label}\. ${scenario.hintPattern.source}$`,
                          )
                        : `${scenario.label}. ${scenario.hint}`,
                );
                await expect(unavailable).toHaveAttribute('role', 'note');
                await unavailable.focus();
                await expect(unavailable).toBeFocused();
                const screenshot = test.info().outputPath(`${scenario.id}.png`);
                await statusBar.screenshot({ path: screenshot });
                await test
                    .info()
                    .attach(scenario.id, { path: screenshot, contentType: 'image/png' });
                if (scenario.id === 'not-logged-in') {
                    await unavailable.hover();
                    await expect(running.page.locator('.tooltip-popup')).toContainText(
                        scenario.hint,
                    );
                    const tooltipScreenshot = test.info().outputPath('not-logged-in-tooltip.png');
                    await running.page.screenshot({ path: tooltipScreenshot });
                    await test.info().attach('not-logged-in-tooltip', {
                        path: tooltipScreenshot,
                        contentType: 'image/png',
                    });
                }
                await expect(row.locator('[data-pull-request-state]')).toHaveCount(0);
                // The hover card is a glance; the row's description still names why the PR is unknown.
                const escapedHint = scenario.hint.replaceAll(
                    /[$()*+.?[\\\]^{|}]/gu,
                    String.raw`\$&`,
                );
                await expect(row).toHaveAccessibleDescription(
                    new RegExp(String.raw`Pull request unknown\. ` + escapedHint, 'u'),
                );
                if (scenario.id === 'not-logged-in') {
                    const before = test.info().outputPath('before-recovery.png');
                    await statusBar.screenshot({ path: before });
                    await writeFile(ready, 'ready');
                    await expect(unavailable).toHaveCount(0, {
                        timeout: POLL_INTERVAL_MS + 30_000,
                    });
                    await expect(
                        statusBar.getByRole('link', { name: 'Open pull request #42' }),
                    ).toBeVisible();
                    const after = test.info().outputPath('after-recovery.png');
                    await statusBar.screenshot({ path: after });
                    await test.info().attach('before-recovery', {
                        path: before,
                        contentType: 'image/png',
                    });
                    await test.info().attach('after-recovery', {
                        path: after,
                        contentType: 'image/png',
                    });
                }
            } else if (scenario.id === 'has-pr') {
                await expect(
                    statusBar.getByRole('link', { name: 'Open pull request #42' }),
                ).toBeVisible();
                await expect(row.locator('[data-pull-request-state="open"]')).toBeVisible();
                const screenshot = test.info().outputPath('has-pr.png');
                await statusBar.screenshot({ path: screenshot });
                await test.info().attach('has-pr', { path: screenshot, contentType: 'image/png' });
            } else {
                await expect
                    .poll(async () => (await readFile(requests, 'utf8')).includes('pr view'))
                    .toBe(true);
                await expect(unavailable).toHaveCount(0);
                await expect(row.locator('[data-pull-request-state]')).toHaveCount(0);
                const screenshot = test.info().outputPath('no-pr.png');
                await statusBar.screenshot({ path: screenshot });
                await test.info().attach('no-pr', { path: screenshot, contentType: 'image/png' });
            }
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
