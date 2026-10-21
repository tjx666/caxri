import { join } from 'node:path';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import {
    fakeClaudeChatExecutableSource,
    fakeCodexChatExecutableSource,
    fakeGrokChatExecutableSource,
} from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-chat-executables.ts';
import { createFakeAgentMode } from './agent-fixture.ts';
import { chooseTerminalFromCreateMenu, VISIBLE_SESSION } from './helpers.ts';

/**
 * The fake Codex provider definition whose `app-server` is the deterministic Server-test fixture; threads persist under
 * `directory`. Exported so a spec can combine it with other fake providers in one mode.
 */
export function fakeCodexChatProvider(
    directory: string,
    nativeUsageHome?: string,
    shouldWriteRollouts?: boolean,
) {
    return {
        executableSource: fakeCodexChatExecutableSource({
            stateDirectory: join(directory, 'codex-threads'),
            nativeUsageHome,
            shouldWriteRollouts,
        }),
    };
}

/**
 * A fake Codex whose `app-server` is the deterministic Server-test fixture; threads persist under `directory`. With
 * `shouldWriteRollouts`, it also records user messages in a rollout, as the real CLI does, so resumed images read
 * back.
 */
export function fakeCodexChatAgentMode(
    directory: string,
    userData: string,
    options: { shouldWriteRollouts?: boolean } = {},
) {
    return createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: fakeCodexChatProvider(
                directory,
                join(userData, 'e2e-agents', 'codex'),
                options.shouldWriteRollouts,
            ),
        },
    });
}

/**
 * A fake Claude Code driven through the Claude Agent SDK. Its transcripts live under the fake agent home;
 * `controlDirectory` is where the spec drops the fake's control files (`FAKE_CLAUDE_CONTROL_DIR`).
 */
export function fakeClaudeChatAgentMode(userData: string, controlDirectory?: string) {
    return createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: fakeClaudeChatExecutableSource({ controlDirectory }),
            },
        },
    });
}

/**
 * A fake Grok Build whose `agent stdio` is the deterministic ACP fixture; sessions persist under `directory`.
 */
export function fakeGrokChatAgentMode(directory: string, userData: string) {
    return createFakeAgentMode({
        userDataDir: userData,
        providers: {
            grok: {
                executableSource: fakeGrokChatExecutableSource({
                    stateDirectory: join(directory, 'grok-sessions'),
                }),
            },
        },
    });
}

/**
 * Creates an Agent Chat from the visible Session's New Terminal menu, with the menu's Open Agents in Chat toggle on.
 */
export async function openAgentChat(
    page: Page,
    label: 'Claude Chat' | 'Codex Chat' | 'Grok Build Chat',
) {
    const session = page.locator(VISIBLE_SESSION);
    // With one tab beside a Terminal | Chat toggle, + takes its width only once the pointer reaches the tab bar.
    await session.locator('.work-tabs').hover();
    /**
     * The + is named for what a press creates: "New Terminal", or "New Claude Terminal" when it clones the Agent. A
     * press on a named + creates that Agent at once, so hover it: the Agent list opens on hover either way.
     */
    const name = /^New .*(?:Terminal|Chat)$/u;
    await session.getByRole('button', { name }).hover();
    // Base UI names the popup after the trigger that opened it.
    const terminalMenu = page.getByRole('menu', { name });
    const openInChat = terminalMenu.getByRole('menuitemcheckbox', { name: 'Open Agents in Chat' });
    if (!(await openInChat.isChecked())) await openInChat.click();
    await chooseTerminalFromCreateMenu(page, label);
    // A pointer left on + would reopen the hover list, which takes focus from the new Chat's message box.
    await page.mouse.move(0, 300);
    await expect(page.getByRole('menu')).toHaveCount(0);
    /**
     * The Composer refuses Enter until the Chat's first snapshot loads (`agentChatSendBlock` returns `loading`), so a
     * caller that fills and sends at once loses its message on a loaded runner (issue #1846, `parallel-safe`). The
     * empty Chat's invitation renders only once that snapshot reads `ready`.
     */
    await expect(
        session.getByText(/^Send a message to start working with /u).filter({ visible: true }),
    ).toBeVisible();
}
