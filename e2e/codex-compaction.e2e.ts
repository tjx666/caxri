import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import type { AppSettings, BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { runnerCliEnvironment } from './support/cli-environment.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('Codex compaction is prominent in the tab without duplicating process or status-bar state', async ({}, testInfo) => {
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
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'endpoint-ref'), [process.env.CAXRI_AGENT_ENDPOINT_HOST_ID, process.env.CAXRI_AGENT_ENDPOINT_ID, process.env.CAXRI_AGENT_ENDPOINT_GENERATION].join(':'));
process.on('SIGINT', () => process.stdout.write('SIGINT received\r\n'));
let step = 0;
process.stdin.setRawMode?.(true);
process.stdin.on('data', (data) => {
  if (data.length === 1 && data[0] === 0x1b) {
    process.stdout.write('Escape received\r\n');
    return;
  }
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
        /**
         * Native pointer events can leave the row after Playwright hovers it in a visible window. Keep this DOM
         * workflow hidden so the hover delay is controlled by its own pointer; visible behavior is covered by
         * Acceptance.
         */
        windowMode: 'hidden',
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
        await expect(running.page.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'Compaction Agent ready',
        );
        await running.page.emulateMedia({ reducedMotion: 'no-preference' });

        const terminalInput = running.page.locator(`${VISIBLE_SESSION} .xterm-helper-textarea`);
        await terminalInput.press('c');
        const activeTab = running.page.locator(
            `${VISIBLE_SESSION} .work-tab.active[data-terminal-id]`,
        );
        const tabOperation = activeTab.locator('.terminal-agent-operation');
        const statusOperation = running.page.locator('.statusbar-agent-operation');
        const sessionRow = running.page.locator(`[data-session-id="${sessionId}"]`);
        await expect(tabOperation).toHaveText('Compacting');
        await expect(tabOperation).toBeVisible();
        await expect(tabOperation).toHaveAccessibleName('Compacting context');
        await expect(tabOperation).toHaveAttribute('data-agent-operation', 'compacting');
        await expect(tabOperation).toHaveAttribute('aria-live', 'polite');
        await expect(tabOperation).toHaveAttribute('role', 'status');
        await expect(
            running.page.getByRole('status', { name: 'Compacting context', exact: true }),
        ).toHaveCount(1);
        await expect(tabOperation.locator('svg, [data-slot="spinner"]')).toHaveCount(0);
        expect(
            await tabOperation.evaluate(
                (element) =>
                    getComputedStyle(element).color ===
                    getComputedStyle(element.closest('.work-tab')!).color,
            ),
        ).toBe(true);
        expect(
            await tabOperation.evaluate((element) =>
                element
                    .getAnimations()
                    .some((animation) => animation.effect?.getTiming().iterations === Infinity),
            ),
        ).toBe(true);
        expect(
            await activeTab
                .locator('.tab-label')
                .evaluate((element) => element.getAnimations().length),
        ).toBe(0);
        expect(
            await activeTab
                .locator('[data-agent-icon]')
                .evaluate((element) => element.getAnimations().length),
        ).toBe(0);
        await expect(activeTab.locator('.terminal-progress-tab')).toHaveCount(0);
        await expect(activeTab.locator('.process-indicator')).toHaveCount(0);
        await expect(activeTab.locator('.process-running')).toHaveCount(0);
        await expect(statusOperation).toHaveCount(0);
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveAccessibleName(
            'Terminal progress: 42 percent',
        );
        const sessionStatus = sessionRow.locator('.session-status');
        await expect(sessionStatus).toHaveAttribute('data-session-status', 'running');
        await expect(sessionStatus).toHaveAccessibleName('Compacting');
        await expect(sessionStatus).toHaveAccessibleDescription(
            'The Agent is summarizing earlier context before continuing.',
        );

        await running.page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(tabOperation).toBeVisible();
        expect(await tabOperation.evaluate((element) => element.getAnimations().length)).toBe(0);
        expect(
            await sessionStatus
                .locator('[data-session-status-arc]')
                .evaluate((element) => element.getAnimations().length),
        ).toBe(0);

        const compactingState = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(
            compactingState.terminals.find((terminal) => terminal.sessionId === sessionId),
        ).toMatchObject({ agentOperation: 'compacting' });
        expect(compactingState.sessions.find((session) => session.id === sessionId)).toMatchObject({
            hasUnread: false,
            agentActivityState: 'running',
        });

        await expect(sessionCard(running.page, sessionId)).toHaveAccessibleDescription(
            /Compacting\. The Agent is summarizing earlier context before continuing\./,
        );
        await sessionRow.hover();
        const activityCard = running.page.locator('.session-activity-card');
        await expect(activityCard).toBeVisible();
        await running.page.screenshot({
            path: testInfo.outputPath('codex-compacting.png'),
        });

        await activeTab.getByRole('tab').click();
        await expect(activityCard).toHaveCount(0);
        await running.page.locator(`${VISIBLE_SESSION} .xterm-screen`).click();
        await expect(terminalInput).toBeFocused();
        await terminalInput.press('Escape');
        await expect(running.page.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'Escape received',
        );
        await expect(tabOperation).toHaveCount(0);
        await expect(statusOperation).toHaveCount(0);
        await expect(activeTab.getByLabel('Terminal progress: 42 percent')).toBeVisible();
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveAccessibleName(
            'Terminal progress: 42 percent',
        );
        await expect(sessionStatus).toHaveAttribute('data-session-status', 'default');
        await expect(sessionStatus).toHaveAttribute('aria-hidden', 'true');
        const finishedState = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(
            finishedState.terminals.find((terminal) => terminal.sessionId === sessionId)
                ?.agentOperation,
        ).toBeUndefined();

        // Only after Escape has cleared both live and durable operation state may the fixture emit lifecycle input.
        await terminalInput.press('p');

        /**
         * A Session has to read the same way wherever its row is drawn, and the MRU switcher shares the
         * PrimarySidebar's status indicator. Compaction is restarted here, at the end, because the switcher only lists
         * the Sessions the user is not on: reaching it needs a second Session and a switch, which discards the
         * ephemeral Terminal progress the workflow above asserts.
         */
        await terminalInput.press('c');
        await expect(tabOperation).toHaveText('Compacting');
        await createAdditionalShellSession(running.page);
        await running.page.keyboard.down('Meta');
        await running.page.keyboard.press('Backquote');
        const switcherRow = running.page
            .getByRole('listbox', { name: 'Recently used Sessions' })
            .locator(`[data-session-id="${sessionId}"] .session-status`);
        await expect(switcherRow).toHaveAttribute('data-session-status', 'running');
        await expect(switcherRow).toHaveAttribute('data-agent-operation', 'compacting');
        await expect(switcherRow).toHaveAccessibleName('Compacting');
        await expect(switcherRow).toHaveAccessibleDescription(
            'The Agent is summarizing earlier context before continuing.',
        );
        await running.page.keyboard.up('Meta');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionId);
        const endpoint = await readFile(
            join(userData, 'e2e-agents', 'codex', 'endpoint-ref'),
            'utf8',
        );
        await promisify(execFile)(
            process.execPath,
            [
                resolve(import.meta.dirname, '../apps/cli/dist/caxri.cjs'),
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
        await expect(running.page.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'SIGINT received',
        );
        await expect(tabOperation).not.toBeVisible();
        const interrupted = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const interruptedTerminal = interrupted.terminals.find(
            (terminal) => terminal.sessionId === sessionId,
        );
        expect(interruptedTerminal).toMatchObject({ lastAgentProcessState: 'running' });
        expect(interruptedTerminal?.agentOperation).toBeUndefined();
        await running.page.screenshot({
            path: testInfo.outputPath('cli-interrupt-clears-compaction.png'),
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
