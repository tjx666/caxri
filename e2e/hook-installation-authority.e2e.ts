import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentHookHealthMap } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest, revealSettingsSection } from './support/helpers.ts';

for (const mode of ['missing-cli', 'newer-incomplete'] as const) {
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
    test(`hook Settings reports ${mode} without rewriting shared configuration`, async ({}, testInfo) => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-hook-authority-e2e-'));
        const userData = join(directory, 'profile-current');
        const otherProfile = join(directory, 'profile-other');
        const root = join(directory, 'project');
        await Promise.all([mkdir(root), mkdir(otherProfile)]);
        // An absent CLI uses the blocked policy; fake mode requires at least one declared executable.
        const agentMode =
            mode === 'missing-cli'
                ? { mode: 'blocked' as const }
                : await createFakeAgentMode({
                      userDataDir: userData,
                      providers: { codex: {} },
                  });
        const shared = join(userData, 'agent-hooks');
        await mkdir(shared, { recursive: true });
        await writeFile(
            join(shared, 'profile-intents.json'),
            JSON.stringify({
                version: 2,
                profiles: { fixtureOther: { profilePath: otherProfile, providers: ['codex'] } },
            }),
        );
        const hooks = join(userData, 'e2e-agents', 'codex', 'hooks.json');
        await mkdir(join(userData, 'e2e-agents', 'codex'), { recursive: true });
        const installedSchema = mode === 'missing-cli' ? 0 : 99;
        await writeFile(
            hooks,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            hooks: [
                                {
                                    type: 'command',
                                    command: `'/fixture/bridge' --source caxri --provider codex --phase turnFinished --schema ${installedSchema}`,
                                },
                            ],
                        },
                    ],
                },
            }),
        );
        const identity = async () => ({
            hash: createHash('sha256')
                .update(await readFile(hooks))
                .digest('hex'),
            mtime: (await stat(hooks, { bigint: true })).mtimeNs,
        });
        const before = await identity();
        const running = await launchCaxri({
            agentMode,
            userDataDir: userData,
            testRootPath: root,
            env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        });
        try {
            await running.page.keyboard.press('Meta+,');
            const dialog = running.page.getByRole('dialog');
            await revealSettingsSection(dialog, 'Codex');
            const caption = dialog
                .locator('[data-setting-row="agents.codex.hooks"]')
                .getByRole('status');
            await expect(caption).toContainText(
                mode === 'missing-cli'
                    ? 'Waiting for the agent CLI to be installed'
                    : 'Newer installation is incomplete',
            );
            const health = await pageRequest<AgentHookHealthMap>(running.page, 'agentHooks.get');
            expect(health.codex).toMatchObject(
                mode === 'missing-cli'
                    ? { kind: 'notInstalled' }
                    : { kind: 'incompatible', installedSchema: 99 },
            );
            expect(await identity()).toEqual(before);
            await running.page.screenshot({ path: testInfo.outputPath(`${mode}-hook-health.png`) });
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
