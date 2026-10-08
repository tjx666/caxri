import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

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

function sqliteString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('Codex SessionStart binds a resumed thread before the first ordinary prompt', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-resume-title-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const state = join(userData, 'e2e-agents', 'codex');
    const database = join(state, 'state_9.sqlite');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(state, { recursive: true })]);
    const canonicalRoot = await realpath(root);
    const resumedTitle = 'Resume hook restores this title';
    await execFileAsync('sqlite3', [
        database,
        `CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            title TEXT,
            name TEXT,
            created_at_ms INTEGER,
            updated_at_ms INTEGER,
            tokens_used INTEGER,
            archived INTEGER
        );
        INSERT INTO threads VALUES (
            'resumed-codex-session',
            ${sqliteString(canonicalRoot)},
            'Private resume prompt',
            ${sqliteString(resumedTitle)},
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
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('codex 0.149.1\n');
  process.exit(0);
}
const hooks = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
const group = hooks.hooks.SessionStart[0];
/**
 * Simulate cold shell and Electron-as-Node startup inside Codex's configured deadline. The old one-second deadline
 * killed the bridge before its own bounded stdin and socket work could finish.
 */
const delayedCommand = 'sleep 1.2; exec ' + group.hooks[0].command;
childProcess.execFileSync('/bin/sh', ['-c', delayedCommand], {
  env: process.env,
  input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'resumed-codex-session', source: 'resume' }),
  stdio: ['pipe', 'pipe', 'inherit'],
  timeout: group.hooks[0].timeout * 1000,
});
process.stdout.write('Resume hook invoked\r\n');
process.stdin.resume();
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });

    try {
        const currentSettings = await pageRequest<{ value: AppSettings }>(
            running.page,
            'settings.get',
        );
        const settings = structuredClone(currentSettings.value);
        settings['agents.providers'].codex.hooks.enabled = true;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings, null, 2),
        });
        await expect
            .poll(async () => readFile(join(state, 'hooks.json'), 'utf8'))
            .toContain('SessionStart');

        await openAddProjectDialog(running.page);
        await running.page.getByRole('dialog').getByRole('button', { name: 'Codex' }).click();
        await expect(running.page.locator('.xterm-rows')).toContainText('Resume hook invoked');
        await expect(running.page.locator('.xterm-rows')).not.toContainText('caxri-hook:');
        await expect(running.page.locator('.session-card strong')).toHaveText(resumedTitle);
        await expect(
            running.page.getByRole('tab', { name: resumedTitle, exact: true }),
        ).toBeVisible();

        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(bootstrap.terminals.at(0)).toMatchObject({
            agentSessionId: 'resumed-codex-session',
            title: resumedTitle,
        });
        const serverCoreLogPath = join(userData, 'logs', 'server-core.jsonl');
        await expect
            .poll(async () => readFile(serverCoreLogPath, 'utf8'))
            .toContain('agent_hooks.signal_accepted');
        const serverCoreLog = await readFile(serverCoreLogPath, 'utf8');
        expect(serverCoreLog).toContain('agent_hooks.launch_prepared');
        expect(serverCoreLog).toContain('agent_hooks.bridge_started');
        expect(serverCoreLog).toContain('agent_hooks.signal_accepted');
        expect(serverCoreLog).toContain('sessionIdentified');
        expect(serverCoreLog).not.toContain('resumed-codex-session');
        await running.page.screenshot({
            path: testInfo.outputPath('codex-resume-titles.png'),
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

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
            name TEXT,
            created_at_ms INTEGER,
            updated_at_ms INTEGER,
            tokens_used INTEGER,
            archived INTEGER
        );
        INSERT INTO threads VALUES (
            'stale-agent-session',
            '${canonicalRoot}',
            '$debug https://github.com/example/example/issues/123',
            NULL,
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
  /usr/bin/sqlite3 -cmd '.timeout 5000' "$CODEX_SQLITE_HOME/state_9.sqlite" "INSERT OR REPLACE INTO threads VALUES ('current-agent-session', '${canonicalRoot}', '[Image #1] private prompt', 'hello', $now_ms, $now_ms, 0, 0);"
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
                        'SELECT name FROM threads;',
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
        /**
         * The Server publishes the new tab before the New Terminal action finishes activating it. Wait for that
         * activation before switching back; otherwise the pending action can overwrite the click on the Agent tab.
         */
        await expect(page.getByRole('tab', { name: 'Shell', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(
            page
                .getByRole('tabpanel', { name: 'Shell', exact: true })
                .locator('.terminal-surface[data-terminal-attached="true"]'),
        ).toBeVisible();
        // An Agent CLI names its conversation but never reports that name through OSC 0/2, so the tab has to take it
        // from the probe's metadata; before that it stayed on the provider name ("Codex") for the Terminal's whole life.
        await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveCount(0);
        const codexTab = page.getByRole('tab', { name: 'hello', exact: true });
        await codexTab.click();
        const codexTerminalId = await codexTab.locator('xpath=..').getAttribute('data-terminal-id');
        // Switching back to Codex remounts its Terminal pane, which re-attaches the PTY asynchronously
        // (`use-terminal-pane-runtime.ts`). Pressing `Meta+W` before that attach round-trip resolves races
        // `workbench.closeActiveTab`'s `terminal.close` request behind it on the Server's ordered command
        // queue (`apps/server/src/core/control-server.ts`), a race no human could reproduce by hand, but one Playwright's
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
