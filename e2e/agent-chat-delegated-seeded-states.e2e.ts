import { openAgentChat } from './support/agent-chat-fixture.ts';
import { selectSession } from './support/delegated-sessions-fixture.ts';
import { createParentSession, launchDelegatingChat } from './support/delegating-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, VISIBLE_SESSION } from './support/helpers.ts';
import { runServerDatabase } from './support/run-server-database.ts';
import type {
    DeepDelegatedChatSeed,
    DelegatedChatSeed,
    InterruptedDelegatedChatSeed,
} from './support/server-database/delegated-chat-seed.ts';

/**
 * Children seeded in the states the strip words specially. A delegated Session can only be created by a Server-side
 * Agent, so the host Chat is created first, the app is closed, the children are written for that host, and the app is
 * launched again on the same profile.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the strip words a usage limit and a task that needs input, and leaves out settled tasks', async ({}, testInfo) => {
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
        const strip = session.getByRole('region', { name: 'Background work' });
        await expect(strip).toBeVisible();
        await expect(strip).toContainText('1 failed');

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

        // Only input-needed and failed are called out, and an unreadable result is neither.
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
        // plain, instead of leading to an empty Session page.
        await expect(rowOf(seed.quota).locator('[data-agent-chat-delegated-open]')).toHaveCount(0);
        await expect(
            rowOf(seed.needsInput).locator('[data-agent-chat-delegated-open]'),
        ).toHaveCount(1);

        await expect(rowOf(seed.needsInput)).toContainText('Needs your input');
        await expect(
            rowOf(seed.needsInput).locator('[data-agent-chat-delegation-glyph="needsInput"]'),
        ).toBeVisible();

        // Settled tasks leave the list: an unreadable result and a finished consult have nothing left for the user here.
        await expect(rowOf(seed.answerUnavailable)).toHaveCount(0);
        await expect(rowOf(seed.consult)).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('delegated-states.png') });

        // The rows that need attention come first.
        const order = await strip
            .locator('[data-agent-chat-delegated-session]')
            .evaluateAll((rows) => rows.map((row) => row.dataset.agentChatDelegatedSession));
        expect(order.slice(0, 2)).toEqual([seed.needsInput, seed.quota]);

        // The failed child, opened from the sidebar, explains its failure and offers Retry instead of an empty page.
        await selectSession(page, seed.quota);
        const child = page.locator(VISIBLE_SESSION);
        await expect(child.locator('[data-delegation-failed-pane]')).toContainText(
            /usage limit used up/u,
        );
        await expect(
            child.getByRole('button', {
                name: 'Retry the failed task in Port the billing exports',
                exact: true,
            }),
        ).toBeVisible();
        await expect(child).not.toContainText('No Terminal in this Session.');
        await page.screenshot({ path: testInfo.outputPath('delegated-failed-session.png') });
    } finally {
        await chat.cleanup();
    }
});

/**
 * A grandchild that needs the user is rolled up into the host's strip: its row reads "via" the direct child it sits
 * under, and the live region counts it.
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
            .getByRole('region', { name: 'Background work' });
        await expect(strip).toContainText('1 failed');
        const deeper = strip.locator(`[data-agent-chat-delegated-session="${seed.leaf}"]`);
        await expect(deeper).toContainText('Port the billing exports');
        await expect(deeper).toContainText('via Coordinate the migration');
        await page.screenshot({ path: testInfo.outputPath('delegated-via.png') });
    } finally {
        await chat.cleanup();
    }
});

/**
 * Interruptions an earlier run left take no rows: the header counts them, shows them on request, and Clear dismisses
 * them for good, so a restart never refills the list. A real failure from that run keeps its row.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the strip counts interruptions from an earlier run in its header and clears them for good', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-interrupted-');
    try {
        const { projectId, sessionId: hostId } = await createParentSession(chat);
        await chat.writeScript(projectId);
        await openAgentChat(chat.running.page, 'Codex Chat');
        await chat.running.app.close();
        const input = { userData: chat.userData, hostSessionId: hostId, projectId };
        const failed = await runServerDatabase<DelegatedChatSeed>('delegated-chat-seed', {
            ...input,
            phase: 'children',
        });
        const cut = await runServerDatabase<InterruptedDelegatedChatSeed>('delegated-chat-seed', {
            ...input,
            phase: 'interrupted',
        });
        chat.running = await launchCaxri(chat.launchOptions);
        const { page } = chat.running;
        await selectSession(page, hostId);
        const strip = page
            .locator(VISIBLE_SESSION)
            .getByRole('region', { name: 'Background work' });
        const rowOf = (id: string) => strip.locator(`[data-agent-chat-delegated-session="${id}"]`);
        const fold = strip.locator('[data-agent-chat-strip-fold]');
        const earlier = strip.locator('[data-agent-chat-background-earlier]');

        await expect(fold).toContainText('1 needs you');
        await expect(earlier).toHaveText('2 interrupted earlier');
        await expect(rowOf(failed.quota)).toBeVisible();
        await expect(rowOf(cut.targetChanged)).toHaveCount(0);
        await expect(rowOf(cut.hostReset)).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('interrupted-earlier.png') });

        // The count shows their rows after the ones that need the user, and hides them again.
        await earlier.click();
        await expect(rowOf(cut.targetChanged)).toBeVisible();
        await expect(rowOf(cut.hostReset)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('interrupted-earlier-shown.png') });
        await earlier.click();
        await expect(rowOf(cut.targetChanged)).toHaveCount(0);

        // The header folds everything, the failure included, and keeps its counts.
        await fold.click();
        await expect(rowOf(failed.quota)).toHaveCount(0);
        await expect(fold).toContainText('1 needs you');
        await expect(earlier).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('interrupted-folded.png') });
        await fold.click();

        await strip
            .getByRole('button', { name: 'Clear the delegations interrupted earlier' })
            .click();
        await expect(earlier).toHaveCount(0);
        await expect(rowOf(failed.quota)).toBeVisible();

        // The dismissal outlives the window.
        await page.reload();
        await selectSession(page, hostId);
        await expect(rowOf(failed.quota)).toBeVisible();
        await expect(earlier).toHaveCount(0);
    } finally {
        await chat.cleanup();
    }
});
