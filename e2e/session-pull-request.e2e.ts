import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import type { MessageBoxOptions } from 'electron';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    sessionCard,
} from './support/helpers.ts';
import {
    chooseContextMenuItem,
    contextMenuLabels,
    dismissContextMenu,
} from './support/native-context-menu.ts';

const PULL_REQUEST_URL = 'https://github.com/tjx666/project/pull/42';

async function writeClaudeMetadata(
    configDirectory: string,
    root: string,
    startedAt: number,
    status: 'busy' | 'idle' | 'completed',
): Promise<void> {
    const sessions = join(configDirectory, 'sessions');
    const target = join(sessions, 'session.json');
    const temporary = join(sessions, 'session.next.json');
    await writeFile(
        temporary,
        JSON.stringify({
            cwd: root,
            name: 'Pull request lifecycle fixture',
            sessionId: 'pull-request-lifecycle-session',
            startedAt: new Date(startedAt).toISOString(),
            status,
            updatedAt: new Date().toISOString(),
        }),
        'utf8',
    );
    await rename(temporary, target);
    await writeFile(join(configDirectory, 'trigger'), String(Date.now()), 'utf8');
}

/**
 * The hover card's pull request link is the only pointer route to the PR, and the card is a non-modal preview: Tab from
 * the focused row leaves the sidebar and closes it (verified over CDP for #534). Keyboard users therefore reach the PR
 * through the Session row menu and the command palette, both of which this workflow drives end to end against a fake
 * `gh` that reports a merged, open, or draft PR for the checked-out branch.
 */
for (const state of ['merged', 'open', 'draft'] as const) {
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
         * PR. The quota probe (the `gh api graphql` rateLimit self-query) gets a realistic budget, or the Server's
         * GitHub circuit opens and skips every guarded `gh` call, the branch discovery included.
         */
        const view = JSON.stringify({
            number: 42,
            title: 'Pull request fixture',
            url: PULL_REQUEST_URL,
            state: state === 'draft' ? 'OPEN' : state.toUpperCase(),
            isDraft: state === 'draft',
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
  *" api graphql -f "*) printf '%s' '{"data":{"rateLimit":{"limit":5000,"remaining":5000,"used":0,"resetAt":"2100-01-01T00:00:00Z"}}}' ;;
  *" pr list "*) printf '%s' '[{"number":42,"state":"${state === 'draft' ? 'OPEN' : state.toUpperCase()}","isDraft":${state === 'draft'}}]' ;;
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
                    : `Pull request #42 ${state}.`;
            await expect(glyph).toHaveAttribute('aria-label', description);
            if (state === 'draft') {
                await expect(glyph.locator('svg')).toHaveClass(/lucide-git-pull-request$/u);
            }
            await expect(glyph.locator('[data-pull-request-check-badge="failure"]')).toHaveCount(0);
            const statusTab = running.page.getByRole('tab', { name: 'Status', exact: true });
            const badge = statusTab.locator('[data-view-container-badge]');
            if (state === 'open') {
                // Severity takes the chip outright: the glyph renders and the tally never appears beside it, so the
                // badge stays readable in greyscale instead of leaving the fill to carry the severity alone.
                await expect(badge).toHaveText('');
                await expect(badge.locator('svg')).toHaveCount(1);
                await expect(badge).toHaveAttribute('data-view-container-badge-kind', 'error');
                // The displaced tally survives where a screen reader and a hover both still reach it.
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
            await expect(hoverCard).toContainText(
                state === 'open' ? 'Open' : state === 'draft' ? 'Draft' : 'Merged',
            );
            if (state === 'open') await expect(hoverCard).toContainText('Checks failing');
            await hoverCard.screenshot({ path: test.info().outputPath(`pr-${state}-hover.png`) });
            await expect(hoverCard).toContainText('Pull request fixture');
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
            await chooseContextMenuItem(running.app, 'Open Pull Request #42');
            await expect.poll(openedUrls).toEqual([PULL_REQUEST_URL, PULL_REQUEST_URL]);
            const confirmations = await running.app.evaluate(() => {
                const target = globalThis as typeof globalThis & {
                    caxriPullRequestProbe?: { confirmations: string[] };
                };
                return target.caxriPullRequestProbe?.confirmations ?? [];
            });
            expect(confirmations).toEqual([
                'Open github.com in your default browser?',
                'Open github.com in your default browser?',
            ]);
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

test('Session status takes the right-edge slot before its pull request glyph', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-pull-request-status-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    const config = join(userData, 'e2e-agents', 'claude');
    await execFileAsync('mkdir', ['-p', root, bin]);
    await mkdir(join(config, 'sessions'), { recursive: true });
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
    const view = JSON.stringify({
        number: 42,
        title: 'Pull request lifecycle fixture',
        url: PULL_REQUEST_URL,
        state: 'OPEN',
        isDraft: false,
        body: '',
        statusCheckRollup: [],
        baseRefName: 'main',
        headRefName: 'feature/pull-request',
        baseRefOid: headOid,
        headRefOid: headOid,
    });
    await writeFile(
        join(bin, 'gh'),
        `#!/bin/sh
case " $* " in
  *" api graphql -f "*) printf '%s' '{"data":{"rateLimit":{"limit":5000,"remaining":5000,"used":0,"resetAt":"2100-01-01T00:00:00Z"}}}' ;;
  *" pr list "*) printf '%s' '[{"number":42,"state":"OPEN","isDraft":false}]' ;;
  *) printf '%s' '${view}' ;;
esac
`,
        'utf8',
    );
    await chmod(join(bin, 'gh'), 0o755);

    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\n');
  process.exit(0);
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('Fake Claude ready\r\n');
setInterval(() => {
  const trigger = path.join(process.env.CLAUDE_CONFIG_DIR, 'trigger');
  if (!fs.existsSync(trigger)) return;
  fs.rmSync(trigger);
  process.stdout.write('metadata changed\r\n');
}, 50);
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
        testRootPath: root,
        userDataDir: userData,
    });
    try {
        const sessionId = await createProjectSession(running.page, 'claude');
        const card = sessionCard(running.page, sessionId);
        const title = card.locator('.session-copy');
        const indicators = card.locator('.session-indicators');
        const status = card.locator('.session-status');
        const pullRequest = card.locator('[data-pull-request-state="open"]');
        const startedAt = Date.now();
        const layout = async () => {
            const [rowBox, indicatorBox, titleWidth] = await Promise.all([
                card.boundingBox(),
                indicators.boundingBox(),
                title.evaluate((element) => element.getBoundingClientRect().width),
            ]);
            if (!rowBox || !indicatorBox) throw new Error('Session status layout is unavailable');
            return {
                indicatorRightGap: rowBox.x + rowBox.width - (indicatorBox.x + indicatorBox.width),
                indicatorWidth: indicatorBox.width,
                titleWidth,
            };
        };
        const expectRightEdge = async (glyph: typeof pullRequest) => {
            const [indicatorBox, glyphBox] = await Promise.all([
                indicators.boundingBox(),
                glyph.boundingBox(),
            ]);
            if (!indicatorBox || !glyphBox)
                throw new Error('Session status glyph layout is unavailable');
            expect(indicatorBox.width).toBeGreaterThanOrEqual(14);
            expect(
                indicatorBox.x + indicatorBox.width - (glyphBox.x + glyphBox.width),
            ).toBeLessThanOrEqual(1);
        };

        await expect(pullRequest).toBeVisible();
        const idleLayout = await layout();
        expect(idleLayout.indicatorRightGap).toBeLessThanOrEqual(10);
        await expectRightEdge(pullRequest);

        await writeClaudeMetadata(config, root, startedAt, 'busy');
        await expect(status).toHaveAttribute('data-session-status', 'running');
        // Lifecycle outranks delivery: the running glyph takes the pull request's right-edge slot.
        await expect(pullRequest).toHaveCount(0);
        await expectRightEdge(status);
        await expect(status).toHaveAccessibleName('Working. The Agent is running.');

        // Collapsing the Project must not fold a running Agent out of sight: the heading summarizes it.
        const projectTitle = running.page.getByRole('treeitem', { name: /^project \(/u });
        const agentSummary = running.page.locator('.project-agent-summary');
        // Pointer still on the heading and focus still on the chevron: the summary shows at once.
        await running.page.locator('.project-disclosure').first().click();
        await expect(agentSummary).toBeVisible();
        await expect(agentSummary).toHaveAttribute('data-project-running', '1');
        await expect(projectTitle).toHaveAccessibleName('project (1 Session), 1 running');
        await running.page.locator('.project-disclosure').first().click();
        await expect(agentSummary).toHaveCount(0);
        await expect(status).toBeVisible();
        const runningLayout = await layout();
        expect(runningLayout.indicatorRightGap).toBe(idleLayout.indicatorRightGap);
        expect(runningLayout.indicatorWidth).toBe(idleLayout.indicatorWidth);
        expect(runningLayout.titleWidth).toBe(idleLayout.titleWidth);

        // PR details stay reachable from the hover card and the context menu.
        await card.hover();
        const hoverCard = running.page.locator('.session-activity-card');
        await expect(hoverCard).toBeVisible();
        await expect(hoverCard).toContainText('#42');
        await expect(hoverCard).toContainText('Pull request lifecycle fixture');
        await running.page.keyboard.press('Escape');
        await expect(hoverCard).toBeHidden();
        await card.click({ button: 'right' });
        await expect(contextMenuLabels(running.app)).resolves.toContain('Open Pull Request #42');
        await dismissContextMenu(running.app);
        await running.page.mouse.move(500, 300);

        await writeClaudeMetadata(config, root, startedAt, 'idle');
        await expect(status).toHaveAttribute('data-session-status', 'default');
        await expect(pullRequest).toBeVisible();
        const settledLayout = await layout();
        await expectRightEdge(pullRequest);
        expect(settledLayout.indicatorRightGap).toBe(idleLayout.indicatorRightGap);
        expect(settledLayout.indicatorWidth).toBe(idleLayout.indicatorWidth);
        expect(settledLayout.titleWidth).toBe(idleLayout.titleWidth);

        // Move the Session out of view so a completed turn creates unread attention for the same PR row.
        await createAdditionalShellSession(running.page);
        await writeClaudeMetadata(config, root, startedAt, 'busy');
        await expect(status).toHaveAttribute('data-session-status', 'running');
        await writeClaudeMetadata(config, root, startedAt, 'completed');
        await expect(status).toHaveAttribute('data-session-status', 'attention');
        await expect(pullRequest).toHaveCount(0);
        await expectRightEdge(status);
        const attentionLayout = await layout();
        expect(attentionLayout.indicatorRightGap).toBe(idleLayout.indicatorRightGap);
        expect(attentionLayout.indicatorWidth).toBe(idleLayout.indicatorWidth);
        expect(attentionLayout.titleWidth).toBe(idleLayout.titleWidth);

        const unread = await pageRequest<{
            sessions: Array<{ attentionEpoch: number; hasUnread: boolean; id: string }>;
        }>(running.page, 'app.bootstrap');
        const unreadSession = unread.sessions.find((session) => session.id === sessionId);
        if (!unreadSession?.hasUnread)
            throw new Error('Lifecycle fixture did not create unread attention');
        await pageRequest(running.page, 'session.markRead', {
            attentionEpoch: unreadSession.attentionEpoch,
            sessionId,
        });
        await expect(status).toHaveAttribute('data-session-status', 'default');
        await expect(pullRequest).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
