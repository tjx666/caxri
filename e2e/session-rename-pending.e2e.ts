import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest, sessionCard } from './support/helpers.ts';

/**
 * A native rename that takes 4s, close to a cold `claude --resume`, and fails for any name starting with `Fail`.
 */
const slowRenameClaude = `#!${process.execPath}
// Deterministic Agent boundary for the pending rename workflow; no host provider is discovered.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const home = process.env.CLAUDE_CONFIG_DIR;
const id = 'pending-rename-session';
if (process.argv.includes('--version')) { console.log('2.1.263 (Claude Code)'); process.exit(0); }
if (process.argv.includes('--resume')) {
  const name = process.argv.at(-1).slice('/rename '.length);
  setTimeout(() => {
    if (name.startsWith('Fail')) { console.error('rename rejected'); process.exit(1); }
    fs.writeFileSync(path.join(home, 'renamed.txt'), name);
    console.log(JSON.stringify({ is_error: false, result: 'Session renamed to: ' + name, session_id: id, subtype: 'success', type: 'result' }));
    process.exit(0);
  }, 4000);
} else {
  const metadata = path.join(home, 'sessions', 'pending.json');
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({ cwd: process.cwd(), sessionId: id, name: 'project', nameSource: 'derived', status: 'idle', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const ready = setInterval(() => { try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    if (!settings.hooks?.UserPromptSubmit?.length) return;
    clearInterval(ready);
    cp.execFileSync('/bin/sh', ['-c', settings.hooks.UserPromptSubmit[0].hooks[0].command], { env: process.env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: id }), stdio: ['pipe', 'ignore', 'ignore'] });
  } catch {} }, 50);
  process.stdin.resume();
}
`;

test('a slow Agent rename shows at once and reverts with a toast when it fails', async () => {
    // The second rename fails on purpose; its toast is the behavior under test.
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'UNAVAILABLE', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'UNAVAILABLE', count: 1 },
        { source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-pending-rename-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const mode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: slowRenameClaude } },
    });
    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        agentMode: mode,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });
    const serverTitle = async (sessionId: string) =>
        (await pageRequest<BootstrapState>(running.page, 'app.bootstrap', {})).sessions.find(
            ({ id }) => id === sessionId,
        )?.title;
    const rename = async (sessionId: string, title: string) => {
        const card = sessionCard(running.page, sessionId);
        await card.dblclick();
        const input = card.getByRole('textbox');
        await input.fill(title);
        await input.press('Enter');
    };
    try {
        const sessionId = await createProjectSession(running.page, 'claude');
        await expect
            .poll(
                async () =>
                    (
                        await pageRequest<BootstrapState>(running.page, 'app.bootstrap', {})
                    ).terminals.find(({ provider }) => provider === 'claude')?.agentSessionId,
                { timeout: 30_000 },
            )
            .toBe('pending-rename-session');
        const title = sessionCard(running.page, sessionId).locator('strong');
        const renamedMarker = join(userData, 'e2e-agents', 'claude', 'renamed.txt');

        await rename(sessionId, 'Slow success');
        // Visible well before the 4s provider call could have committed it.
        await expect(title).toHaveText('Slow success', { timeout: 1000 });
        // A Server read would wait behind the rename write, so the fake's own completion marker is the probe.
        await expect(stat(renamedMarker)).rejects.toThrow();
        await expect.poll(() => serverTitle(sessionId)).toBe('Slow success');

        await rename(sessionId, 'Failing name');
        await expect(title).toHaveText('Failing name', { timeout: 1000 });
        await expect(running.page.getByText('Session rename failed')).toBeVisible();
        await expect(title).toHaveText('Slow success');
        expect(await serverTitle(sessionId)).toBe('Slow success');
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
