import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    openSettingsTab,
    pageRequest,
    revealSettingsSection,
} from './support/helpers.ts';

interface RecoverySettingsSnapshot {
    enabled: boolean;
    patterns: string[];
    settleDelayMs: number;
    continueDelayMs: number;
}

interface RecoveryOutputChunk {
    delayMs: number;
    text: string;
}

const DEFAULT_RECOVERY_OUTPUT: RecoveryOutputChunk[] = [
    { delayMs: 25, text: 'API Error: The response stopped \u{1B}[31marriv' },
    {
        delayMs: 50,
        text: 'ing. The response above may be incomplete.\u{1B}[0m\r\n* Cogitated for 21m 52s',
    },
];

async function claudeRecoverySettings(page: Page): Promise<RecoverySettingsSnapshot> {
    const settings = await pageRequest<{
        value: {
            'agents.providers': { claude: { recovery: RecoverySettingsSnapshot } };
        };
    }>(page, 'settings.get');
    return settings.value['agents.providers'].claude.recovery;
}

async function capturedInputHex(path: string): Promise<string> {
    try {
        return (await readFile(path)).toString('hex');
    } catch {
        return '';
    }
}

function claudeRecoveryFixture(
    inputPath: string,
    outputChunks: readonly RecoveryOutputChunk[] = DEFAULT_RECOVERY_OUTPUT,
): string {
    return String.raw`#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('caxri-fake-claude 1.0.0\n');
  process.exit(0);
}
let input = Buffer.alloc(0);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(${JSON.stringify(inputPath)}, chunk);
  input = Buffer.concat([input, chunk]);
  if (input.equals(Buffer.from('\x1bcontinue\r'))) {
    process.stdout.write('RECOVERY_INPUT_RECEIVED\r\n');
  }
});
process.stdout.write('RECOVERY_FIXTURE_READY\r\n');
const outputChunks = ${JSON.stringify(outputChunks)};
for (const chunk of outputChunks) {
  setTimeout(() => process.stdout.write(chunk.text), chunk.delayMs);
}
`;
}

test('matched parsed Agent output sends delayed Esc and continue when recovery is enabled', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-output-recovery-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const inputPath = join(testDirectory, 'claude-input');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: { executableSource: claudeRecoveryFixture(inputPath) },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const settingsTab = await openSettingsTab(running.page);
        await revealSettingsSection(settingsTab, 'Claude Code');
        await settingsTab
            .getByRole('switch', { name: 'Claude Code network error recovery' })
            .check();
        const patterns = settingsTab.getByLabel('Claude Code additional ending output patterns');
        await patterns.fill(
            'API Error: The response stopped arriving. The response above may be incomplete.',
        );
        await patterns.blur();
        await expect
            .poll(() => claudeRecoverySettings(running.page))
            .toMatchObject({
                patterns: [
                    'API Error: The response stopped arriving. The response above may be incomplete.',
                ],
            });

        const settleDelay = settingsTab.getByLabel('Claude Code Wait before Esc');
        await settleDelay.fill('250');
        await settleDelay.blur();
        await expect
            .poll(() => claudeRecoverySettings(running.page))
            .toMatchObject({
                settleDelayMs: 250,
            });

        const continueDelay = settingsTab.getByLabel('Claude Code Wait before Continue');
        await continueDelay.fill('250');
        await continueDelay.blur();

        await expect
            .poll(() => claudeRecoverySettings(running.page))
            .toEqual({
                enabled: true,
                patterns: [
                    'API Error: The response stopped arriving. The response above may be incomplete.',
                ],
                settleDelayMs: 250,
                continueDelayMs: 250,
            });
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `Cmd+W` closes it
        // outright — there is no "Close" button to click anymore.
        await running.page.keyboard.press('Meta+w');

        await createProjectSession(running.page, 'claude');
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'The response stopped arriving',
        );
        await expect.poll(() => capturedInputHex(inputPath)).toBe('1b636f6e74696e75650d');
        await expect(running.page.locator('.xterm-rows')).toContainText('RECOVERY_INPUT_RECEIVED');
        await expect(
            running.page.getByText(
                'Sent Esc and continue to Claude Code after a matched recovery rule.',
                { exact: true },
            ),
        ).toBeVisible();
        await running.page.getByRole('button', { name: 'Open Settings' }).click();
        await expect(running.page.locator('[data-settings-page]')).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Claude Code capacity stop uses the built-in recovery rule with no custom pattern', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-claude-capacity-recovery-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const inputPath = join(testDirectory, 'claude-input');
    await mkdir(root, { recursive: true });
    const capacityMessage = 'Selected model is at capacity. Please try a different model.';
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: claudeRecoveryFixture(inputPath, [
                    {
                        delayMs: 25,
                        text: '\u{1B}[33m⚠ Selected model is at capa',
                    },
                    {
                        delayMs: 50,
                        text: 'city. Please try a different model.\u{1B}[0m\r\n❯',
                    },
                ]),
            },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const settingsTab = await openSettingsTab(running.page);
        await revealSettingsSection(settingsTab, 'Claude Code');
        await settingsTab
            .getByRole('switch', { name: 'Claude Code network error recovery' })
            .check();
        await expect(
            settingsTab.getByLabel('Claude Code additional ending output patterns'),
        ).toHaveValue('');
        await expect(
            settingsTab.getByText('No additional patterns configured.', { exact: true }),
        ).toBeVisible();

        const settleDelay = settingsTab.getByLabel('Claude Code Wait before Esc');
        await settleDelay.fill('250');
        await settleDelay.blur();
        const continueDelay = settingsTab.getByLabel('Claude Code Wait before Continue');
        await continueDelay.fill('250');
        await continueDelay.blur();
        await expect
            .poll(() => claudeRecoverySettings(running.page))
            .toEqual({
                enabled: true,
                patterns: [],
                settleDelayMs: 250,
                continueDelayMs: 250,
            });
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `Cmd+W` closes it
        // outright — there is no "Close" button to click anymore.
        await running.page.keyboard.press('Meta+w');

        await createProjectSession(running.page, 'claude');
        await expect(running.page.locator('.xterm-rows')).toContainText(capacityMessage);
        await expect.poll(() => capturedInputHex(inputPath)).toBe('1b636f6e74696e75650d');
        await expect(running.page.locator('.xterm-rows')).toContainText('RECOVERY_INPUT_RECEIVED');
        await expect(
            running.page.getByText(
                'Sent Esc and continue to Claude Code after a matched recovery rule.',
                { exact: true },
            ),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
