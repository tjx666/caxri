import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    waitForNewTerminalId,
} from './support/helpers.ts';

async function capturedInput(path: string): Promise<string> {
    try {
        return (await readFile(path, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((hex) => Buffer.from(hex, 'hex').toString('utf8'))
            .join('');
    } catch {
        return '';
    }
}

test('Agent Actions discovers skills, preserves drafts, runs explicitly, and supports Settings overrides', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-actions-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const skillDirectory = join(root, '.agents', 'skills', 'e2e-action');
    const capture = join(testDirectory, 'agent-input.hex');
    await Promise.all([mkdir(skillDirectory, { recursive: true }), writeFile(capture, '')]);
    await writeFile(
        join(skillDirectory, 'SKILL.md'),
        '---\nname: e2e-action\ndescription: E2E discovered action\n---\nNever exposed in picker metadata.\n',
    );
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                startupOutput: 'AGENT_ACTIONS_READY\r\n',
                inputCapture: { path: capture, encoding: 'hex', echoPrefix: 'ACTION_INPUT:' },
            },
        },
    });

    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page, 'codex');
        const state = await pageRequest<{
            terminals: Array<{ id: string; provider?: string; lastProcessState: string }>;
        }>(running.page, 'app.bootstrap');
        const agentTerminal = state.terminals.find((terminal) => terminal.provider === 'codex');
        if (!agentTerminal) throw new Error('Codex Terminal was not created');
        const input = running.page.locator(
            `.terminal-pane[data-terminal-id="${agentTerminal.id}"] .xterm-helper-textarea`,
        );
        await expect(running.page.locator('.xterm-rows')).toContainText('AGENT_ACTIONS_READY');
        await input.focus();
        await input.pressSequentially('draft-');
        await running.page.keyboard.press('Meta+Shift+A');

        let picker = running.page.locator('[data-agent-actions-picker]');
        await expect(picker).toBeVisible();
        await expect(picker).toHaveAttribute('data-target-terminal-id', agentTerminal.id);
        await expect(picker).toContainText('Codex');
        await expect(picker).toContainText('/status');
        const search = picker.getByPlaceholder('Search skills and slash commands…');
        await search.fill('e2e action');
        await expect(picker.locator('[data-agent-action="$e2e-action"]')).toContainText(
            'E2E discovered action',
        );
        await search.press('Enter');
        await expect(picker).not.toBeVisible();
        await expect.poll(() => capturedInput(capture)).toContain('draft-$e2e-action ');
        await running.page.keyboard.type('argument');
        await expect.poll(() => capturedInput(capture)).toContain('draft-$e2e-action argument');
        expect(await capturedInput(capture)).not.toContain('draft-$e2e-action \r');

        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect(picker).toBeVisible();
        await picker.getByPlaceholder('Search skills and slash commands…').fill('status');
        await expect(picker.locator('[data-agent-action="/status"]')).toBeVisible();
        await running.page.keyboard.press('Meta+Enter');
        await expect(picker).not.toBeVisible();
        await expect.poll(() => capturedInput(capture)).toContain('/status\r');

        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await picker.getByRole('button', { name: 'Manage in Settings…' }).click();
        await expect(picker).not.toBeVisible();
        const settingsDialog = running.page.getByRole('dialog');
        const actionsRow = settingsDialog.locator('[data-setting-row="agents.codex.actions"]');
        await expect(actionsRow).toBeVisible();
        await actionsRow.getByLabel('New agent action invocation').fill('/goal');
        await actionsRow
            .getByLabel('New agent action description')
            .fill('Manage a long-running goal');
        await actionsRow.getByRole('button', { name: 'Add agent action' }).click();
        await expect(actionsRow.getByLabel('Description for /goal')).toHaveValue(
            'Manage a long-running goal',
        );
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            codex: { actions: { items: Record<string, unknown> } };
                        };
                    };
                }>(running.page, 'settings.get');
                return Object.hasOwn(
                    settings.value['agents.providers'].codex.actions.items,
                    '/goal',
                );
            })
            .toBe(true);
        await settingsDialog.getByRole('button', { name: 'Close' }).click();

        await input.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await picker.getByPlaceholder('Search skills and slash commands…').fill('goal');
        await expect(picker.locator('[data-agent-action="/goal"]')).toContainText(
            'Manage a long-running goal',
        );
        await running.page.keyboard.press('Escape');
        await expect(picker).not.toBeVisible();
        await expect(input).toBeFocused();
        await running.page.keyboard.type('-after-escape');
        await expect.poll(() => capturedInput(capture)).toContain('-after-escape');

        await running.page.getByRole('button', { name: 'New Terminal' }).click();
        const shellTerminalId = await waitForNewTerminalId(running.page, [agentTerminal.id]);
        const shellInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${shellTerminalId}"] .xterm-helper-textarea`,
        );
        await shellInput.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        await expect(running.page.locator('[data-agent-actions-picker]')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
