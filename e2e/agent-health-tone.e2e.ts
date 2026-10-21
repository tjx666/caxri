import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentHookHealthMap } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { openSettingsTab, revealSettingsSection } from './support/settings.ts';

test('Active Agent hook health keeps its informational Settings tone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-health-tone-e2e-'));
    const userDataDirectory = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const bridge = join(userDataDirectory, 'agent-hooks', 'bin', 'caxri-agent-hook-bridge');
    const executableSource = `#!${process.execPath}
// 用途：在隔离的假 Agent Terminal 中发送一次真实的本地生命周期信号。\n
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\\n');
  process.exit(0);
}
const result = require('node:child_process').spawnSync(${JSON.stringify(bridge)}, [
  '--source', 'caxri', '--provider', 'claude', '--phase', 'turnFinished', '--reply', 'empty-json'
], { env: process.env, encoding: 'utf8', timeout: 10000 });
if (result.status !== 0) process.exit(1);
process.stdout.write('Fake Claude ready\\r\\n');
process.stdin.setRawMode?.(true);
process.stdin.resume();
`;
    const agentMode = await createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: { claude: { executableSource } },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userDataDirectory,
        testRootPath: root,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });
    try {
        await createProjectSession(running.page, 'claude');
        await expect
            .poll(async () => {
                const health = await pageRequest<AgentHookHealthMap>(
                    running.page,
                    'agentHooks.get',
                );
                return health.claude.kind;
            })
            .toBe('active');
        const settingsTab = await openSettingsTab(running.page);
        await revealSettingsSection(settingsTab, 'Claude');
        const caption = settingsTab
            .locator('[data-setting-row="agents.claude.hooks"]')
            .getByRole('status');
        await expect(caption).toHaveText('Installation: Active');
        await expect(caption).toHaveAttribute('data-tone', 'muted');
        await expect(caption.locator('[aria-hidden="true"]')).toHaveCount(0);
        await caption.screenshot({ path: test.info().outputPath('active-hook-status.png') });
        await running.page.screenshot({ path: test.info().outputPath('active-settings.png') });
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
