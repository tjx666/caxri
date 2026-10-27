import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import type { BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { runnerCliEnvironment } from './support/cli-environment.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

const execute = promisify(execFile);

/**
 * Production releases a quiet hook turn after two real minutes of missing evidence. That window, and the three probes
 * it schedules inside, are pinned with a fake clock by
 * `apps/server/src/domains/agents/__tests__/hook-launch-tracker.test.ts`, so this workflow only has to prove that the
 * Server, the hook bridge, and the Renderer are wired to the same recovery. It therefore injects the bounded E2E window
 * below instead of spending two real minutes on the single-worker CI pool.
 */
const UNKNOWN_RECOVERY_MS = 4_000;

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('hook turns recover after CLI interrupt, Escape, and sustained unknown evidence', async ({}, testInfo) => {
    test.setTimeout(90_000);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-hook-recovery-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const config = join(userData, 'e2e-agents', 'claude');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\n');
  process.exit(0);
}
const config = process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(path.join(config, 'endpoint-ref'), [process.env.CAXRI_AGENT_ENDPOINT_HOST_ID, process.env.CAXRI_AGENT_ENDPOINT_ID, process.env.CAXRI_AGENT_ENDPOINT_GENERATION].join(':'));
process.on('SIGINT', () => fs.writeFileSync(path.join(config, 'interrupted'), 'done'));
process.stdin.setRawMode?.(true);
process.stdin.resume();
setInterval(() => {
  const trigger = path.join(config, 'start-turn');
  if (!fs.existsSync(trigger)) return;
  fs.rmSync(trigger);
  const settings = JSON.parse(fs.readFileSync(path.join(config, 'settings.json'), 'utf8'));
  execFileSync('/bin/sh', ['-c', settings.hooks.UserPromptSubmit[0].hooks[0].command], {
    env: process.env, input: JSON.stringify({}),
  });
  process.stdout.write('Fixture turn started\r\n');
}, 25);
process.stdout.write('Hook recovery fixture ready\r\n');
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: {
            CAXRI_E2E_AGENT_HOOKS: '1',
            CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS: String(UNKNOWN_RECOVERY_MS),
        },
    });
    try {
        const sessionId = await createProjectSession(running.page, 'claude');
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'Hook recovery fixture ready',
        );
        const row = running.page.locator(`[data-session-id="${sessionId}"]`);
        const status = row.locator('.session-status');
        await writeFile(join(config, 'start-turn'), '');
        await expect(status).toHaveAttribute('data-session-status', 'running');
        const endpoint = await readFile(join(config, 'endpoint-ref'), 'utf8');
        const cli = resolve(import.meta.dirname, '../apps/cli/dist/caxri.cjs');
        await execute(
            process.execPath,
            [
                cli,
                'agent',
                'control',
                'interrupt',
                endpoint,
                '--profile',
                userData,
                '--yes',
                '--json',
            ],
            { env: runnerCliEnvironment(), timeout: 10_000 },
        );
        await expect(status).toHaveAttribute('data-session-status', 'default');
        expect(
            (await pageRequest<BootstrapState>(running.page, 'app.bootstrap')).sessions.find(
                (session) => session.id === sessionId,
            )?.agentActivityState,
        ).toBe('unknown');
        await expect.poll(() => readFile(join(config, 'interrupted'), 'utf8')).toBe('done');
        await writeFile(join(config, 'start-turn'), '');
        await expect(status).toHaveAttribute('data-session-status', 'running');
        await running.page.locator('.xterm-helper-textarea').focus();
        await running.page.keyboard.press('Escape');
        await expect(status).toHaveAttribute('data-session-status', 'default');
        expect(
            (await pageRequest<BootstrapState>(running.page, 'app.bootstrap')).sessions.find(
                (session) => session.id === sessionId,
            )?.agentActivityState,
        ).toBe('unknown');
        await writeFile(join(config, 'start-turn'), '');
        await expect(status).toHaveAttribute('data-session-status', 'running');
        await running.page.screenshot({ path: testInfo.outputPath('quiet-turn-running.png') });
        // The fixture emits no Stop hook or metadata and keeps its process alive throughout recovery. The margin over
        // the injected window absorbs a loaded CI runner, not a second recovery attempt.
        await expect(status).toHaveAttribute('data-session-status', 'default', {
            timeout: UNKNOWN_RECOVERY_MS + 30_000,
        });
        const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(state.sessions.find((session) => session.id === sessionId)).toMatchObject({
            agentActivityState: 'unknown',
            attentionGeneration: 0,
            hasUnread: false,
        });
        const terminalId = state.sessions.find(
            (session) => session.id === sessionId,
        )?.primaryAgentTerminalId;
        expect(state.terminals.find((terminal) => terminal.id === terminalId)).toMatchObject({
            lastAgentProcessState: 'running',
            lastProcessState: 'running',
        });
        await running.page.screenshot({ path: testInfo.outputPath('quiet-turn-recovered.png') });
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
