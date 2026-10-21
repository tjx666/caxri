import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentHookHealthMap } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest } from './support/helpers.ts';
import { openSettingsTab, revealSettingsSection } from './support/settings.ts';

for (const mode of ['missing-cli', 'newer-incomplete', 'malformed-config', 'conflict'] as const) {
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
            mode === 'malformed-config'
                ? '{ "hooks": false }\n'
                : JSON.stringify({
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
        if (mode === 'conflict')
            await writeFile(
                join(userData, 'e2e-agents', 'codex', 'config.toml'),
                '[[hooks.Stop]]\ncommand = "foreign"\n',
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
            const settingsTab = await openSettingsTab(running.page);
            await revealSettingsSection(settingsTab, 'Codex');
            const caption = settingsTab
                .locator('[data-setting-row="agents.codex.hooks"]')
                .getByRole('status');
            const expected = {
                // Muted, not a warning: a missing CLI is a prerequisite the user has simply not installed yet, not
                // something Caxri got wrong. Reserving the dot for states that need repair keeps it meaningful.
                'missing-cli': {
                    kind: 'notInstalled',
                    label: 'Not in effect — Install the Codex CLI, then restart Caxri.',
                    tone: 'muted',
                },
                'newer-incomplete': {
                    kind: 'incompatible',
                    label: 'Newer installation is incomplete',
                    tone: 'warning',
                },
                'malformed-config': { kind: 'error', label: 'Setup failed', tone: 'danger' },
                'conflict': {
                    kind: 'conflict',
                    label: 'Blocked by your configuration — Codex already defines inline hooks in config.toml',
                    tone: 'danger',
                },
            }[mode];
            await expect(caption).toContainText(expected.label);
            await expect(caption).toHaveAttribute('data-tone', expected.tone);
            // The dot is what carries an urgent state without relying on color, so it belongs to exactly the tones
            // that ask the user to act (`field.tsx`).
            await expect(caption.locator('[aria-hidden="true"]')).toHaveCount(
                expected.tone === 'muted' ? 0 : 1,
            );
            const health = await pageRequest<AgentHookHealthMap>(running.page, 'agentHooks.get');
            expect(health.codex).toMatchObject({ kind: expected.kind });
            expect(await identity()).toEqual(before);
            await caption.screenshot({ path: testInfo.outputPath(`${mode}-hook-status.png`) });
            await running.page.screenshot({ path: testInfo.outputPath(`${mode}-hook-health.png`) });
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
