import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openAgentChat } from './support/agent-chat-fixture.ts';
import type { DelegatingChat } from './support/delegating-chat-fixture.ts';
import {
    CHILD_SUMMARY,
    createParentSession,
    DELEGATE_PROMPT,
    launchDelegatingChat,
} from './support/delegating-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { pageRequest, VISIBLE_SESSION } from './support/helpers.ts';
import { runServerDatabase } from './support/run-server-database.ts';

interface FeedSession {
    delegationId?: string;
    provider?: string;
    retriedAs?: string;
    retryOf?: string;
    retryScheduledFor?: number;
    sessionId: string;
}

/**
 * Delegates through the parent Chat, waits for the child to finish, then rewrites the task as a usage-limit failure
 * that resets `resetsInMs` from now. A fake child cannot hit a real limit, so the failure is injected on the record.
 */
async function delegateAndFail(chat: DelegatingChat, resetsInMs: number) {
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
    await expect(rows).toContainText(CHILD_SUMMARY);
    const childId = (await rows.getAttribute('data-agent-chat-delegated-session'))!;
    const failedId = await runServerDatabase<string>('delegation-failure', {
        userData: chat.userData,
        sessionId: childId,
        failure: 'quota_exhausted',
        failureResetsAt: Date.now() + resetsInMs,
    });
    await page.reload();
    await expect(strip).toContainText('1 failed');
    const feed = async () =>
        (
            await pageRequest<{ sessions: FeedSession[] }>(page, 'agent.delegation.sessions', {
                createdBySessionIds: [parentId],
            })
        ).sessions;
    return { failedId, feed, rows, strip };
}

/**
 * Schedule then Cancel, no waiting: "Retry after" asks first, the row then says when it retries, and Cancel returns it
 * to a plain failed task with nothing started.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the owner schedules a retry for the usage limit reset and cancels it before it runs', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-later-');
    try {
        const { page } = chat.running;
        const { failedId, feed, rows, strip } = await delegateAndFail(chat, 10 * 60_000);
        const schedule = strip.locator('[data-delegation-retry-schedule]');
        await expect(schedule).toContainText('Retry after');
        await schedule.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('Retry after');
        await dialog.getByRole('button', { name: 'Schedule retry' }).click();

        await expect(rows).toContainText('Retries at');
        await expect(strip.locator('[data-delegation-retry-schedule]')).toHaveCount(0);
        const pending = (await feed()).find((entry) => entry.delegationId === failedId)!;
        expect(pending.retryScheduledFor).toBeGreaterThan(Date.now());
        await page.screenshot({ path: testInfo.outputPath('delegation-retry-scheduled.png') });

        await strip.locator(`[data-delegation-retry-cancel="${failedId}"]`).click();
        await expect(rows).not.toContainText('Retries at');
        await expect(strip.locator('[data-delegation-retry-schedule]')).toBeVisible();
        const sessions = await feed();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].retryScheduledFor).toBeUndefined();
    } finally {
        await chat.cleanup();
    }
});

/**
 * A controlled fire: the reset time is a few seconds away, so the scheduled retry (reset plus the Server's one minute
 * margin, checked every 15 seconds) runs once and resumes the same Session. There is no clock override, so the scenario
 * really waits for it.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a scheduled retry resumes the Session once the usage limit has reset', async ({}, testInfo) => {
    test.setTimeout(240_000);
    const chat = await launchDelegatingChat('caxri-delegated-fire-');
    try {
        const { page } = chat.running;
        const { failedId, feed, rows, strip } = await delegateAndFail(chat, 5_000);
        await strip.locator('[data-delegation-retry-schedule]').click();
        await page.getByRole('dialog').getByRole('button', { name: 'Schedule retry' }).click();
        await expect(rows).toContainText('Retries at');

        // The scheduled retry resumes the same Session, so the feed keeps one row whose newest task is the successor.
        await expect
            .poll(async () => (await feed())[0]?.retryOf, { timeout: 150_000 })
            .toBe(failedId);
        const [successor] = await feed();
        expect(successor.delegationId).not.toBe(failedId);
        expect(successor.retryScheduledFor).toBeUndefined();
        await expect(rows).toHaveCount(1);
        await expect(rows).toHaveAttribute(
            'data-agent-chat-delegated-session',
            successor.sessionId,
        );
        await expect(rows).toContainText('Attempt 2');
        await expect(strip).not.toContainText('Retries at');
        await page.waitForTimeout(500);
        expect(await feed()).toHaveLength(1);
        await page.screenshot({ path: testInfo.outputPath('delegation-retry-fired.png') });
    } finally {
        await chat.cleanup();
    }
});

/**
 * Switching Agent: with a second Agent installed, a usage-limit failure offers "Retry with <Agent>", which starts the
 * task over in a new Session on that Agent instead of waiting.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a usage-limit failure can be retried at once with the other installed Agent', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-switch-', { withClaude: true });
    try {
        const { page } = chat.running;
        const { failedId, feed, rows, strip } = await delegateAndFail(chat, 10 * 60_000);
        const switchAction = strip.locator('[data-delegation-retry-switch="claude"]');
        await expect(switchAction).toContainText('Retry with Claude');
        await page.screenshot({ path: testInfo.outputPath('delegation-retry-switch.png') });
        await switchAction.click();
        await page.getByRole('dialog').getByRole('button', { name: 'Retry', exact: true }).click();

        await expect.poll(async () => (await feed()).length).toBe(2);
        const successor = (await feed()).find((entry) => entry.retryOf === failedId)!;
        expect(successor.provider).toBe('claude');
        const taskFile = join(chat.userData, 'delegations', successor.delegationId!, 'task.md');
        expect(await readFile(taskFile, 'utf8')).toContain(
            'A previous attempt at this task failed before finishing.',
        );
        await expect(rows).toHaveCount(1);
        await expect(rows).toHaveAttribute(
            'data-agent-chat-delegated-session',
            successor.sessionId,
        );
    } finally {
        await chat.cleanup();
    }
});
