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
test('Codex questions raise attention and answers resume the Session', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-question-'));
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
        const sessionId = await createProjectSession(running.page, 'codex');
        const row = running.page.locator(`[data-session-id="${sessionId}"]`);
        const status = row.locator('.session-status');
        const state = async () =>
            (await pageRequest<BootstrapState>(running.page, 'app.bootstrap')).sessions.find(
                (session) => session.id === sessionId,
            )?.lastActivityState;
        const emit = async (name: string, tool?: string, id?: string) => {
            await writeFile(join(config, 'event.next.json'), JSON.stringify({ name, tool, id }));
            await rename(join(config, 'event.next.json'), join(config, 'event.json'));
        };
        await expect(running.page.locator('.xterm-rows')).toContainText('Question fixture ready');
        await emit('UserPromptSubmit');
        await expect.poll(state).toBe('running');
        /**
         * An open and focused Session acknowledges attention immediately; exercise the unread sidebar reminder.
         */
        await createAdditionalShellSession(running.page);
        await emit('PreToolUse', 'request_user_input', 'question-1');
        await expect.poll(state).toBe('waiting');
        await expect(status).toHaveAttribute('data-session-status', 'attention');
        await expect(status).toHaveAttribute('data-attention-kind', 'waiting');
        expect(
            await status
                .locator('[data-session-status-ripple]')
                .evaluate((element) => element.getAnimations().length),
        ).toBeGreaterThan(0);
        await row.screenshot({ path: testInfo.outputPath('question-attention.png') });
        await emit('PostToolUse', 'request_user_input', 'question-1');
        await expect.poll(state).toBe('running');
        // Unread attention outranks running on the icon, so the resumed work shows in its accessible name.
        await expect(status).toHaveAccessibleName(/Current status: Working\./);
        await emit('Stop');
        await expect.poll(state).toBe('completed');
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
