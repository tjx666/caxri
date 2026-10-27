import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentHookHealthMap } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { e2eSettingsPath } from './support/e2e-profile.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

const executableSource = `#!${process.execPath}
// 用途：一个不发送任何生命周期信号、只等待输入的假 Claude Terminal Agent。\n
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\\n');
  process.exit(0);
}
process.stdout.write('Fake Claude ready\\r\\n');
process.stdin.setRawMode?.(true);
process.stdin.resume();
`;

test('a Terminal Agent without lifecycle hooks offers them, then asks for a restart to apply them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-suggestion-e2e-'));
    const userDataDirectory = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    await mkdir(join(userDataDirectory, 'config'), { recursive: true });
    // The user default: hooks off, suggestion on. The isolated hook root keeps "Turn On Hooks" inside this profile.
    await writeFile(
        e2eSettingsPath(userDataDirectory),
        `${JSON.stringify({ 'files.autoSave': 'off', 'session.openAgentsInChat': false }, null, 2)}\n`,
    );
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
        const row = running.page.locator('.terminal-hook-suggestion');
        await expect(row).toHaveAttribute('data-hook-suggestion', 'suggest');
        await expect(row).toContainText(
            'Turn on lifecycle hooks to see when Claude is working and get notified when it finishes.',
        );
        await running.page.screenshot({ path: test.info().outputPath('suggest.png') });

        await row.getByRole('button', { name: 'Turn On Hooks' }).click();
        await expect(row).toHaveAttribute('data-hook-suggestion', 'restart');
        await expect(row).toContainText('Restart the Agent to apply them.');
        await expect
            .poll(async () => {
                const health = await pageRequest<AgentHookHealthMap>(
                    running.page,
                    'agentHooks.get',
                );
                return health.claude.kind;
            })
            .toMatch(/^(?:active|installedPending)$/u);
        expect(await readFile(e2eSettingsPath(userDataDirectory), 'utf8')).toMatch(
            /"claude":\s*\{\s*"hooks":\s*\{\s*"enabled": true/u,
        );
        await running.page.screenshot({ path: test.info().outputPath('restart.png') });

        await row.getByRole('button', { name: 'Restart Agent' }).click();
        await expect(row).toHaveCount(0);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
