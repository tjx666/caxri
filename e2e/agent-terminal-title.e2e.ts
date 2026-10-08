import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openAddProjectDialog, pageRequest, typeTerminal } from './support/helpers.ts';

/**
 * What an Agent CLI paints into its window title: a transient status line, not a name. A Shell has nothing better to be
 * called, so this string would legitimately become its tab label, which is exactly why an Agent Terminal needs the
 * arbitration under test.
 */
const AGENT_STATUS_TITLE = 'esc to interrupt · 12s';
const CONVERSATION_TITLE = 'Ship the release notes';

interface BootstrapTerminals {
    terminals: Array<{ id: string; ptyTitle?: string; title: string }>;
}

test('a resumed Codex thread receives its native title before its first lifecycle hook', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-resumed-title-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const state = join(userData, 'e2e-agents', 'codex');
    const threadId = '019a0000-0000-7000-8000-000000000042';
    const title = 'Resume the existing work';
    await Promise.all([mkdir(root, { recursive: true }), mkdir(state, { recursive: true })]);
    await execFileAsync('sqlite3', [
        join(state, 'state_9.sqlite'),
        `CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT,
            created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER);
         INSERT INTO threads VALUES ('${threadId}', '/previous-worktree', 'Private first prompt',
            '${title}', 1, 1, 0, 0);`,
    ]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                /**
                 * A resumed recorder holds its old rollout open before SessionStart arrives. No hook or new thread
                 * metadata is emitted: only this Terminal's foreground process can establish the old identity.
                 */
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.153.4\n');
  process.exit(0);
}
const directory = path.join(process.env.CODEX_HOME, 'sessions', '2026', '01', '01');
fs.mkdirSync(directory, { recursive: true });
const fd = fs.openSync(path.join(directory, 'rollout-2026-01-01T00-00-00-${threadId}.jsonl'), 'a');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.on('exit', () => fs.closeSync(fd));
process.stdout.write('Fake resumed Codex ready\r\n');
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
        await expect(page.getByRole('tab', { name: title, exact: true })).toBeVisible({
            timeout: 20_000,
        });
        const bootstrap = await pageRequest<{
            terminals: Array<{ agentSessionId?: string; title: string }>;
        }>(page, 'app.bootstrap');
        expect(bootstrap.terminals).toEqual([
            expect.objectContaining({ agentSessionId: threadId, title }),
        ]);
    } finally {
        await app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * Two title sources reach the same Terminal from opposite directions, and only a real Electron run exercises both: the
 * Agent conversation arrives through the Runtime's provider probe, while OSC 0/2 arrives through the PTY stream. The
 * Agent binding must reject the transient OSC title before persistence, and the Renderer must keep projecting the
 * semantic conversation title across reloads.
 */
test('an Agent tab suppresses OSC persistence, survives reload, and resets on a fresh restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-terminal-title-e2e-'));
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
        );`,
    ]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                /**
                 * Separating the two writers onto separate input lines is what makes the ordering assertable: the
                 * conversation title is confirmed on screen first, so the OSC that follows it can only be read as a
                 * later write losing to it, never as a write that simply arrived too early to matter.
                 */
                executableSource: String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-test 1.0\n'
  exit 0
fi
printf 'Fake Codex ready\n'
while IFS= read -r line; do
  case "$line" in
    status*)
      printf '\033]0;${AGENT_STATUS_TITLE}\007'
      printf 'status announced\n'
      ;;
    *)
      now_ms="$(date +%s)999"
      /usr/bin/sqlite3 -cmd '.timeout 5000' "$CODEX_SQLITE_HOME/state_9.sqlite" "INSERT OR REPLACE INTO threads VALUES ('current-agent-session', '${canonicalRoot}', 'Private first prompt', '${CONVERSATION_TITLE}', $now_ms, $now_ms, 0, 0);"
      printf 'received %s\n' "$line"
      ;;
  esac
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
        // Before any conversation exists the tab can only offer the provider name.
        await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toBeVisible();

        await typeTerminal(page, 'hello');
        await expect(
            page.getByRole('tab', { name: CONVERSATION_TITLE, exact: true }),
        ).toBeVisible();

        await typeTerminal(page, 'status');
        // The marker follows the OSC write in the fake Agent, so seeing it proves the escape sequence reached the PTY
        // stream before the durable-state assertion below verifies that the Agent-bound listener discarded it.
        await expect(page.locator('.xterm-rows')).toContainText('status announced');
        await expect(
            page.getByRole('tab', { name: CONVERSATION_TITLE, exact: true }),
        ).toBeVisible();
        await expect(page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
        await expect(page.locator('.tab-label')).toHaveText(CONVERSATION_TITLE);

        // The conversation lives in `terminals.title`, not in Renderer state; a reload has to project it back.
        await page.reload();
        await expect(
            page.getByRole('tab', { name: CONVERSATION_TITLE, exact: true }),
        ).toBeVisible();
        await expect(page.locator('.tab-label')).toHaveText(CONVERSATION_TITLE);
        const reloadedTerminal = (
            await pageRequest<BootstrapTerminals>(page, 'app.bootstrap')
        ).terminals.at(0);
        expect(reloadedTerminal).toMatchObject({ title: CONVERSATION_TITLE });
        expect(reloadedTerminal).not.toHaveProperty('ptyTitle');

        /**
         * A fresh restart retires the conversation, so keeping its name would label a brand new Agent with a
         * conversation it has nothing to do with, permanently, if the replacement never names one. The Runtime clears
         * it in `resetAgentMetadataForStart`, and only a real restart proves that reset is wired into the launch path
         * and projected back to the tab. The retired thread row stays in the fixture database on purpose: its
         * `created_at_ms` predates the new `startedAt`, which is exactly what must keep the probe from re-claiming it.
         */
        const bootstrap = await pageRequest<BootstrapTerminals>(page, 'app.bootstrap');
        const terminalId = bootstrap.terminals[0]?.id;
        expect(terminalId).toBeTruthy();
        await pageRequest(page, 'terminal.restart', { terminalId, mode: 'fresh' });
        await expect
            .poll(async () => {
                const restarted = await pageRequest<BootstrapTerminals>(page, 'app.bootstrap');
                return restarted.terminals.at(0)?.title;
            })
            .toBe('Codex');
        await expect(page.locator('.tab-label')).toHaveText('Codex');
        await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toBeVisible();
    } finally {
        try {
            await app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
