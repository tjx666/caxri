import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import {
    createShellSession,
    launchCaxri,
    openAddProjectDialog,
    pageRequest,
    typeTerminal,
} from './helpers.ts';

const execFileAsync = promisify(execFile);

test('Agent output refreshes the Session title without opening Info', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-title-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    const state = join(testDirectory, 'codex-state');
    const executable = join(bin, 'codex');
    const database = join(state, 'state_9.sqlite');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(bin, { recursive: true }),
        mkdir(state, { recursive: true }),
    ]);
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
    await writeFile(
        executable,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-test 1.0\\n'
  exit 0
fi
printf 'Fake Codex ready\\n'
while IFS= read -r line; do
  now_ms="$(date +%s)999"
  /usr/bin/sqlite3 "$CODEX_SQLITE_HOME/state_9.sqlite" "INSERT OR REPLACE INTO threads VALUES ('current-agent-session', '${canonicalRoot}', '[Image #1] hello', $now_ms, $now_ms, 0, 0);"
  printf 'received %s\\n' "$line"
done
`,
        'utf8',
    );
    await chmod(executable, 0o700);

    const { app, page } = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            CODEX_SQLITE_HOME: state,
        },
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
                    await execFileAsync('sqlite3', [database, 'SELECT title FROM threads;'])
                ).stdout.trim(),
            )
            .toContain('hello');
        await expect(page.locator('.session-card strong')).toHaveText('hello');
        await page.getByRole('button', { name: 'Info', exact: true }).click();
        const info = page.locator('.terminal-info-card');
        await expect(info).toHaveCount(1);
        await expect(info).toContainText('current-agent-session');
        await expect(info).toContainText('Title source');
        await expect(info.getByText('PID', { exact: true })).toBeVisible();

        await page.getByRole('button', { name: 'New Terminal', exact: true }).click();
        await expect(page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        await page.getByRole('tab', { name: 'Codex', exact: true }).click();
        await page.keyboard.press('Meta+W');
        await expect(page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
        await expect(page.locator('.session-card strong')).toHaveText('hello');
    } finally {
        await app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('starting Claude through a Shell alias promotes the Terminal to Claude Code', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-shell-claude-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const home = join(testDirectory, 'home');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    const state = join(testDirectory, 'claude-state');
    const sessions = join(state, 'sessions');
    const executable = join(bin, 'claude');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(bin, { recursive: true }),
        mkdir(sessions, { recursive: true }),
    ]);
    const canonicalRoot = await realpath(root);
    await writeFile(
        executable,
        `#!/bin/zsh
if [ "$1" = "--version" ]; then
  printf 'claude-test 1.0\\n'
  exit 0
fi
now_ms="$(date +%s)999"
printf '{"cwd":"${canonicalRoot}","name":"Claude from Shell","sessionId":"shell-claude-session","startedAt":%s,"updatedAt":%s,"status":"busy"}\\n' "$now_ms" "$now_ms" > "$CLAUDE_CONFIG_DIR/sessions/current.json"
printf 'Fake Claude ready\\n'
# Rename to the provider executable and keep emitting output like a real Agent TUI:
# foreground-process probes are bounded and only run when Terminal output arrives.
exec -a claude /bin/zsh -c 'while :; do printf "tick\\n"; sleep 1; done'
`,
        'utf8',
    );
    await chmod(executable, 0o700);
    await writeFile(join(home, '.zshrc'), 'alias ccy=claude\n', 'utf8');

    const { app, page } = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: {
            HOME: home,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            CLAUDE_CONFIG_DIR: state,
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
        await expect(page.getByRole('tab', { name: 'Claude Code' })).toBeVisible();
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
                const terminal = state.terminals[0];
                return {
                    agentSessionId: terminal?.agentSessionId,
                    isPrimary: state.sessions[0]?.primaryAgentTerminalId === terminal?.id,
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
        await app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
