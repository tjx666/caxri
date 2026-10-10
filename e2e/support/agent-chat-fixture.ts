import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { Page } from '@playwright/test';

import { createFakeAgentMode } from './agent-fixture.ts';
import { chooseTerminalFromCreateMenu, VISIBLE_SESSION } from './helpers.ts';

/**
 * The deterministic app-server the Server unit tests drive. Reusing it keeps one fake protocol implementation instead
 * of a second, drifting copy for the desktop workflow.
 */
const FAKE_APP_SERVER = join(
    import.meta.dirname,
    '../..',
    'apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-app-server.ts',
);

/**
 * The deterministic Claude Code CLI the Server unit tests drive through the Claude Agent SDK.
 */
const FAKE_CLAUDE = join(
    import.meta.dirname,
    '../..',
    'apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-cli.ts',
);

/**
 * The deterministic Grok Build ACP agent the Server unit tests drive.
 */
const FAKE_GROK = join(
    import.meta.dirname,
    '../..',
    'apps/server/src/domains/agent-chat/__tests__/fixtures/fake-grok-acp.ts',
);

/**
 * A fake Codex whose `app-server` is the deterministic Server-test fixture; threads persist under `directory`.
 */
export function fakeCodexChatAgentMode(directory: string, userData: string) {
    return createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.162.0\n');
  process.exit(0);
}
process.env.FAKE_CODEX_STATE_DIR = ${JSON.stringify(join(directory, 'codex-threads'))};
import(${JSON.stringify(pathToFileURL(FAKE_APP_SERVER).href)});
`,
            },
        },
    });
}

/**
 * A fake Claude Code driven through the Claude Agent SDK. Its transcripts live under the fake agent home.
 */
export function fakeClaudeChatAgentMode(userData: string) {
    return createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: `#!${process.execPath}
import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE).href)});
`,
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
                executableSource: `#!${process.execPath}
process.env.FAKE_GROK_STATE_DIR = ${JSON.stringify(join(directory, 'grok-sessions'))};
import(${JSON.stringify(pathToFileURL(FAKE_GROK).href)});
`,
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
    await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
    const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
    const openInChat = terminalMenu.getByRole('menuitemcheckbox', { name: 'Open Agents in Chat' });
    if (!(await openInChat.isChecked())) await openInChat.click();
    await chooseTerminalFromCreateMenu(page, label);
}
