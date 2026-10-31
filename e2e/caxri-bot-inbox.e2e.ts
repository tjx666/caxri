import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { BotInboxItem } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { openCaxriBot } from './support/caxri-bot.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createShellSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';

const PULL_REQUEST_URL = 'https://github.com/caxri-e2e/project/pull/42';
const VERIFIED_HEAD = 'a'.repeat(40);

/**
 * A `gh` that answers the quota probe, reports the pull request open at the head Caxri Bot verified with passing
 * checks, allows only squash merges, and records every `pr merge` argv (one argument per line) instead of merging.
 */
async function writeFakeGh(bin: string, mergeLog: string): Promise<void> {
    const view = JSON.stringify({
        number: 42,
        title: 'Fix the import retry',
        url: PULL_REQUEST_URL,
        state: 'OPEN',
        isDraft: false,
        body: '',
        statusCheckRollup: [
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'Build' },
        ],
        baseRefName: 'main',
        headRefName: 'fix/import-retry',
        baseRefOid: 'b'.repeat(40),
        headRefOid: VERIFIED_HEAD,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
    });
    await writeFile(
        join(bin, 'gh'),
        String.raw`#!/bin/sh
case " $* " in
  *" api graphql -f "*) printf '%s' '{"data":{"rateLimit":{"limit":5000,"remaining":5000,"used":0,"resetAt":"2100-01-01T00:00:00Z"}}}' ;;
  *" repo view "*) printf '%s' '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}' ;;
  *" pr merge "*) printf '%s\n' "$@" >> '${mergeLog}' ;;
  *) printf '%s' '${view}' ;;
esac
`,
        'utf8',
    );
    await chmod(join(bin, 'gh'), 0o755);
}

async function mergeArguments(path: string): Promise<string[]> {
    try {
        return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

/**
 * The Caxri Bot window's "Needs you" column end to end (#1758): items Caxri Bot raised appear grouped with counts, an
 * `@` mention picks which question a typed reply answers, Dismiss offers Undo, Merge pins `gh` to the head Caxri Bot
 * verified, and a narrow window turns the column into a drawer over the Terminal.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Caxri Bot Needs you column groups, replies, dismisses, merges, and becomes a drawer', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-inbox-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const bin = join(directory, 'bin');
    const mergeLog = join(directory, 'gh-merge.log');
    await mkdir(root);
    await mkdir(bin);
    await writeFakeGh(bin, mergeLog);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    const botWindow = async (): Promise<Page> => {
        await expect.poll(() => running.app.windows().length).toBe(2);
        return running.app.windows().find((page) => page !== running.page)!;
    };
    try {
        await createShellSession(running.page);
        const merge = await pageRequest<BotInboxItem>(running.page, 'bot.inbox.add', {
            kind: 'merge',
            title: 'Import retry fix is ready',
            body: '**Bug:** imports stopped after one failure.',
            pullRequest: { url: PULL_REQUEST_URL, headSha: VERIFIED_HEAD },
        });
        const database = await pageRequest<BotInboxItem>(running.page, 'bot.inbox.add', {
            kind: 'decision',
            title: 'Which database should the import use?',
        });
        const release = await pageRequest<BotInboxItem>(running.page, 'bot.inbox.add', {
            kind: 'decision',
            title: 'Approve the release?',
        });

        await openCaxriBot(running.page);
        const bot = await botWindow();
        await bot.setViewportSize({ width: 1400, height: 800 });
        const inbox = bot.locator('.caxri-bot-inbox');
        await expect(inbox).toBeVisible();
        const card = (item: BotInboxItem) => inbox.locator(`[data-inbox-item-id="${item.id}"]`);

        // Questions come first, then pull requests Caxri Bot verified, each heading carrying its count.
        const questions = inbox.locator('[data-inbox-section="questions"]');
        const ready = inbox.locator('[data-inbox-section="merge"]');
        await expect(inbox.locator('.bot-inbox-section h3')).toHaveText([
            'Questions · 2',
            'Ready to merge · 1',
        ]);
        await expect(questions.locator('.bot-inbox-item')).toHaveCount(2);
        await expect(ready.locator(`[data-inbox-item-id="${merge.id}"]`)).toBeVisible();
        // GitHub reports the verified head with passing checks, so the card offers Merge.
        await expect(card(merge).getByText('Checks passed')).toBeVisible();
        await bot.screenshot({ path: testInfo.outputPath('inbox-grouped.png') });

        // With two open questions nothing is the reply target until `@` picks one.
        const input = inbox.locator('.bot-inbox-input');
        await expect(inbox.locator('.bot-inbox-target')).toHaveCount(0);
        await input.click();
        await input.pressSequentially('@Approve');
        const suggestions = bot.getByRole('listbox', { name: 'Inbox items' });
        await expect(suggestions.getByRole('option')).toHaveCount(1);
        await expect(suggestions.getByRole('option')).toContainText('Approve the release?');
        await input.press('Enter');
        await expect(inbox.locator('.bot-inbox-target')).toHaveText('Approve the release?');
        await expect(card(release)).toHaveAttribute('data-inbox-target', 'true');
        await expect(input).toHaveValue('');
        await input.pressSequentially('Yes, ship it after the checks pass.');
        await input.press('Enter');
        // Caxri Bot is not running to read it, so the reply stays delivered rather than read.
        await expect(card(release).locator('.bot-inbox-replies')).toContainText(
            'Yes, ship it after the checks pass.',
        );
        await expect(card(release).locator('.bot-inbox-reply-state')).toHaveText(
            'Delivered to Caxri Bot',
        );
        await expect(input).toHaveValue('');

        // Dismiss acts at once without asking: the item leaves the column and a toast offers Undo, which puts it back
        // because the request is only sent once the Undo window ends.
        await card(database).locator('.bot-inbox-dismiss').click();
        await expect(bot.getByRole('dialog')).toHaveCount(0);
        await expect(card(database)).toHaveCount(0);
        await expect(questions.locator('h3')).toHaveText('Questions · 1');
        // The header badge stops counting the item with the list, not when the Undo window ends.
        const inboxCount = bot.locator('.caxri-bot-inbox-count');
        await expect(inboxCount).toHaveText('2');
        const dismissedToast = bot.locator('[data-sonner-toast]').filter({ hasText: 'Dismissed' });
        await bot.screenshot({ path: testInfo.outputPath('bot-inbox-dismissed.png') });
        await dismissedToast.getByRole('button', { name: 'Undo' }).click();
        await expect(card(database)).toHaveCount(1);
        await expect(questions.locator('h3')).toHaveText('Questions · 2');
        await expect(inboxCount).toHaveText('3');
        await bot.screenshot({ path: testInfo.outputPath('bot-inbox-undone.png') });
        await card(database).locator('.bot-inbox-dismiss').click();
        await expect(card(database)).toHaveCount(0);
        await expect(questions.locator('h3')).toHaveText('Questions · 1');

        // Merge asks first, then calls `gh` pinned to the verified head and closes the item.
        await card(merge).locator('.bot-inbox-merge').click();
        const mergeDialog = bot.getByRole('dialog', {
            name: 'Merge caxri-e2e/project#42?',
        });
        await expect(mergeDialog).toContainText(VERIFIED_HEAD.slice(0, 7));
        await mergeDialog.getByRole('button', { name: 'Merge', exact: true }).click();
        await expect
            .poll(() => mergeArguments(mergeLog))
            .toEqual([
                'pr',
                'merge',
                '42',
                '--repo',
                'caxri-e2e/project',
                '--squash',
                '--match-head-commit',
                VERIFIED_HEAD,
            ]);
        await expect(card(merge)).toHaveCount(0);
        await expect(ready).toHaveCount(0);
        await bot.screenshot({ path: testInfo.outputPath('inbox-after-actions.png') });

        /**
         * Beside the Terminal in a wide window; in a narrow one the column overlays it as a drawer.
         */
        const position = () => inbox.evaluate((element) => getComputedStyle(element).position);
        expect(await position()).toBe('static');
        await bot.setViewportSize({ width: 900, height: 700 });
        await expect.poll(position).toBe('absolute');
        const inboxToggle = bot.getByRole('button', { name: /^Needs you/u });
        await inboxToggle.click();
        await expect(inbox).toHaveCount(0);
        await inboxToggle.click();
        await expect(inbox).toBeVisible();
        await expect.poll(position).toBe('absolute');
        await expect(card(release)).toBeVisible();
        await bot.screenshot({ path: testInfo.outputPath('inbox-narrow-drawer.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
