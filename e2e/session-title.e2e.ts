import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    openAddProjectDialog,
    openPanelView,
    pageRequest,
    pressNewTerminal,
    typeTerminal,
} from './support/helpers.ts';

test('Agent output refreshes the Session title without opening Info', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-title-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const state = join(userData, 'e2e-agents', 'codex');
    const database = join(state, 'state_9.sqlite');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(state, { recursive: true })]);
    const canonicalRoot = await realpath(root);
    await execFileAsync('sqlite3', [
        database,
        `CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            title TEXT,
            created_at_ms INTEGER,
            updated_at_ms INTEGER,
            tokens_used INTEGER,
            archived INTEGER
        );
        INSERT INTO threads VALUES (
            'stale-agent-session',
            '${canonicalRoot}',
            '$debug https://github.com/lobehub/lobehub/issues/123',
            ${Date.now() - 60_000},
            ${Date.now() - 60_000},
            0,
            0
        );`,
    ]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-test 1.0\n'
  exit 0
fi
printf 'Fake Codex ready\n'
while IFS= read -r line; do
  now_ms="$(date +%s)999"
  /usr/bin/sqlite3 -cmd '.timeout 5000' "$CODEX_SQLITE_HOME/state_9.sqlite" "INSERT OR REPLACE INTO threads VALUES ('current-agent-session', '${canonicalRoot}', '[Image #1] hello', $now_ms, $now_ms, 0, 0);"
  printf 'received %s\n' "$line"
done
`,
            },
        },
    });

    const { app, page } = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await openAddProjectDialog(page);
        await page.getByRole('dialog').getByRole('button', { name: 'Codex' }).click();
        await expect(page.locator('.session-card strong')).toHaveText('Untitled');
        await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toBeVisible();

        const input = page.locator('.xterm-helper-textarea');
        await input.focus();
        await input.pressSequentially('hello');
        await input.press('Enter');

        await expect
            .poll(async () =>
                (
                    await execFileAsync('sqlite3', [
                        '-cmd',
                        '.timeout 5000',
                        database,
                        'SELECT title FROM threads;',
                    ])
                ).stdout.trim(),
            )
            .toContain('hello');
        await expect(page.locator('.session-card strong')).toHaveText('hello');
        await openPanelView(page, 'Info');
        const info = page.locator('.terminal-info-card');
        await expect(info).toHaveCount(1);
        await expect(info).toContainText('current-agent-session');
        await expect(info).toContainText('Title source');
        await expect(info.getByText('PID', { exact: true })).toBeVisible();

        await pressNewTerminal(page);
        await expect(page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        // An Agent CLI names its conversation but never reports that name through OSC 0/2, so the tab has to take it
        // from the probe's metadata; before that it stayed on the provider name ("Codex") for the Terminal's whole life.
        await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveCount(0);
        const codexTab = page.getByRole('tab', { name: 'hello', exact: true });
        await codexTab.click();
        const codexTerminalId = await codexTab.locator('xpath=..').getAttribute('data-terminal-id');
        // Switching back to Codex remounts its Terminal pane, which re-attaches the PTY asynchronously
        // (`use-terminal-pane-runtime.ts`). Pressing `Meta+W` before that attach round-trip resolves races
        // `workbench.closeActiveTab`'s `terminal.close` request behind it on the Host's ordered command
        // queue (`src/host/local-server.ts`) — a race no human could reproduce by hand, but one Playwright's
        // instant click-then-keypress can, especially under CI's contended parallel-safe pool. Waiting for
        // the attach flag mirrors the same synchronization already used in `editor-tabs.e2e.ts`.
        await expect(
            page.locator(
                `.terminal-pane[data-terminal-id="${codexTerminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        await page.keyboard.press('Meta+W');
        await expect(page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
        await expect(page.locator('.session-card strong')).toHaveText('hello');
    } finally {
        try {
            await app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('starting Claude through a Shell alias promotes the Terminal to Claude Code', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-shell-claude-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const home = join(userData, 'e2e-agents', 'home');
    const root = join(testDirectory, 'project');
    const bin = join(userData, 'e2e-agents', 'bin');
    const state = join(userData, 'e2e-agents', 'claude');
    const sessions = join(state, 'sessions');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(sessions, { recursive: true }),
    ]);
    const canonicalRoot = await realpath(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!/bin/zsh
if [ "$1" = "--version" ]; then
  printf 'claude-test 1.0\n'
  exit 0
fi
now_ms="$(date +%s)999"
printf '{"cwd":"${canonicalRoot}","name":"Claude from Shell","sessionId":"shell-claude-session","startedAt":%s,"updatedAt":%s,"status":"busy"}\n' "$now_ms" "$now_ms" > "$CLAUDE_CONFIG_DIR/sessions/current.json"
printf 'Fake Claude ready\n'
# Rename to the provider executable and keep emitting output like a real Agent TUI:
# foreground-process probes are bounded and only run when Terminal output arrives.
exec -a claude /bin/zsh -c 'while :; do printf "tick\n"; sleep 1; done'
`,
            },
        },
    });
    await writeFile(join(home, '.zshrc'), 'alias ccy=claude\n', 'utf8');

    const { app, page } = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            // CI runners default SHELL to /bin/bash, which never reads the .zshrc that defines
            // the alias; pin zsh so the promotion flow under test is deterministic everywhere.
            SHELL: '/bin/zsh',
        },
    });
    try {
        await createShellSession(page);
        await expect(page.locator('.session-card strong')).toHaveText('Untitled');
        await expect(page.getByRole('tab', { name: 'Shell', exact: true })).toBeVisible();

        await typeTerminal(page, 'ccy');

        await expect(page.locator('.session-card strong')).toHaveText('Claude from Shell');
        // The promotion seeds the tab with the provider name, but the first probe carrying a conversation title
        // replaces it: an Agent tab identifies its conversation, not which Agent is running in it.
        await expect(
            page.getByRole('tab', { name: 'Claude from Shell', exact: true }),
        ).toBeVisible();
        await expect
            .poll(async () => {
                const state = await pageRequest<{
                    sessions: Array<{ primaryAgentTerminalId?: string }>;
                    terminals: Array<{
                        agentSessionId?: string;
                        id: string;
                        kind: string;
                        provider?: string;
                    }>;
                }>(page, 'app.bootstrap');
                // `.at()` (not index access, which types the element as always-defined) types
                // `terminal` as possibly `undefined`, matching the real possibility that the page
                // hasn't created any terminal yet when this poll first runs.
                const terminal = state.terminals.at(0);
                return {
                    agentSessionId: terminal?.agentSessionId,
                    isPrimary: state.sessions.at(0)?.primaryAgentTerminalId === terminal?.id,
                    kind: terminal?.kind,
                    provider: terminal?.provider,
                };
            })
            .toMatchObject({
                agentSessionId: 'shell-claude-session',
                isPrimary: true,
                kind: 'claude',
                provider: 'claude',
            });
    } finally {
        try {
            await app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
