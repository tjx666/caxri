import { appendFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageLimit } from '@caxri/protocol';

import {
    fakeClaudeChatAgentMode,
    fakeCodexChatProvider,
    openAgentChat,
} from './support/agent-chat-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import { setOpenAgentsIn } from './support/open-agents-in.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test("a running Claude Chat reports its plan's 5-hour and weekly limits and warns when the week runs ahead of pace", async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-plan-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const control = join(directory, 'control');
    await mkdir(root, { recursive: true });
    await mkdir(control, { recursive: true });
    // The fake's `/usage` answer: 5-hour 22% used, weekly 61% used with 5 days 3 hours to go (an even pace leaves 73%).
    await writeFile(join(control, 'plan-behind-pace'), '');
    const agentMode = await fakeClaudeChatAgentMode(userData, control);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
        await setOpenAgentsIn(terminalMenu, 'Chat');
        await chooseTerminalFromCreateMenu(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveAttribute('aria-placeholder', 'Message Claude');
        await expect(
            chat.getByRole('button', { name: 'Model: Default, Medium effort', exact: true }),
        ).toBeVisible();
        await message.fill('hi there');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Claude. You said: hi there')).toBeVisible();

        // Claude Code writes no limits into its transcript; the running Chat answered `/usage` for the status bar. The
        // chip leaves the 5-hour window out by default for a plan without a 5-hour-bound tier, and a week ahead of pace marks it as a warning that is dropped
        // last when the status bar runs out of room.
        const usageChip = page.getByRole('button', { name: /^Open Usage/u });
        await expect(usageChip).toContainText('wk 39% left');
        await expect(usageChip).not.toContainText('5h');
        await expect(usageChip).toHaveAttribute('data-status-urgent', '');
        await expect(usageChip).toHaveClass(/text-warning/u);

        // The hover card names the subscription plan and keeps its notes to the one sentence explaining the warning.
        await usageChip.hover();
        const usageCard = page.locator('.tooltip-popup');
        await expect(usageCard).toContainText('PlanClaude Max');
        await expect(usageCard).toContainText(
            'Weekly limit runs out before it resets at this rate.',
        );
        await expect(usageCard).not.toContainText('API list prices');
        await page.screenshot({ path: testInfo.outputPath('claude-usage-card.png') });
        await page.mouse.move(1, 1);
        await expect(usageCard).toHaveCount(0);

        const pace = chat.locator('[data-agent-chat-plan-pace-alert]');
        await expect(pace).toContainText(
            'Weekly limit on track to run out: 39% left, resets in 5d',
        );
        await page.screenshot({ path: testInfo.outputPath('claude-plan-pace-alert.png') });
        // Leave the pace alert first so the hover below is a fresh pointer entry, not a continuation.
        await page.mouse.move(1, 1);
        await pace.getByText(/^Weekly limit on track to run out/u).hover();
        await expect(page.locator('.tooltip-popup')).toContainText(
            'would still have about 73% left now',
        );

        await pace.getByRole('button', { name: 'Hide for today' }).click();
        await expect(pace).toHaveCount(0);
        await expect(message).toBeVisible();
        // The dismissal also acknowledges the chip's pace warning for today; 39% left is far from nearly spent.
        await expect(usageChip).not.toHaveClass(/text-warning/u);
        await expect(usageChip).not.toHaveAttribute('data-status-urgent', '');
        await expect(usageChip).toContainText('wk 39% left');

        // The Server keeps the dismissal, so the next poll does not bring the row back and a reloaded Renderer (as after
        // a restart, or another Client) reads it hidden too.
        await expect
            .poll(async () => {
                const limits = await pageRequest<UsageLimit[]>(page, 'usage.limits', {});
                return limits.find((limit) => limit.provider === 'claude')?.paceDismissedAt;
            })
            .toBeGreaterThan(0);
        await page.reload();
        await expect(usageChip).toContainText('wk 39% left');
        await expect(usageChip).not.toHaveClass(/text-warning/u);
        await expect(chat.getByRole('textbox', { name: 'Message' })).toBeVisible();
        await expect(pace).toHaveCount(0);

        // The fake account names no rate-limit tier, so `auto` showed the weekly window; a fixed choice overrides it.
        await pageRequest(page, 'settings.update', {
            source: JSON.stringify({ 'statusBar.usage.limitWindows': 'fiveHour' }),
        });
        await expect(usageChip).toContainText('5h 78% left');
        await expect(usageChip).not.toContainText('wk');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat that used up its 5-hour limit spends a banked reset from the usage card after confirmation', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-codex-reset-credit-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            // The status bar reads a Codex conversation's usage from its rollout, so the fake writes one.
            codex: fakeCodexChatProvider(directory, join(userData, 'e2e-agents', 'codex'), true),
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('hi there');
        await message.press('Enter');
        await expect(chat.getByText(/Hello from fake Codex/u)).toBeVisible();
        // The fake Codex fails this turn on a used-up 5-hour window and banks two reset credits.
        await message.fill('usage exhausted');
        await message.press('Enter');
        const notice = chat.locator('[data-agent-chat-usage-limit="session"]');
        await expect(notice.locator('[data-agent-chat-auto-continue="waiting"]')).toBeVisible();

        // The fake records only user messages; a token count carrying the used-up windows, as Codex writes one after the
        // failed turn, makes the conversation's usage and limits readable for the chip.
        const now = Math.floor(Date.now() / 1000);
        const sessions = join(userData, 'e2e-agents', 'codex', 'sessions');
        const rollout = (await readdir(sessions, { recursive: true })).find((name) =>
            name.endsWith('.jsonl'),
        );
        if (!rollout) throw new Error('the fake Codex wrote no rollout');
        const appendTokenCount = (sessionUsed: number, weeklyUsed: number) =>
            appendFile(
                join(sessions, rollout),
                `${JSON.stringify({
                    timestamp: new Date().toISOString(),
                    type: 'event_msg',
                    payload: {
                        type: 'token_count',
                        info: { total_token_usage: { input_tokens: 1200, output_tokens: 300 } },
                        rate_limits: {
                            primary: {
                                used_percent: sessionUsed,
                                window_minutes: 300,
                                resets_at: now + 7_200,
                            },
                            secondary: {
                                used_percent: weeklyUsed,
                                window_minutes: 10_080,
                                resets_at: now + 172_800,
                            },
                        },
                    },
                })}\n`,
            );
        await appendTokenCount(100, 41);
        const usageChip = page.getByRole('button', { name: /^Open Usage/u });
        await expect(usageChip).toContainText('5h 0% left');
        await usageChip.hover();
        const usageCard = page.locator('.tooltip-popup');
        await expect(usageCard).toContainText(/Banked resets\s*2/u);
        // The fake app-server answers `account/rateLimitResetCredit/consume`; no test ever sends it to a real account.
        await usageCard.getByRole('button', { name: 'Use reset credit' }).click();
        const confirmation = page.getByRole('dialog', { name: 'Use a Codex reset credit?' });
        await expect(confirmation).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-reset-credit-confirm.png') });
        await confirmation.getByRole('button', { name: 'Use Reset Credit' }).click();

        await expect(page.getByText('Codex limits were reset.')).toBeVisible();
        // The reset is the one the Chat was waiting for, so its failed turn continues now instead of hours later.
        await expect(notice.locator('[data-agent-chat-auto-continue="continued"]')).toContainText(
            'Continued automatically',
        );
        // Codex reports the reset windows after the continued turn; the fake writes no token count, so the test does,
        // and the chip never falls back to the used-up reading above once the turn's rollout is read again.
        await appendTokenCount(0, 0);
        // Both windows read empty again; with nothing urgent the chip keeps only the weekly window.
        await expect(usageChip).toContainText('wk 100% left');
        await expect(usageChip).not.toContainText('5h 0% left');
        await page.mouse.move(1, 1);
        await usageChip.hover();
        await expect(page.locator('.tooltip-popup')).toContainText(/Banked resets\s*1/u);
        await page.screenshot({ path: testInfo.outputPath('codex-reset-credit-spent.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat at 99% of its weekly usage with extra usage keeps sending and shows a dismissible credits notice', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-credits-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const control = join(directory, 'control');
    await mkdir(root, { recursive: true });
    await mkdir(control, { recursive: true });
    // The fake's `/usage` answer: weekly 99.5% used, extra usage on with $37.40 of the monthly cap left.
    await writeFile(join(control, 'plan-weekly-guarded'), '');
    await writeFile(join(control, 'plan-extra-usage'), '');
    const agentMode = await fakeClaudeChatAgentMode(userData, control);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
        await setOpenAgentsIn(terminalMenu, 'Chat');
        await chooseTerminalFromCreateMenu(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveAttribute('aria-placeholder', 'Message Claude');
        await message.fill('hi there');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Claude. You said: hi there')).toBeVisible();

        const notice = chat.locator('[data-agent-chat-credits-notice]');
        await expect(notice).toContainText(
            'Claude weekly usage at 99%: requests continue on extra usage, $37.40 left this month',
        );
        // The guard stays off and the pace reminder gives way to the notice.
        await expect(chat.locator('[data-agent-chat-usage-guard]')).toHaveCount(0);
        await expect(chat.locator('[data-agent-chat-plan-pace-alert]')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('claude-credits-notice.png') });

        await message.fill('still going');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Claude. You said: still going')).toBeVisible();

        await notice.getByRole('button', { name: 'Hide for a day' }).click();
        await expect(notice).toHaveCount(0);
        await expect
            .poll(async () => {
                const limits = await pageRequest<UsageLimit[]>(page, 'usage.limits', {});
                return limits.find((limit) => limit.provider === 'claude')
                    ?.creditsNoticeDismissedAt;
            })
            .toBeGreaterThan(0);
        await page.reload();
        await expect(chat.getByRole('textbox', { name: 'Message' })).toBeVisible();
        await expect(notice).toHaveCount(0);
        await expect(chat.locator('[data-agent-chat-plan-pace-alert]')).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
