import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { openAgentChat } from './support/agent-chat-fixture.ts';
import { countRequests } from './support/agent-chat-switch-samples.ts';
import { openCaxriBot } from './support/caxri-bot.ts';
import { selectSession } from './support/delegated-sessions-fixture.ts';
import {
    CHILD_SUMMARY,
    CHILD_TITLE,
    createParentSession,
    DELEGATE_PROMPT,
    DELEGATING_PROJECT,
    HOLD_CHILD_FILE,
    launchDelegatingChat,
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
