import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openAddProjectDialog, pageRequest, typeTerminal } from './support/helpers.ts';

/**
 * What an Agent CLI paints into its window title: a transient status line, not a name. A Shell has nothing better to be
 * called, so this string would legitimately become its tab label — which is exactly why an Agent Terminal needs the
 * arbitration under test.
 */
const AGENT_STATUS_TITLE = 'esc to interrupt · 12s';
const CONVERSATION_TITLE = 'Ship the release notes';

interface BootstrapTerminals {
    terminals: Array<{ ptyTitle?: string; title: string }>;
}

/**
 * Two title writers reach the same Terminal row from opposite directions, and only a real Electron run exercises both:
 * the Agent conversation arrives through the Runtime's provider probe, while OSC 0/2 arrives through the PTY stream.
 * Pure-function coverage of the arbitration stays green if a Renderer call site goes back to preferring the PTY title,
 * and the Agent E2E fixtures never emitted OSC at all before this spec.
 */
test('an Agent tab keeps its conversation title against OSC and across a reload', async () => {
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
      /usr/bin/sqlite3 "$CODEX_SQLITE_HOME/state_9.sqlite" "INSERT OR REPLACE INTO threads VALUES ('current-agent-session', '${canonicalRoot}', '${CONVERSATION_TITLE}', $now_ms, $now_ms, 0, 0);"
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
        // Proves the OSC payload actually reached the Runtime and was stored, rather than the tab surviving because
        // the escape sequence never made it out of the PTY.
        await expect
            .poll(async () => {
                const bootstrap = await pageRequest<BootstrapTerminals>(page, 'app.bootstrap');
                return bootstrap.terminals.at(0);
            })
            .toMatchObject({ ptyTitle: AGENT_STATUS_TITLE, title: CONVERSATION_TITLE });
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
    } finally {
        try {
            await app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
