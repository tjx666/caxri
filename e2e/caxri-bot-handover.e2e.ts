import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { BotHandoverResult, BotManagedSessions } from '@caxri/protocol';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    VISIBLE_SESSION,
} from './support/helpers.ts';

const CONVERSATION_ID = 'outside-conversation-1';
const CONVERSATION_TITLE = 'Investigate the flaky upload test';

/**
 * A Claude Code conversation the user started in another terminal app, in Claude's own history layout
 * (`projects/<encoded cwd>/<session id>.jsonl`). Written an hour ago so it does not read as still open.
 */
async function seedOutsideConversation(configDirectory: string, cwd: string): Promise<void> {
    const path = join(
        configDirectory,
        'projects',
        cwd.replaceAll(/[^a-z0-9]/gi, '-'),
        `${CONVERSATION_ID}.jsonl`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
        path,
        `${JSON.stringify({
            type: 'user',
            cwd,
            entrypoint: 'cli',
            isSidechain: false,
            sessionId: CONVERSATION_ID,
            uuid: `${CONVERSATION_ID}-u`,
            message: { role: 'user', content: CONVERSATION_TITLE },
        })}\n`,
    );
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(path, anHourAgo, anHourAgo);
}

/**
 * From the Caxri Bot window, the user picks every Session of a Project with the group checkbox and one Claude
 * conversation started outside Caxri, then hands them over in one batch. Caxri Bot then manages all three, and the
 * outside conversation became a Workbench Session titled after it.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot hand-over picker hands Sessions and an outside conversation over in one batch', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-handover-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    await seedOutsideConversation(agentMode.environment.CLAUDE_CONFIG_DIR!, await realpath(root));
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await createAdditionalShellSession(running.page);
        const before = await pageRequest<{ sessions: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        const ownSessionIds = before.sessions.map(({ id }) => id);
        expect(ownSessionIds).toHaveLength(2);

        await pageRequest(running.page, 'caxriBot.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        await expect(bot.locator('.terminal-pane .xterm-rows')).toContainText('Fake codex ready');

        await bot.locator('.caxri-bot-handover').click();
        const dialog = bot.getByRole('dialog', { name: 'Hand Over to Caxri Bot' });
        await expect(dialog).toBeVisible();
        // Caxri Bot's own Session is never offered.
        await expect(dialog.locator('.bot-handover-row')).toHaveCount(2);
        await dialog.getByRole('checkbox', { name: 'Select all in project' }).click();
        await expect(dialog.getByText('2 selected')).toBeVisible();

        await dialog.locator('.bot-handover-tab-conversations').click();
        const conversationRow = dialog.locator(
            `.bot-handover-row[data-handover-key="claude:${CONVERSATION_ID}"]`,
        );
        await expect(conversationRow).toContainText(CONVERSATION_TITLE);
        await dialog.locator('.bot-handover-search').fill('flaky upload');
        await expect(dialog.locator('.bot-handover-row')).toHaveCount(1);
        await conversationRow.getByRole('checkbox').click();
        // The search hides nothing that stays selected: the two Sessions still count.
        await expect(dialog.getByText('3 selected')).toBeVisible();
        await testInfo.attach('bot-handover-picker', {
            body: await bot.screenshot(),
            contentType: 'image/png',
        });

        await dialog.locator('.bot-handover-submit').click();
        await expect(dialog).toBeHidden();
        await expect(bot.getByText('Handed 3 Sessions to Caxri Bot')).toBeVisible();

        const after = await pageRequest<{ sessions: Array<{ id: string; title: string }> }>(
            running.page,
            'app.bootstrap',
        );
        const imported = after.sessions.find(({ title }) => title === CONVERSATION_TITLE);
        expect(imported).toBeDefined();
        const managed = await pageRequest<{ sessionIds: string[] }>(
            running.page,
            'bot.managedSessions',
        );
        expect(new Set(managed.sessionIds)).toEqual(new Set([...ownSessionIds, imported!.id]));
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * The user hands a Session whose Agent runs as a Codex Chat to Caxri Bot. Caxri Bot gets the conversation to continue,
 * not ownership alone, its row marker says that sending or stopping takes it back, and the user's next Chat message
 * takes the Session back with the same notice typing into a PTY Agent shows.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('a handed-over Agent Chat stays continuable until the user sends it a message', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-bot-chat-handover-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        const sessionId = await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('first');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: first')).toBeVisible();

        await pageRequest(page, 'bot.ensure');
        const { outcomes } = await pageRequest<BotHandoverResult>(page, 'bot.session.handOver', {
            sessionIds: [sessionId],
        });
        expect(outcomes).toEqual([expect.objectContaining({ outcome: 'accepted', sessionId })]);
        expect(outcomes[0]).not.toHaveProperty('ownershipReason');
        const managed = () => pageRequest<BotManagedSessions>(page, 'bot.managedSessions');
        expect(await managed()).toMatchObject({
            inputTakeBackSessionIds: [sessionId],
            chatTakeBackSessionIds: [sessionId],
        });
        // The Session row says what takes a Chat back: sending or stopping, not typing a draft.
        const marker = page.locator(`[data-session-id="${sessionId}"] .bot-session-marker`);
        await expect(marker).toHaveAttribute('data-bot-marker', 'chatInputTakesBack');
        await expect(marker).toHaveAttribute(
            'aria-label',
            'Managed by Caxri Bot · sending a message or stopping here takes it back',
        );
        // Quitting Caxri Bot leaves the Session handed over but nobody managing it, so the marker goes, while
        // sending a message still takes the Session back.
        await pageRequest(page, 'bot.stop');
        await expect(marker).toHaveCount(0);
        expect((await managed()).sessionIds).toEqual([sessionId]);

        // Selecting the Session's tabs again may land on its Shell; the user returns to the Chat to write.
        await chat.getByRole('tab', { name: 'Codex (Chat)' }).click();
        await message.fill('second');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: second')).toBeVisible();
        await expect(page.getByText(/^Took .+ back from Caxri Bot$/u)).toBeVisible();
        await testInfo.attach('bot-chat-take-back', {
            body: await page.screenshot(),
            contentType: 'image/png',
        });
        expect(await managed()).toMatchObject({
            sessionIds: [],
            inputTakeBacks: [expect.objectContaining({ sessionId })],
        });
        await expect(marker).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
