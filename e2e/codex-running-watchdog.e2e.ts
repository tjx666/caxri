import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';
import Database from 'better-sqlite3';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('Codex durable turn completion repairs a lost Stop hook', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-running-watchdog-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const state = join(userData, 'e2e-agents', 'codex');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(state, { recursive: true })]);
    const canonicalRoot = await realpath(root);
    const sessionId = 'codex-watchdog-session';
    const turnId = 'codex-watchdog-turn';
    const createdAt = Date.now() + 60_000;
    const threadIndex = new Database(join(state, 'state_9.sqlite'));
    threadIndex.exec(
        'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER)',
    );
    threadIndex
        .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sessionId, canonicalRoot, 'Lost Stop recovery', createdAt, createdAt, 42, 0);
    threadIndex.close();
    const turnHistory = new Database(join(state, 'thread_history_1.sqlite'));
    turnHistory.exec(
        'CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, completed_at INTEGER)',
    );
    turnHistory
        .prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, turnId, 1, 'inProgress', null);
    turnHistory.close();
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('codex 0.150.1\n');
  process.exit(0);
}
function invokeHook(event) {
  const hooks = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  const group = hooks.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify({ session_id: '${sessionId}', turn_id: '${turnId}' }),
  });
}
let step = 0;
process.stdin.setRawMode?.(true);
process.stdin.on('data', () => {
  step += 1;
  if (step === 1) {
    invokeHook('UserPromptSubmit');
    process.stdout.write('Turn started\r\n');
  } else if (step === 2) {
    childProcess.execFileSync('/usr/bin/sqlite3', [
      process.env.CODEX_SQLITE_HOME + '/thread_history_1.sqlite',
      "UPDATE thread_turns SET status = 'completed', completed_at = unixepoch() WHERE turn_id = '${turnId}'",
    ]);
    process.stdout.write('Turn completed without Stop\r\n');
  }
});
process.stdin.resume();
process.stdout.write('Watchdog Agent ready\r\n');
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
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
        const caxriSessionId = await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText('Watchdog Agent ready');
        const terminalInput = running.page.locator('.xterm-helper-textarea');
        const sessionRow = running.page.locator(`[data-session-id="${caxriSessionId}"]`);

        await terminalInput.press('s');
        await expect(sessionRow.locator('.activity')).toHaveAccessibleName(
            'Working. The Agent is running.',
        );
        await terminalInput.press('f');
        await expect(sessionRow.locator('.activity')).toHaveAccessibleName(
            'Finished. The Agent finished its latest turn.',
        );
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(bootstrap.sessions.find((session) => session.id === caxriSessionId)).toMatchObject({
            attentionEpoch: 1,
            lastActivityState: 'completed',
            lastAttentionKind: 'completed',
        });
        expect(
            bootstrap.terminals.find((terminal) => terminal.sessionId === caxriSessionId),
        ).toMatchObject({ lastProcessState: 'running' });

        const log = await readFile(join(userData, 'logs', 'server-core.jsonl'), 'utf8');
        expect(log).toContain('turnStarted');
        expect(log).not.toContain('turnFinished');
        await running.page.screenshot({
            path: testInfo.outputPath('codex-lost-stop-recovered.png'),
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
