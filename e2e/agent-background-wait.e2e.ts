import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

async function readFileIfPresent(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return '';
        throw error;
    }
}

/**
 * Fires one fake Claude hook by touching its trigger file, then waits for the fake's receipt.
 */
async function fireHook(config: string, name: string): Promise<void> {
    await writeFile(join(config, name), '', 'utf8');
    await expect
        .poll(async () => {
            const receipt = await readFileIfPresent(join(config, `${name}.receipt`));
            if (receipt === 'failed') throw new Error('Fake Claude hook invocation failed');
            return receipt;
        })
        .toBe('done');
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('a Claude turn that ends with a background subagent running stays in the background sub-mode', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-background-wait-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const config = join(userData, 'e2e-agents', 'claude');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.296 (Claude Code)\n');
  process.exit(0);
}
const config = process.env.CLAUDE_CONFIG_DIR;
function invokeHook(event, payload) {
  const settings = JSON.parse(fs.readFileSync(path.join(config, 'settings.json'), 'utf8'));
  const group = settings.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify(payload),
  });
}
const actions = [
  ['turn-started', 'UserPromptSubmit', {}],
  ['finished-with-background', 'Stop', {
    background_tasks: [
      { id: 'shell-1', type: 'shell', status: 'running' },
      { id: 'agent-1', type: 'subagent', status: 'running' },
    ],
  }],
  ['turn-resumed', 'UserPromptSubmit', {}],
  ['resumed-finished', 'Stop', {}],
];
setInterval(() => {
  for (const [name, event, payload] of actions) {
    const trigger = path.join(config, name);
    if (!fs.existsSync(trigger)) continue;
    fs.rmSync(trigger);
    try {
      invokeHook(event, payload);
      fs.writeFileSync(trigger + '.receipt', 'done');
    } catch {
      fs.writeFileSync(trigger + '.receipt', 'failed');
    }
  }
}, 25);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('Fake Claude background lifecycle ready\r\n');
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        testRootPath: root,
        userDataDir: userData,
    });

    try {
        const current = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        const settings = structuredClone(current.value);
        settings['agents.providers'].claude.hooks.enabled = true;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings, null, 2),
        });
        await expect
            .poll(() => readFileIfPresent(join(config, 'settings.json')))
            .toContain('UserPromptSubmit');

        const sessionId = await createProjectSession(running.page, 'claude');
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'Fake Claude background lifecycle ready',
        );
        const status = running.page.locator(`[data-session-id="${sessionId}"] .session-status`);
        await fireHook(config, 'turn-started');
        await expect(status).toHaveAttribute('data-session-status', 'running');

        await fireHook(config, 'finished-with-background');
        await expect(status).toHaveAccessibleName('In background');
        await expect(status).toHaveAttribute('data-session-status', 'running');
        await expect(status.locator('[data-session-status-background]')).toBeVisible();
        const waiting = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(waiting.sessions.find((session) => session.id === sessionId)).toMatchObject({
            hasUnread: false,
            agentActivityState: 'running',
        });
        await running.page.screenshot({ path: testInfo.outputPath('background-wait.png') });

        await fireHook(config, 'turn-resumed');
        await expect(status).toHaveAccessibleName('Working');
        await fireHook(config, 'resumed-finished');
        await expect
            .poll(async () => {
                const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
                return bootstrap.sessions.find((session) => session.id === sessionId)
                    ?.agentActivityState;
            })
            .toBe('completed');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
