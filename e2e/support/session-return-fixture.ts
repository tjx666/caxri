import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { fakeCodexChatAgentMode, openAgentChat } from './agent-chat-fixture.ts';
import { expect } from './fixtures.ts';
import type { LaunchCaxriOptions } from './helpers.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    VISIBLE_SESSION,
} from './helpers.ts';

/**
 * Launches Caxri with a fake Codex Chat in a fresh temporary directory, which the caller removes.
 */
export async function launchWithChat(
    options: Pick<LaunchCaxriOptions, 'preserveHostOnClose' | 'windowMode'> = {},
) {
    const created = await mkdtemp(join(tmpdir(), 'caxri-session-return-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const launchOptions = { agentMode, userDataDir: userData, testRootPath: root, ...options };
    const running = await launchCaxri(launchOptions);
    return { directory, launchOptions, running };
}

/**
 * Runs two Codex Chat turns while another Session is selected, leaving that other Session selected. Returns the Chat's
 * Session.
 */
export async function finishTwoTurnsAway(page: Page): Promise<string> {
    const chatId = await createProjectSession(page, 'shell');
    await openAgentChat(page, 'Codex Chat');
    const message = page.locator(VISIBLE_SESSION).getByRole('textbox', { name: 'Message' });
    await message.fill('longstream please');
    await message.press('Enter');
    // A follow-up queued during the turn runs as a second turn; plain Enter would steer the running turn instead.
    await message.fill('hello after this');
    await message.press('ControlOrMeta+Enter');
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
                    completed: snapshot.turns.filter(({ status }) => status === 'completed').length,
                    queued: snapshot.queue?.length ?? 0,
                };
            },
            { timeout: 60_000 },
        )
        .toEqual({ completed: 2, queued: 0 });
    return chatId;
}
