import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import type { MessageBoxOptions } from 'electron';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, sessionCard } from './support/helpers.ts';

const PULL_REQUEST_URL = 'https://github.com/tjx666/project/pull/42';

/**
 * The hover card's pull request link is the only pointer route to the PR, and the card is a non-modal preview: Tab from
 * the focused row leaves the sidebar and closes it (verified over CDP for #534). Keyboard users therefore reach the PR
 * through the Session row menu and the command palette, both of which this workflow drives end to end against a fake
 * `gh` that reports a merged PR or an open PR with failing checks for the checked-out branch.
 */
for (const state of ['merged', 'open'] as const) {
    test(`a ${state} Session pull request is visible on the row and opens from the keyboard`, async () => {
        const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-pull-request-e2e-'));
        const userData = join(testDirectory, 'user-data');
        const root = join(testDirectory, 'project');
        const bin = join(testDirectory, 'bin');
        await execFileAsync('mkdir', ['-p', root, bin]);
        await execFileAsync('git', ['init', '-b', 'feature/pull-request'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
        await execFileAsync(
            'git',
            ['remote', 'add', 'origin', 'https://github.com/tjx666/project.git'],
            { cwd: root },
        );
        await writeFile(join(root, 'tracked.txt'), 'tracked\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
        const headOid = (
            await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
        ).stdout.trim();
        /**
         * Branch discovery (`gh pr list`) only wants identity; the shared record read (`gh pr view`) wants the full
         * field union. One script answers both so the sidebar glyph, hover card, and command surfaces all see the same
         * PR. The quota probe (`gh api rate_limit`) gets a realistic budget, or the Server's GitHub circuit opens and
         * skips every guarded `gh` call, the branch discovery included.
         */
        const view = JSON.stringify({
            number: 42,
            title: 'Merged pull request fixture',
            url: PULL_REQUEST_URL,
            state: state.toUpperCase(),
            isDraft: false,
            body: '',
            statusCheckRollup:
                state === 'open'
                    ? [
                          {
                              __typename: 'CheckRun',
                              status: 'COMPLETED',
                              conclusion: 'FAILURE',
                              name: 'Build',
                          },
                      ]
                    : [],
            baseRefName: 'main',
            headRefName: 'feature/pull-request',
            baseRefOid: headOid,
            headRefOid: headOid,
        });
        await writeFile(
            join(bin, 'gh'),
            `#!/bin/sh
case " $* " in
  *" api rate_limit "*) printf '%s' '{"resources":{"graphql":{"limit":5000,"remaining":5000,"reset":4102444800}}}' ;;
  *" pr list "*) printf '%s' '[{"number":42,"state":"${state.toUpperCase()}","isDraft":false}]' ;;
  *) printf '%s' '${view}' ;;
esac
`,
            'utf8',
        );
        await chmod(join(bin, 'gh'), 0o755);

        const running = await launchCaxri({
            userDataDir: userData,
            testRootPath: root,
            env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
        });
        try {
            const sessionId = await createProjectSession(running.page);
            const card = sessionCard(running.page, sessionId);
            const glyph = card.locator(`[data-pull-request-state="${state}"]`);
            await expect(glyph).toBeVisible();
            const description =
                state === 'open'
                    ? 'Pull request #42 open, checks failing.'
                    : 'Pull request #42 merged.';
            await expect(glyph).toHaveAttribute('aria-label', description);
            await expect(glyph.locator('[data-pull-request-check-badge="failure"]')).toHaveCount(0);
            const statusTab = running.page.getByRole('tab', { name: 'Status', exact: true });
            const badge = statusTab.locator('[data-view-container-badge]');
            if (state === 'open') {
                await expect(badge).toHaveText('1');
                await expect(statusTab).toHaveAccessibleDescription('1 failed check');
            } else await expect(badge).toHaveCount(0);
            await running.page
                .getByRole('tablist', { name: 'Secondary Side Bar' })
                .screenshot({ path: test.info().outputPath(`status-${state}-badge.png`) });
            // The row's own description already announces the PR; the entry below must not regress it.
            await expect(card).toHaveAccessibleDescription(
                new RegExp(description.replaceAll('.', String.raw`\.`)),
            );
            await card.screenshot({ path: test.info().outputPath(`pr-${state}-row.png`) });

            await running.app.evaluate(({ dialog, shell }) => {
                const target = globalThis as typeof globalThis & {
                    caxriPullRequestProbe?: { confirmations: string[]; opened: string[] };
                };
                target.caxriPullRequestProbe = { confirmations: [], opened: [] };
                // github.com is not a trusted domain in a fresh profile; answer the native prompt with "Open Once".
                dialog.showMessageBox = (
                    windowOrOptions: unknown,
                    maybeOptions?: MessageBoxOptions,
                ) => {
                    const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                    target.caxriPullRequestProbe!.confirmations.push(options.message);
                    return Promise.resolve({ response: 0, checkboxChecked: false });
                };
                shell.openExternal = (url) => {
                    target.caxriPullRequestProbe!.opened.push(url);
                    return Promise.resolve();
                };
            });
            const openedUrls = () =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriPullRequestProbe?: { opened: string[] };
                    };
                    return target.caxriPullRequestProbe?.opened ?? [];
                });
            const palette = running.page.getByRole('dialog');
            const command = palette.getByRole('option', { name: /Open Pull Request/u });
            const selectedPaletteCommand = () =>
                command.evaluate((element) => (element as HTMLElement).dataset.selected);

            // Keyboard focus on the row opens the hover card with the PR, but the card is not in the Tab order.
            await running.page.locator('.project-select').focus();
            await running.page.keyboard.press('ArrowDown');
            await expect(card).toBeFocused();
            const hoverCard = running.page.locator('.session-activity-card');
            await expect(hoverCard).toContainText('#42');
            await expect(hoverCard).toContainText(state === 'open' ? 'Open' : 'Merged');
            if (state === 'open') await expect(hoverCard).toContainText('Checks failing');
            await hoverCard.screenshot({ path: test.info().outputPath(`pr-${state}-hover.png`) });
            await expect(hoverCard).toContainText('Merged pull request fixture');
            await running.page.keyboard.press('Tab');
            await expect(card).not.toBeFocused();
            await expect(hoverCard).toHaveCount(0);

            // Keyboard route 1: the command palette gates Open Pull Request on the selected Session's PR.
            await running.page.keyboard.press('Meta+Shift+P');
            await palette
                .getByPlaceholder('Search projects, sessions, and commands…')
                .fill('Open Pull Request');
            await expect(command).toBeVisible();
            // Sessions rank above commands for a broad term, so walk the highlight down to the command.
            await expect
                .poll(async () => {
                    if ((await selectedPaletteCommand()) === 'true') return true;
                    await running.page.keyboard.press('ArrowDown');
                    return false;
                })
                .toBe(true);
            await running.page.keyboard.press('Enter');
            await expect(palette).toHaveCount(0);
            await expect.poll(openedUrls).toEqual([PULL_REQUEST_URL]);

            // Keyboard route 2: the Session row menu carries the same entry with the PR number.
            await card.click({ button: 'right' });
            const menu = running.page.getByRole('menu', { name: /actions$/u });
            await expect(menu).toBeVisible();
            await menu.getByRole('menuitem', { name: 'Open Pull Request #42' }).click();
            await expect.poll(openedUrls).toEqual([PULL_REQUEST_URL, PULL_REQUEST_URL]);
        } finally {
            try {
                await running.app.close();
            } catch {
                // Ignore close failures; the assertions above already produced the test result.
            }
            await rm(testDirectory, { recursive: true, force: true });
        }
    });
}
