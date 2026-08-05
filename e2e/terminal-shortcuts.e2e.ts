import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type Page } from '@playwright/test';

import { createShellSession, launchCaxri, pageRequest } from './helpers.ts';

const execFileAsync = promisify(execFile);

async function typeInTerminal(page: Page, terminalId: string, command: string): Promise<void> {
    const input = page.locator(
        `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`,
    );
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

async function terminalIds(page: Page): Promise<string[]> {
    const state = await pageRequest<{ terminals: Array<{ id: string }> }>(page, 'app.bootstrap');
    return state.terminals.map((terminal) => terminal.id);
}

test('Command+K/T/W affect only the active Terminal and pause behind modals', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-shortcuts-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const firstTerminalId = (await terminalIds(running.page))[0];
        await typeInTerminal(running.page, firstTerminalId, "printf 'FIRST_MARKER\\n'");
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('FIRST_MARKER');

        await running.page.getByTitle('Split Terminal').click();
        const secondTerminalId = (await terminalIds(running.page)).find(
            (terminalId) => terminalId !== firstTerminalId,
        )!;
        await typeInTerminal(running.page, secondTerminalId, "printf 'SECOND_MARKER\\n'");
        await running.page
            .locator(`.work-tab[data-terminal-id="${firstTerminalId}"] [role="tab"]`)
            .click();
        await running.page.keyboard.press('Meta+K');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).not.toContainText('FIRST_MARKER');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('SECOND_MARKER');
        await typeInTerminal(running.page, firstTerminalId, "printf 'AFTER_CLEAR\\n'");
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('AFTER_CLEAR');

        await running.page.keyboard.press('Meta+T');
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(3);
        await expect(running.page.locator('.work-tab.active')).toHaveAttribute(
            'data-terminal-id',
            /.+/,
        );
        await running.page.keyboard.press('Meta+W');
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);

        await running.page.getByRole('button', { name: /^New Session in / }).click();
        const dialog = running.page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await running.page.keyboard.press('Meta+K');
        await running.page.keyboard.press('Meta+T');
        await running.page.keyboard.press('Meta+W');
        await expect(dialog).toBeVisible();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        await running.page.keyboard.press('Escape');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('AFTER_CLEAR');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
