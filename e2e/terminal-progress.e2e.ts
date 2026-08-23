import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    selectedSessionId,
    sessionCard,
    typeTerminal,
    waitForNewTerminalId,
} from './support/helpers.ts';

function oscProgress(state: number, value?: number | string): string {
    return String.raw`printf '\033]9;4;${state};${value ?? ''}\007'`;
}

test('OSC 9;4 progress is coalesced, isolated, ephemeral, and independent from process state', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-progress-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        const firstTab = running.page.locator('.work-tab.active[data-terminal-id]');
        const firstTerminalId = await firstTab.getAttribute('data-terminal-id');
        if (!firstTerminalId) throw new Error('First Terminal ID was not rendered');

        await typeTerminal(
            running.page,
            String.raw`for value in {1..120}; do printf '\033]9;4;1;%d\007' "$value"; done`,
        );
        await expect(firstTab.getByLabel('Terminal progress: 100 percent')).toBeVisible();
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveAccessibleName(
            'Terminal progress: 100 percent',
        );
        await expect(firstTab.locator('.process-running')).toBeVisible();

        await typeTerminal(running.page, oscProgress(1, 'invalid'));
        await expect(firstTab.getByLabel('Terminal progress: 100 percent')).toBeVisible();

        await createAdditionalShellSession(running.page);
        const switchedSessionId = await selectedSessionId(running.page);
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveCount(0);
        await sessionCard(running.page, firstSessionId).click();
        await expect(sessionCard(running.page, firstSessionId)).toHaveClass(/active/);
        await expect(firstTab.locator('.terminal-progress-tab')).toHaveCount(0);

        await running.page.reload();
        await expect(running.page.locator('.terminal-surface .xterm')).toBeVisible();
        await expect(running.page.locator('.terminal-progress-tab')).toHaveCount(0);
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveCount(0);

        await typeTerminal(running.page, oscProgress(2, 44));
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveAccessibleName(
            'Terminal progress: error at 44 percent',
        );
        await typeTerminal(running.page, oscProgress(4, 55));
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveAccessibleName(
            'Terminal progress: paused at 55 percent',
        );
        await typeTerminal(running.page, oscProgress(3));
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveAccessibleName(
            'Terminal progress: in progress',
        );
        await typeTerminal(running.page, oscProgress(1, 33));
        /**
         * Inactive tabs dispose their xterm pane and stop parsing OSC 9;4, so the final progress update must become
         * observable before creating and selecting the next Terminal.
         */
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveAccessibleName(
            'Terminal progress: 33 percent',
        );

        const existingTerminalIds = (
            await pageRequest<{ terminals: Array<{ id: string }> }>(running.page, 'app.bootstrap')
        ).terminals.map((terminal) => terminal.id);
        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, existingTerminalIds);
        const firstInactiveTab = running.page.locator(
            `.work-tab[data-terminal-id="${firstTerminalId}"]`,
        );
        const secondTab = running.page.locator(
            `.work-tab.active[data-terminal-id="${secondTerminalId}"]`,
        );
        await expect(firstInactiveTab.getByLabel('Terminal progress: 33 percent')).toBeVisible();
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveCount(0);

        await typeTerminal(running.page, oscProgress(1, 65));
        await expect(secondTab.getByLabel('Terminal progress: 65 percent')).toBeVisible();
        await expect(firstInactiveTab.getByLabel('Terminal progress: 33 percent')).toBeVisible();
        await expect(secondTab.locator('.process-running')).toBeVisible();

        await typeTerminal(running.page, 'exit');
        await expect(running.page.locator('[data-terminal-exit-state="stopped"]')).toBeVisible();
        await expect(secondTab.locator('.terminal-progress-tab')).toHaveCount(0);
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveCount(0);

        await firstInactiveTab.getByRole('tab').click();
        const firstTerminalInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-helper-textarea`,
        );
        await expect(firstTerminalInput).toBeFocused();
        await firstTerminalInput.pressSequentially(oscProgress(0, 99));
        await firstTerminalInput.press('Enter');
        await expect(firstInactiveTab.locator('.terminal-progress-tab')).toHaveCount(0);
        await typeTerminal(running.page, oscProgress(1, 70));
        await expect(firstInactiveTab.getByLabel('Terminal progress: 70 percent')).toBeVisible();
        await firstInactiveTab.hover();
        await firstInactiveTab.getByRole('button', { name: 'Close Terminal' }).click();
        await expect(firstInactiveTab).toHaveCount(0);
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveCount(0);

        await createAdditionalShellSession(running.page);
        const deletedSessionId = await selectedSessionId(running.page);
        expect(deletedSessionId).not.toBe(switchedSessionId);
        await typeTerminal(running.page, oscProgress(1, 22));
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveAccessibleName(
            'Terminal progress: 22 percent',
        );
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Delete Session', { exact: true }).click();
        await expect(sessionCard(running.page, deletedSessionId)).toHaveCount(0);
        await expect(running.page.locator('.statusbar-terminal-progress')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
