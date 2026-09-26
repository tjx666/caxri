import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';
import Database from 'better-sqlite3';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    typeTerminal,
} from './support/helpers.ts';

const INITIAL_THREAD = '019a0000-0000-7000-8000-000000000001';
const RESUMED_THREAD = '019a0000-0000-7000-8000-000000000042';

async function acceptedHookCount(
    logPath: string,
    phase: 'turnStarted' | 'turnFinished',
): Promise<number> {
    const log = await readFile(logPath, 'utf8');
    return log
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event?: string; fields?: { phase?: string } })
        .filter(
            (entry) =>
                entry.event === 'agent_hooks.signal_accepted' && entry.fields?.phase === phase,
        ).length;
}

for (const entry of ['shell', 'codex', 'exited-codex'] as const) {
    // eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
    test(`manual Codex resume from ${entry} tracks the resumed turn in the sidebar`, async ({}, testInfo) => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-manual-resume-'));
        const userData = join(directory, 'user-data');
        const root = join(directory, 'project');
        await mkdir(root);
        const agentMode = await createFakeAgentMode({
            userDataDir: userData,
            providers: {
                codex: {
                    executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.154.0\n');
  process.exit(0);
}
// Model Codex 0.154's launch eligibility before allowing managed hooks to run.
if (process.env.CAXRI_MANAGED_AGENT === '1' &&
    !(process.argv[2] === '-c' && process.argv[3] === 'tui.auto_recap=false')) {
  process.exit(1);
}
let thread = process.argv.includes('resume') ? '${RESUMED_THREAD}' : '${INITIAL_THREAD}';
let rolloutFile;
function openRollout() {
  if (rolloutFile !== undefined) fs.closeSync(rolloutFile);
  const directory = path.join(process.env.CODEX_HOME, 'sessions', '2026', '01', '01');
  fs.mkdirSync(directory, { recursive: true });
  rolloutFile = fs.openSync(
    path.join(directory, 'rollout-2026-01-01T00-00-00-' + thread + '.jsonl'),
    'a',
  );
}
function hook(event) {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  for (const group of config.hooks[event] ?? []) {
    for (const definition of group.hooks) {
      cp.execFileSync('/bin/sh', ['-c', definition.command], {
        input: JSON.stringify({ session_id: thread, turn_id: 'fixture-turn', cwd: process.cwd() }),
        stdio: ['pipe', 'ignore', 'inherit'],
      });
    }
  }
}
openRollout();
hook('SessionStart');
let input = '';
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  for (const character of chunk.toString()) {
    if (character !== '\r' && character !== '\n') { input += character; continue; }
    const command = input; input = '';
    if (command === 'exit') process.exit(0);
    else if (command.startsWith('/resume')) { thread = '${RESUMED_THREAD}'; openRollout(); hook('SessionStart'); }
    else if (command === 'work') hook('UserPromptSubmit');
    else if (command === 'finish') hook('Stop');
    process.stdout.write('Fixture input handled\r\n');
  }
});
process.stdout.write('Fake Codex ready\r\n');
`,
                },
            },
        });
        const codexState = agentMode.environment.CODEX_SQLITE_HOME;
        if (!codexState) throw new Error('Fake Codex state directory is unavailable');
        await mkdir(codexState, { recursive: true });
        const stateDatabase = new Database(join(codexState, 'state_1.sqlite'));
        stateDatabase.exec(
            'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER)',
        );
        stateDatabase.exec(
            'CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)',
        );
        const insertThread = stateDatabase.prepare(
            'INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        );
        const now = Date.now();
        insertThread.run(INITIAL_THREAD, root, 'Initial fixture', null, now, now, 0, 0);
        insertThread.run(RESUMED_THREAD, root, 'Resumed fixture', null, now + 1, now + 1, 0, 0);
        stateDatabase.close();
        const turnHistory = new Database(join(codexState, 'thread_history_1.sqlite'));
        turnHistory.exec(
            'CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, completed_at INTEGER)',
        );
        turnHistory
            .prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)')
            .run(RESUMED_THREAD, 'resumed-in-progress-turn', 1, 'inProgress', null);
        turnHistory.close();
        const running = await launchCaxri({
            agentMode,
            env: { CAXRI_E2E_AGENT_HOOKS: '1' },
            testRootPath: root,
            userDataDir: userData,
        });
        try {
            const current = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
            const settings = structuredClone(current.value);
            settings['agents.providers'].codex.hooks.enabled = true;
            await pageRequest(running.page, 'settings.update', {
                source: JSON.stringify(settings),
            });
            await expect
                .poll(async () => {
                    try {
                        return await readFile(
                            join(userData, 'e2e-agents/codex/hooks.json'),
                            'utf8',
                        );
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
                        throw error;
                    }
                })
                .toContain('UserPromptSubmit');
            if (entry === 'shell') {
                await createShellSession(running.page);
                await typeTerminal(running.page, `codex resume ${RESUMED_THREAD}`);
            } else {
                await createProjectSession(running.page, 'codex');
            }
            await expect(running.page.locator('.xterm-rows')).toContainText('Fake Codex ready');
            const status = running.page.locator('[data-session-status="running"]');
            if (entry === 'codex') {
                await typeTerminal(running.page, `/resume ${RESUMED_THREAD}`);
                await expect
                    .poll(async () => {
                        const state = await pageRequest<BootstrapState>(
                            running.page,
                            'app.bootstrap',
                        );
                        return {
                            activity: state.sessions[0]?.lastActivityState,
                            agentSessionId: state.terminals[0]?.agentSessionId,
                        };
                    })
                    .toEqual({ activity: 'running', agentSessionId: RESUMED_THREAD });
                await expect(status).toBeVisible();
            } else if (entry === 'exited-codex') {
                await typeTerminal(running.page, 'exit');
                await expect
                    .poll(async () => {
                        const state = await pageRequest<BootstrapState>(
                            running.page,
                            'app.bootstrap',
                        );
                        return state.terminals[0]?.lastAgentProcessState;
                    })
                    .toBe('stopped');
                await typeTerminal(running.page, `codex resume ${RESUMED_THREAD}`);
                await expect
                    .poll(async () => {
                        const state = await pageRequest<BootstrapState>(
                            running.page,
                            'app.bootstrap',
                        );
                        return state.terminals[0]?.lastAgentProcessState;
                    })
                    .toBe('running');
            }
            const hookLogPath = join(userData, 'logs', 'server-core.jsonl');
            const startsBeforeWork =
                entry === 'shell' ? 0 : await acceptedHookCount(hookLogPath, 'turnStarted');
            await typeTerminal(running.page, 'work');
            /**
             * The resumed thread ID and sidebar's running status can both predate this prompt. Wait for the hook from
             * this exact managed turn before sending `finish`, so the assertion cannot pass on inherited running state
             * while the fixture is still processing `work`. A Shell-launched Codex first reports providerMismatch and
             * binds through Shell promotion, so it has no accepted hook receipt at this point.
             */
            if (entry !== 'shell')
                await expect
                    .poll(() => acceptedHookCount(hookLogPath, 'turnStarted'))
                    .toBeGreaterThan(startsBeforeWork);
            await expect
                .poll(async () => {
                    const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
                    return state.terminals[0]?.agentSessionId;
                })
                .toBe(RESUMED_THREAD);
            await expect(status).toBeVisible();
            await running.page.screenshot({ path: testInfo.outputPath('resumed-running.png') });
            const finishesBeforeFinish =
                entry === 'shell' ? 0 : await acceptedHookCount(hookLogPath, 'turnFinished');
            await typeTerminal(running.page, 'finish');
            if (entry !== 'shell')
                await expect
                    .poll(() => acceptedHookCount(hookLogPath, 'turnFinished'))
                    .toBeGreaterThan(finishesBeforeFinish);
            await expect(status).toHaveCount(0);
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
