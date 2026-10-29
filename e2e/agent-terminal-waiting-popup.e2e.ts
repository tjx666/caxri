import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('A PTY Agent waiting in a Terminal off screen shows an open-only popup entry', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-waiting-popup-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const config = join(userData, 'e2e-agents', 'codex');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.162.0\n');
  process.exit(0);
}
const config = process.env.CODEX_HOME;
process.stdin.resume();
setInterval(() => {
  const trigger = path.join(config, 'event.json');
  if (!fs.existsSync(trigger)) return;
  const event = JSON.parse(fs.readFileSync(trigger, 'utf8'));
  fs.rmSync(trigger);
  const settings = JSON.parse(fs.readFileSync(path.join(config, 'hooks.json'), 'utf8'));
  for (const group of settings.hooks[event.name] ?? []) {
    if (group.matcher && !new RegExp(group.matcher).test(event.tool ?? '')) continue;
    for (const hook of group.hooks) execFileSync('/bin/sh', ['-c', hook.command], {
      env: process.env,
      input: JSON.stringify({ tool_name: event.tool, tool_use_id: event.id }),
    });
  }
}, 25);
process.stdout.write('Question fixture ready\r\n');
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
        const { page } = running;
        const popup = page.locator('[data-agent-chat-waiting="card"]');
        const sessionId = await createProjectSession(page, 'codex');
        const state = async () =>
            (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
                (session) => session.id === sessionId,
            )?.agentActivityState;
        const selected = async () =>
            (await pageRequest<{ selectedSessionId?: string }>(page, 'app.bootstrap'))
                .selectedSessionId;
        const emit = async (name: string, tool?: string, id?: string) => {
            await writeFile(join(config, 'event.next.json'), JSON.stringify({ name, tool, id }));
            await rename(join(config, 'event.next.json'), join(config, 'event.json'));
        };
        await expect(page.locator('.xterm-rows')).toContainText('Question fixture ready');
        await emit('UserPromptSubmit');
        await expect.poll(state).toBe('running');

        // The Agent's Terminal is on screen, so its own prompt asks: no popup.
        await emit('PreToolUse', 'request_user_input', 'question-1');
        await expect.poll(state).toBe('waiting');
        await expect(popup).toHaveCount(0);

        // Another Session takes the screen: the waiting Agent gets a read-only entry that cannot be answered here.
        await createAdditionalShellSession(page);
        await expect(popup).toContainText('Waiting for your response in Terminal');
        await expect(popup.getByRole('button', { name: 'Open Session' })).toBeVisible();
        await expect(popup.getByRole('radio')).toHaveCount(0);
        await expect(popup).not.toContainText('more pending');
        await page.screenshot({ path: testInfo.outputPath('terminal-waiting-popup.png') });

        // Open Session jumps to its Terminal, which takes the entry away.
        await popup.getByRole('button', { name: 'Open Session' }).click();
        await expect.poll(selected).toBe(sessionId);
        await expect(popup).toHaveCount(0);

        // Answering in the Terminal resumes the Agent, and an entry shown meanwhile disappears by itself.
        await emit('PostToolUse', 'request_user_input', 'question-1');
        await expect.poll(state).toBe('running');
        await createAdditionalShellSession(page);
        await emit('PreToolUse', 'request_user_input', 'question-2');
        await expect.poll(state).toBe('waiting');
        await expect(popup).toContainText('Waiting for your response in Terminal');
        await emit('PostToolUse', 'request_user_input', 'question-2');
        await expect.poll(state).toBe('running');
        await expect(popup).toHaveCount(0);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
