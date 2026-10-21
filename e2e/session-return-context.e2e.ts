import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';

async function launchWithChat() {
    const created = await mkdtemp(join(tmpdir(), 'caxri-session-return-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    return { directory, running };
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the hover card quotes the question an away Chat is waiting on', async ({}, testInfo) => {
    const { directory, running } = await launchWithChat();
    try {
        const { page } = running;
        const waitingId = await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const message = page.locator(VISIBLE_SESSION).getByRole('textbox', { name: 'Message' });
        await message.fill('ask several questions');
        await message.press('Enter');
        await expect(
            page.locator(VISIBLE_SESSION).getByRole('region', { name: 'Codex has 3 questions' }),
        ).toBeVisible();
        await createAdditionalShellSession(page);
        await sessionCard(page, waitingId).hover();
        const card = page.locator('.session-activity-card');
        await expect(card.getByText('Waiting on you')).toBeVisible();
        await expect(card).toContainText('?');
        await page.screenshot({ path: testInfo.outputPath('hover-card-excerpt.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('returning to a Chat counts the turns that finished while away', async ({}, testInfo) => {
    const { directory, running } = await launchWithChat();
    try {
        const { page } = running;
        const chatId = await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const message = page.locator(VISIBLE_SESSION).getByRole('textbox', { name: 'Message' });
        await message.fill('longstream please');
        await message.press('Enter');
        // A follow-up sent during the turn queues and runs as a second turn; one missed turn is already on screen at the
        // Chat's bottom and earns no hint.
        await message.fill('hello after this');
        await message.press('Enter');
        await createAdditionalShellSession(page);
        const state = await pageRequest<BootstrapState>(page, 'app.bootstrap');
        const chatTerminal = state.terminals.find(
            ({ sessionId, provider }) => sessionId === chatId && provider === 'codex',
        );
        if (!chatTerminal) throw new Error('Chat Terminal missing');
        // Both turns end while another Session is selected.
        await expect
            .poll(
                async () => {
                    const snapshot = await pageRequest<{
                        turns: Array<{ status: string }>;
                        queue?: unknown[];
                    }>(page, 'agentChat.read', { terminalId: chatTerminal.id });
                    return {
                        completed: snapshot.turns.filter(({ status }) => status === 'completed')
                            .length,
                        queued: snapshot.queue?.length ?? 0,
                    };
                },
                { timeout: 60_000 },
            )
            .toEqual({ completed: 2, queued: 0 });
        await sessionCard(page, chatId).click();
        const hint = page.getByRole('status').filter({ hasText: 'since you last looked' });
        await expect(hint).toContainText('2 turns since you last looked');
        await page.screenshot({ path: testInfo.outputPath('return-hint.png') });
        await hint.getByRole('button', { name: 'Jump to first' }).click();
        await expect(hint).toBeHidden();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
