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
    pageRequest,
    revealSettingsSection,
} from './support/helpers.ts';

interface RecoverySettingsSnapshot {
    enabled: boolean;
    patterns: string[];
    settleDelayMs: number;
    continueDelayMs: number;
}

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

function claudeRecoveryFixture(inputPath: string): string {
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
setTimeout(() => process.stdout.write('API Error: The response stopped \x1b[31marriv'), 25);
setTimeout(() => process.stdout.write('ing. The response above may be incomplete.\x1b[0m\r\n* Cogitated for 21m 52s'), 50);
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
        await running.page.keyboard.press('Meta+,');
        const dialog = running.page.getByRole('dialog');
        await revealSettingsSection(dialog, 'Claude Code');
        await dialog.getByRole('switch', { name: 'Claude Code network error recovery' }).check();
        const patterns = dialog.getByLabel('Claude Code ending output patterns');
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

        const settleDelay = dialog.getByLabel('Claude Code Wait before Esc');
        await settleDelay.fill('250');
        await settleDelay.blur();
        await expect
            .poll(() => claudeRecoverySettings(running.page))
            .toMatchObject({
                settleDelayMs: 250,
            });

        const continueDelay = dialog.getByLabel('Claude Code Wait before Continue');
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
        await dialog.getByRole('button', { name: 'Close' }).click();

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
        await expect(running.page.getByRole('dialog')).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
