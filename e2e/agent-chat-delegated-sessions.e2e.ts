import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { openAgentChat } from './support/agent-chat-fixture.ts';
import { countRequests } from './support/agent-chat-switch-samples.ts';
import { openCaxriBot } from './support/caxri-bot.ts';
import { writeCodexUsageRollout } from './support/codex-usage-rollout.ts';
import { selectSession } from './support/delegated-sessions-fixture.ts';
import {
    CHILD_SUMMARY,
    CHILD_TITLE,
    createParentSession,
    DELEGATE_PROMPT,
    DELEGATING_PROJECT,
    HOLD_CHILD_FILE,
    launchDelegatingChat,
    RETRY_NOTICE_REPLY,
} from './support/delegating-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest, selectedSessionId, VISIBLE_SESSION } from './support/helpers.ts';
import { runServerDatabase } from './support/run-server-database.ts';
import type { DelegatedChatSeed } from './support/server-database/delegated-chat-seed.ts';

/**
 * A real delegation, end to end: the parent Chat's fake Agent runs the Caxri CLI (`agent delegate create
 * --new-session`) as a shell command, so the Server records the child's origin and the caller's turn itself. The child
 * is a fake Chat held until the spec releases it, so the strip is observed running and then completed.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat shows the Session it delegated to as a strip row and a timeline record, and the child links back', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-chat-');
    try {
        const { page } = chat.running;
        const { projectId, sessionId: parentId } = await createParentSession(chat);
        const parent = (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
            (session) => session.id === parentId,
        )!;
        await chat.writeScript(projectId);
        await writeFile(join(chat.controlDirectory, HOLD_CHILD_FILE), '');
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill(DELEGATE_PROMPT);
        await message.press('Enter');

        // The child is running: the strip appears with one row and the running glyph.
        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        await expect(strip).toBeVisible();
        await expect(strip).toContainText('1 delegated');
        const row = strip.locator('[data-agent-chat-delegated-session]');
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(CHILD_TITLE);
        await expect(row).toContainText(DELEGATING_PROJECT);
        await expect(row.locator('[data-agent-chat-delegation-glyph="running"]')).toBeVisible();
        const childId = (await row.getAttribute('data-agent-chat-delegated-session'))!;
        await page.screenshot({ path: testInfo.outputPath('delegated-running.png') });

        // Released, the child's authored Summary line becomes the row's result.
        await rm(join(chat.controlDirectory, HOLD_CHILD_FILE));
        await expect(row).toContainText(CHILD_SUMMARY);
        await expect(row.locator('[data-agent-chat-delegation-glyph="running"]')).toHaveCount(0);
        await expect(row).not.toContainText('Excerpt');
        await page.screenshot({ path: testInfo.outputPath('delegated-completed.png') });

        // The timeline keeps a record of the delegation after the parent's turn folded.
        const record = session.locator('[data-agent-chat-delegation-record]');
        await expect(record).toHaveCount(1);
        await expect(record).toContainText(`Delegated to ${CHILD_TITLE} · ${DELEGATING_PROJECT}`);
        await expect(session.getByRole('button', { name: /^Worked(?: for |$)/u })).toBeVisible();

        // The record opens the child, which says where it came from and links back.
        await record.click();
        await expect.poll(() => selectedSessionId(page)).toBe(childId);
        // The parent is now a hidden kept-alive Chat: it must not read task states while the child's pushes arrive.
        const hiddenStatusReads = await countRequests(chat.userData, 'agent.delegation.statuses');
        const origin = session.locator('[data-agent-chat-delegation-origin="delegated"]');
        await expect(origin).toContainText(`Delegated from ${parent.title}`);
        await expect(origin).toContainText('The result goes back automatically');
        await expect(origin).toContainText('takes over this Session');
        const bubble = session.locator('[data-agent-chat-delegated-task]');
        await expect(bubble).toContainText('Delegated by');
        await expect(bubble).toContainText(parent.title);
        await expect(bubble).toContainText(`· ${DELEGATING_PROJECT}`);
        await page.screenshot({ path: testInfo.outputPath('delegated-child.png') });
        await origin.getByRole('button', { name: `Back to ${parent.title}` }).click();
        await expect.poll(() => selectedSessionId(page)).toBe(parentId);

        // Typing in the child takes it over; the later reply never replaces the parent's result.
        await selectSession(page, childId);
        const childMessage = session.getByRole('textbox', { name: 'Message' });
        await childMessage.fill('One more question');
        await childMessage.press('Enter');
        const takenOver = session.locator('[data-agent-chat-delegation-origin="taken-over"]');
        await expect(takenOver).toContainText('You took over this Session');
        await expect(takenOver).toContainText(`its replies no longer go back to ${parent.title}`);
        await expect(session.locator('[data-agent-chat-takeover-divider]')).toBeVisible();
        await expect(session.getByText('You said: One more question')).toBeVisible();
        // The takeover pushed state for the child while the parent stayed hidden: no statuses read followed it.
        await page.waitForTimeout(500);
        expect(await countRequests(chat.userData, 'agent.delegation.statuses')).toBe(
            hiddenStatusReads,
        );
        await page.screenshot({ path: testInfo.outputPath('delegated-taken-over.png') });

        await selectSession(page, parentId);
        await expect(strip.locator('[data-agent-chat-delegated-session]')).toContainText(
            CHILD_SUMMARY,
        );
        await expect(strip).not.toContainText('You said');
        await expect(session.locator('[data-agent-chat-delegation-record]')).toContainText(
            `Delegated to ${CHILD_TITLE}`,
        );

        // The task's own conversation reads back as typed rows, ending before the message that took it over.
        const { delegations } = await pageRequest<{
            delegations: Array<{ delegationId: string }>;
        }>(page, 'agent.delegation.list', { active: false, limit: 1 });
        const transcript = await pageRequest<{
            status: string;
            settled: boolean;
            rows: Array<{ kind: string; text?: string }>;
        }>(page, 'agent.delegation.transcript', { delegationId: delegations[0].delegationId });
        expect(transcript).toMatchObject({ status: 'available', settled: true });
        expect(transcript.rows[0]).toMatchObject({ kind: 'task' });
        expect(transcript.rows.at(-1)).toMatchObject({
            kind: 'agentMessage',
            text: `Reviewed the retry design.\n\nSummary: ${CHILD_SUMMARY}`,
        });
        expect(JSON.stringify(transcript.rows)).not.toContain('One more question');
    } finally {
        await chat.cleanup();
    }
});

/**
 * Children seeded in the states the strip words specially. A delegated Session can only be created by a Server-side
 * Agent, so the host Chat is created first, the app is closed, the children are written for that host, and the app is
 * launched again on the same profile.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the strip words a usage limit, a task that needs input, an unreadable result, and a consult', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-states-');
    try {
        const { projectId, sessionId: hostId } = await createParentSession(chat);
        await chat.writeScript(projectId);
        await openAgentChat(chat.running.page, 'Codex Chat');
        await chat.running.app.close();
        const seed = await runServerDatabase<DelegatedChatSeed>('delegated-chat-seed', {
            userData: chat.userData,
            phase: 'children',
            hostSessionId: hostId,
            projectId,
        });
        chat.running = await launchCaxri(chat.launchOptions);
        const { page } = chat.running;
        await selectSession(page, hostId);
        const session = page.locator(VISIBLE_SESSION);
        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        await expect(strip).toBeVisible();
        await expect(strip).toContainText('4 delegated · 1 failed');

        // A task that needs input exists only once the Server runs (startup turns every active task into an interrupted
        // one), so it is recorded now and the Renderer is reloaded to read the feed again.
        await runServerDatabase('delegated-chat-seed', {
            phase: 'blocked',
            blockedSessionId: seed.needsInput,
            userData: chat.userData,
            hostSessionId: hostId,
            projectId,
        });
        await page.reload();
        await expect(strip).toBeVisible();

        // Header: every child counts; only input-needed and failed are called out, and an unreadable result is neither.
        await expect(strip).toContainText('4 delegated');
        await expect(strip).toContainText('1 needs input');
        await expect(strip).toContainText('1 failed');
        const rowOf = (id: string) => strip.locator(`[data-agent-chat-delegated-session="${id}"]`);

        // The reset time is the pinned future one: 5 days 12 hours ahead when seeded, so the days never drift.
        await expect(rowOf(seed.quota)).toContainText(/usage limit used up/u);
        await expect(rowOf(seed.quota)).toContainText(/resets in 5d/u);
        await expect(
            rowOf(seed.quota).locator('[data-agent-chat-delegation-glyph="failed"]'),
        ).toBeVisible();

        await expect(rowOf(seed.needsInput)).toContainText('Needs your input');
        await expect(
            rowOf(seed.needsInput).locator('[data-agent-chat-delegation-glyph="needsInput"]'),
        ).toBeVisible();

        await expect(rowOf(seed.answerUnavailable)).toContainText(
            'Finished, but its result could not be read',
        );
        await expect(
            rowOf(seed.answerUnavailable).locator('[data-agent-chat-delegation-glyph]'),
        ).toHaveCount(0);

        await expect(rowOf(seed.consult)).toContainText('Quick second opinion');
        await page.screenshot({ path: testInfo.outputPath('delegated-states.png') });

        // The rows that need attention come first.
        const order = await strip
            .locator('[data-agent-chat-delegated-session]')
            .evaluateAll((rows) => rows.map((row) => row.dataset.agentChatDelegatedSession));
        expect(order.slice(0, 2)).toEqual([seed.needsInput, seed.quota]);
    } finally {
        await chat.cleanup();
    }
});

/**
 * A task admitted with a preset shows its name as a chip on the strip row and on the child's origin row. The provider,
 * model and effort come from the selection frozen on the receipt: the strip row reads them from its tooltip, which also
 * opens on keyboard focus, and the origin row prints them.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a delegated task shows the preset it was admitted with on the strip and the origin row', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-preset-', { preset: 'review' });
    try {
        const { page } = chat.running;
        const { projectId } = await createParentSession(chat);
        await chat.writeScript(projectId);
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill(DELEGATE_PROMPT);
        await message.press('Enter');

        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        const row = strip.locator('[data-agent-chat-delegated-session]');
        await expect(row).toContainText(CHILD_SUMMARY);
        const childId = (await row.getAttribute('data-agent-chat-delegated-session'))!;
        await expect(row.locator('[data-delegation-preset="review"]')).toBeVisible();

        // The row's button names itself with the chip's screen-reader text, and a keyboard user sees the same sentence.
        const detail = 'review: Codex, Provider default model, high';
        const summary = 'Preset review: Codex, Provider default model, high';
        const button = row.getByRole('button', {
            name: /review\s*:\s*Codex, Provider default model, high/u,
        });
        await button.focus();
        await expect(page.locator('.tooltip-popup')).toContainText(summary);
        await page.screenshot({ path: testInfo.outputPath('delegated-preset-strip.png') });

        await button.click();
        await expect.poll(() => selectedSessionId(page)).toBe(childId);
        const origin = session.locator('[data-agent-chat-delegation-origin="delegated"]');
        await expect(origin.locator('[data-delegation-preset="review"]')).toContainText(detail);
        await page.screenshot({ path: testInfo.outputPath('delegated-preset-origin.png') });
    } finally {
        await chat.cleanup();
    }
});

/**
 * Caxri Bot's window has no pane layout to open a Session in, so it hides the strip and the records even for a Chat
 * that did delegate. Caxri Bot cannot create a Session itself, so its children are seeded for its own Session while the
 * app is closed, and the Workbench's feed read proves they exist.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the Caxri Bot window shows no Delegated Sessions region', async ({}) => {
    const chat = await launchDelegatingChat('caxri-delegated-bot-');
    try {
        await createParentSession(chat);
        await openCaxriBot(chat.running.page);
        const { identity } = await pageRequest<{
            identity: { projectId: string; sessionId: string };
        }>(chat.running.page, 'bot.snapshot');
        await chat.writeScript(identity.projectId);
        await chat.running.app.close();
        await runServerDatabase('delegated-chat-seed', {
            phase: 'children',
            userData: chat.userData,
            hostSessionId: identity.sessionId,
            projectId: identity.projectId,
        });
        chat.running = await launchCaxri(chat.launchOptions);
        const { page } = chat.running;
        await openCaxriBot(page);
        await expect.poll(() => chat.running.app.windows().length).toBe(2);
        const bot = chat.running.app.windows().find((window) => window !== page)!;
        const feed = await pageRequest<{ sessions: unknown[] }>(page, 'agent.delegation.sessions', {
            createdBySessionIds: [identity.sessionId],
        });
        expect(feed.sessions).toHaveLength(4);

        await bot
            .getByRole('group', { name: 'Open as Terminal or Chat' })
            .getByRole('button', { name: 'Chat' })
            .click();
        const message = bot.getByRole('textbox', { name: 'Message' });
        await message.fill('hello');
        await message.press('Enter');
        // A settled reply means the Chat and its composer strip rendered, so the absence below is not an early read.
        await expect(bot.getByText('You said: hello')).toBeVisible();
        await expect(bot.getByRole('region', { name: 'Delegated Sessions' })).toHaveCount(0);
        await expect(bot.locator('[data-agent-chat-delegation-record]')).toHaveCount(0);
    } finally {
        await chat.cleanup();
    }
});

interface FeedSession {
    delegationId?: string;
    retriedAs?: string;
    retryOf?: string;
    sessionId: string;
    status?: string;
}

/**
 * Retry now, end to end: the parent Chat's fake Agent really delegates through the CLI, the task is then marked failed
 * in the database (a fake child cannot fail like a provider), and the owner retries it from the strip. Cancelling
 * starts nothing; the confirmed retry starts exactly one new Session, whose task file opens with the retry preface; the
 * parent hears of it; and the strip folds the failed attempt into one current row.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the owner retries a failed delegated task from the strip and the Agent that delegated it is told', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-retry-');
    try {
        const { page } = chat.running;
        const { projectId, sessionId: parentId } = await createParentSession(chat);
        await chat.writeScript(projectId);
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill(DELEGATE_PROMPT);
        await message.press('Enter');

        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        const rows = strip.locator('[data-agent-chat-delegated-session]');
        await expect(rows).toHaveCount(1);
        await expect(rows).toContainText(CHILD_SUMMARY);
        const childId = (await rows.getAttribute('data-agent-chat-delegated-session'))!;
        const feed = async () =>
            (
                await pageRequest<{ sessions: FeedSession[] }>(page, 'agent.delegation.sessions', {
                    createdBySessionIds: [parentId],
                })
            ).sessions;

        const failedId = await runServerDatabase<string>('delegation-failure', {
            userData: chat.userData,
            sessionId: childId,
        });
        await page.reload();
        await expect(strip).toContainText('1 failed');
        const retryAction = strip.locator(`[data-delegation-retry="${failedId}"]`);
        const chooseFresh = async () => {
            await retryAction.click();
            await page.locator('[data-delegation-retry-mode="fresh"]').click();
        };
        await page.screenshot({ path: testInfo.outputPath('delegation-retry-failed.png') });

        // Cancelling the confirmation starts nothing.
        await chooseFresh();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('Retry in a new Session?');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toHaveCount(0);
        await page.waitForTimeout(500);
        expect(await feed()).toHaveLength(1);
        await expect(rows).toHaveCount(1);

        // Confirmed, with two more requests racing the click: still exactly one successor.
        await chooseFresh();
        const raced = [
            pageRequest(page, 'agent.delegation.retry', { delegationId: failedId, mode: 'fresh' }),
            pageRequest(page, 'agent.delegation.retry', { delegationId: failedId, mode: 'fresh' }),
        ];
        await dialog.getByRole('button', { name: 'Retry', exact: true }).dblclick();
        await Promise.allSettled(raced);
        await expect.poll(async () => (await feed()).length).toBe(2);
        await page.waitForTimeout(500);
        const sessions = await feed();
        expect(sessions).toHaveLength(2);
        const failed = sessions.find((entry) => entry.delegationId === failedId)!;
        const successor = sessions.find((entry) => entry.retryOf === failedId)!;
        expect(failed.retriedAs).toBe(successor.delegationId);
        expect(successor.sessionId).not.toBe(childId);

        // The new task opens with the retry preface.
        const taskFile = join(chat.userData, 'delegations', successor.delegationId!, 'task.md');
        expect(await readFile(taskFile, 'utf8')).toContain(
            'A previous attempt at this task failed before finishing.',
        );

        // The strip folds the failed attempt into one current row, labeled as the second attempt.
        await expect(rows).toHaveCount(1);
        await expect(rows).toHaveAttribute(
            'data-agent-chat-delegated-session',
            successor.sessionId,
        );
        await expect(rows).toContainText('Attempt 2');
        await expect(rows).toContainText(CHILD_SUMMARY);
        await expect(strip).not.toContainText('failed');

        // The Agent that delegated the task heard of the retry through its own Chat.
        await expect(session.getByText(RETRY_NOTICE_REPLY)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('delegation-retry-done.png') });
    } finally {
        await chat.cleanup();
    }
});

/**
 * The cost of a real delegated Chat. The parent's fake Agent delegates through the Caxri CLI, so the child is a real
 * Session with a real Chat Terminal. The fake Codex writes no native usage, so the spec gives the child's thread a
 * rollout in the isolated `CODEX_HOME`; the Server's own ledger scan turns it into the child's cost (no ledger row is
 * seeded).
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the strip states the estimated cost of a delegated Chat per row and in the header, with ~ while it runs', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-cost-');
    try {
        const { page } = chat.running;
        const { projectId } = await createParentSession(chat);
        await chat.writeScript(projectId);
        await writeFile(join(chat.controlDirectory, HOLD_CHILD_FILE), '');
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill(DELEGATE_PROMPT);
        await message.press('Enter');

        const strip = session.getByRole('region', { name: /^Delegated Sessions/u });
        const row = strip.locator('[data-agent-chat-delegated-session]');
        await expect(row).toHaveCount(1);
        const childId = (await row.getAttribute('data-agent-chat-delegated-session'))!;

        // No usage yet: the strip states no cost, rather than $0.
        await expect(strip).not.toContainText('$');

        // The running child's Chat binds a native thread; give that thread usage.
        let threadId: string | undefined;
        await expect
            .poll(async () => {
                const state = await pageRequest<BootstrapState>(page, 'app.bootstrap');
                threadId = state.terminals.find(
                    (terminal) => terminal.sessionId === childId && terminal.agentSessionId,
                )?.agentSessionId;
                return threadId;
            })
            .toBeTruthy();
        await writeCodexUsageRollout(chat.userData, {
            cwd: chat.directory,
            inputTokens: 2_000_000,
            outputTokens: 100_000,
            threadId: threadId!,
        });

        // While the child runs, the figure is marked `~` on the row and in the header.
        const rowCost = row.locator('span[aria-hidden="true"]', { hasText: '$' });
        await expect(rowCost).toHaveText(/^~\$\d+\.\d\d$/u, { timeout: 45_000 });
        await expect(strip).toContainText(/delegated · ~\$\d+\.\d\d/u);
        await page.screenshot({ path: testInfo.outputPath('delegated-cost-running.png') });

        // Released, the child settles and the same figure loses the marker.
        await rm(join(chat.controlDirectory, HOLD_CHILD_FILE));
        await expect(row).toContainText(CHILD_SUMMARY);
        await expect(rowCost).toHaveText(/^\$\d+\.\d\d$/u, { timeout: 45_000 });
        await expect(strip).toContainText(/delegated · \$\d+\.\d\d/u);
        await expect(strip).not.toContainText('~');
        await page.screenshot({ path: testInfo.outputPath('delegated-cost-settled.png') });

        // The header's figure and the row's agree, and hovering the header states the basis.
        const rowAmount = (await rowCost.textContent())!;
        await expect(strip).toContainText(`delegated · ${rowAmount}`);
        await strip.locator('[data-agent-chat-delegated-cost]').hover();
        await expect(page.getByText('Estimated at API list prices')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('delegated-cost-tooltip.png') });
    } finally {
        await chat.cleanup();
    }
});
