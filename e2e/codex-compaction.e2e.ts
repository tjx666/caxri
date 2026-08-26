import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('Codex compaction is visible without becoming attention or hiding process state', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-compaction-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('codex 0.149.0\n');
  process.exit(0);
}
function invokeHook(event) {
  const hooks = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  const group = hooks.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify({ session_id: 'codex-compaction-e2e' }),
  });
}
let step = 0;
process.stdin.setRawMode?.(true);
process.stdin.on('data', () => {
  step += 1;
  if (step === 1) {
    process.stdout.write('\u001b]9;4;1;42\u0007');
    invokeHook('UserPromptSubmit');
    invokeHook('PreCompact');
    process.stdout.write('Compaction started\r\n');
  } else if (step === 2) {
    invokeHook('PostCompact');
    process.stdout.write('Compaction finished\r\n');
  } else if (step === 3) {
    invokeHook('PreCompact');
    process.stdout.write('Compaction restarted\r\n');
  }
});
process.stdin.resume();
process.stdout.write('Compaction Agent ready\r\n');
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });

    try {
        const currentSettings = await pageRequest<{ value: AppSettings }>(
            running.page,
            'settings.get',
        );
        const settings = structuredClone(currentSettings.value);
        settings['agents.providers'].codex.hooks.enabled = true;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings, null, 2),
        });
        const sessionId = await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText('Compaction Agent ready');
        await running.page.emulateMedia({ reducedMotion: 'reduce' });

        await running.page.locator('.xterm-helper-textarea').press('c');
        const activeTab = running.page.locator('.work-tab.active[data-terminal-id]');
        const tabOperation = activeTab.locator('.terminal-agent-operation');
        const statusOperation = running.page.locator('.statusbar-agent-operation');
        const sessionRow = running.page.locator(`[data-session-id="${sessionId}"]`);
        await expect(tabOperation).toHaveText('Compacting');
        await expect(tabOperation).toHaveAccessibleName('Compacting context');
        await expect(tabOperation).toHaveAttribute('data-agent-operation', 'compacting');
        await expect(activeTab.locator('.terminal-progress-tab')).toHaveCount(0);
        await expect(activeTab.locator('.process-running')).toBeVisible();
        await expect(statusOperation).toHaveText('Compacting');
        await expect(statusOperation).toHaveAccessibleName('Codex is compacting context');
        await expect(statusOperation).toHaveAttribute('aria-live', 'polite');
        await expect(statusOperation).toHaveAttribute('role', 'status');
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveCount(0);
        await expect(sessionRow.locator('.activity')).toHaveAccessibleName(
            'Compacting. Codex is summarizing earlier context before continuing.',
        );
        await expect(sessionRow.locator('.session-unread')).toHaveCount(0);

        expect(await tabOperation.evaluate((element) => element.getAnimations().length)).toBe(0);

        const compactingState = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(
            compactingState.terminals.find((terminal) => terminal.sessionId === sessionId),
        ).toMatchObject({ agentOperation: 'compacting' });
        expect(compactingState.sessions.find((session) => session.id === sessionId)).toMatchObject({
            hasUnread: false,
            lastActivityState: 'running',
        });

        await sessionRow.hover();
        const activityCard = running.page.locator('.session-activity-card');
        await expect(activityCard).toBeVisible();
        await expect(activityCard).toContainText('Compacting');
        await expect(activityCard).toContainText(
            'Codex is summarizing earlier context before continuing.',
        );
        await running.page.screenshot({
            path: testInfo.outputPath('codex-compacting.png'),
        });

        await running.page.keyboard.press('Escape');
        await activeTab.getByRole('tab').click();
        await running.page.locator('.xterm-helper-textarea').press('p');
        await expect(tabOperation).toHaveCount(0);
        await expect(statusOperation).toHaveCount(0);
        await expect(activeTab.getByLabel('Terminal progress: 42 percent')).toBeVisible();
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveAccessibleName(
            'Terminal progress: 42 percent',
        );
        await expect(sessionRow.locator('.activity')).toHaveAccessibleName(
            'Working. The Agent is running.',
        );
        const finishedState = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(
            finishedState.terminals.find((terminal) => terminal.sessionId === sessionId)
                ?.agentOperation,
        ).toBeUndefined();

        /**
         * A Session has to read the same way wherever its row is drawn, and the MRU switcher shares the
         * PrimarySidebar's activity dot. Compaction is restarted here, at the end, because the switcher only lists the
         * Sessions the user is not on: reaching it needs a second Session and a switch, which discards the ephemeral
         * Terminal progress the workflow above asserts.
         */
        await running.page.locator('.xterm-helper-textarea').press('c');
        await expect(tabOperation).toHaveText('Compacting');
        await createAdditionalShellSession(running.page);
        await running.page.keyboard.down('Control');
        await running.page.keyboard.down('Alt');
        await running.page.keyboard.press('Tab');
        const switcherRow = running.page
            .getByRole('listbox', { name: 'Recently used Sessions' })
            .locator(`[data-session-id="${sessionId}"] .activity`);
        await expect(switcherRow).toHaveAttribute('data-agent-operation', 'compacting');
        await expect(switcherRow).toHaveAccessibleName(
            'Compacting. Codex is summarizing earlier context before continuing.',
        );
        await running.page.keyboard.up('Alt');
        await running.page.keyboard.up('Control');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionId);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
