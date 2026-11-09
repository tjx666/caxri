import { openAgentChat } from './support/agent-chat-fixture.ts';
import { selectSession } from './support/delegated-sessions-fixture.ts';
import { createParentSession, launchDelegatingChat } from './support/delegating-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, VISIBLE_SESSION } from './support/helpers.ts';
import { runServerDatabase } from './support/run-server-database.ts';
import type {
    DeepDelegatedChatSeed,
    DelegatedChatSeed,
} from './support/server-database/delegated-chat-seed.ts';

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

        // A failed task that never launched a Terminal has nothing to open: its row carries the failure and stays
        // plain, instead of leading to an empty Session page. A child that did not fail still opens.
        await expect(rowOf(seed.quota).locator(':scope > button')).toHaveCount(0);
        await expect(rowOf(seed.consult).locator(':scope > button')).toHaveCount(1);

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
 * A grandchild that needs the user is rolled up into the host's strip: its row reads "via" the direct child it sits
 * under, and the header counts it.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the strip rolls up a failed grandchild and names the direct child it sits under', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-deep-');
    try {
        const { projectId, sessionId: hostId } = await createParentSession(chat);
        await chat.writeScript(projectId);
        await openAgentChat(chat.running.page, 'Codex Chat');
        await chat.running.app.close();
        const seed = await runServerDatabase<DeepDelegatedChatSeed>('delegated-chat-seed', {
            userData: chat.userData,
            phase: 'deep',
            hostSessionId: hostId,
            projectId,
        });
        chat.running = await launchCaxri(chat.launchOptions);
        const { page } = chat.running;
        await selectSession(page, hostId);
        const strip = page
            .locator(VISIBLE_SESSION)
            .getByRole('region', { name: 'Delegated Sessions' });
        await expect(strip).toContainText('1 delegated');
        await expect(strip).toContainText('1 failed');
        const deeper = strip.locator(`[data-agent-chat-delegated-session="${seed.leaf}"]`);
        await expect(deeper).toContainText('Port the billing exports');
        await expect(deeper).toContainText('via Coordinate the migration');
        await page.screenshot({ path: testInfo.outputPath('delegated-via.png') });
    } finally {
        await chat.cleanup();
    }
});
