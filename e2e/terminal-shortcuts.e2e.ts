import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { readSystemClipboardText } from './support/clipboard.ts';
import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    splitTerminalToRight,
    waitForNewTerminalId,
} from './support/helpers.ts';

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

async function removeQuitTestDirectory(path: string): Promise<void> {
    await expect
        .poll(async () => {
            try {
                await rm(path, { recursive: true, force: true });
                return true;
            } catch (error) {
                if (
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    Reflect.get(error, 'code') === 'ENOTEMPTY'
                )
                    return false;
                throw error;
            }
        })
        .toBe(true);
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
        await typeInTerminal(running.page, firstTerminalId, String.raw`printf 'FIRST_MARKER\n'`);
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('FIRST_MARKER');

        await running.page.getByRole('button', { name: 'New Terminal' }).click();
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        await expect(running.page.locator('.terminal-pane')).toHaveCount(2);
        await typeInTerminal(running.page, secondTerminalId, String.raw`printf 'SECOND_MARKER\n'`);
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
        await typeInTerminal(running.page, firstTerminalId, String.raw`printf 'AFTER_CLEAR\n'`);
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

        await running.page.locator('.project-heading').hover();
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
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Codex Terminal maps input shortcuts and restores the clipboard on quit', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-input-shortcuts-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capture = join(testDirectory, 'agent-input.hex');
    const originalClipboardText = await readSystemClipboardText();
    await Promise.all([mkdir(root), writeFile(capture, '')]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                startupOutput: 'FAKE_CODEX_READY\r\n',
                inputCapture: { path: capture, encoding: 'hex', echoPrefix: 'INPUT_HEX:' },
            },
        },
    });

    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
    });
    let isClosed = false;
    try {
        await createProjectSession(running.page, 'codex');
        const input = running.page.locator('.xterm-helper-textarea');
        const rows = running.page.locator('.xterm-rows');
        await expect(rows).toContainText('FAKE_CODEX_READY');
        await input.focus();

        const keybindings = await pageRequest<{
            value: Array<{
                args?: Record<string, unknown>;
                command: string;
                key: string;
                when?: 'terminalFocus';
            }>;
        }>(running.page, 'keybindings.get');
        await pageRequest(running.page, 'keybindings.update', {
            source: JSON.stringify(
                [
                    ...keybindings.value,
                    {
                        args: { text: '\u{1B}[1;3B' },
                        command: 'workbench.action.terminal.sendSequence',
                        key: 'cmd+enter',
                        when: 'terminalFocus',
                    },
                ],
                null,
                2,
            ),
        });
        await running.page.keyboard.press('Meta+,');
        const keybindingsDialog = running.page.getByRole('dialog');
        await keybindingsDialog.getByRole('tab', { name: 'Keybindings', exact: true }).click();
        await keybindingsDialog.getByLabel('Search keyboard shortcuts').fill('send sequence');
        await expect(keybindingsDialog.locator('[data-shortcut="cmd+enter"]')).toBeVisible();
        await running.page.keyboard.press('Escape');
        await input.focus();

        await input.press('Meta+Enter');
        await expect(rows).toContainText('INPUT_HEX:1b5b313b3342');

        await input.press('Shift+Enter');
        await expect(rows).toContainText('INPUT_HEX:1b0d');
        await input.press('Meta+ArrowLeft');
        await expect(rows).toContainText('INPUT_HEX:01');
        expect(await rows.textContent()).not.toContain('INPUT_HEX:1b0dINPUT_HEX:0d');
        await input.press('Meta+ArrowRight');
        await expect(rows).toContainText('INPUT_HEX:05');

        await running.app.evaluate(({ clipboard, nativeImage }) => {
            clipboard.clear();
            const image = nativeImage.createFromBuffer(
                Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                    'base64',
                ),
            );
            if (image.isEmpty()) throw new Error('Image clipboard fixture is empty');
            clipboard.writeImage(image);
        });
        await input.press('Meta+V');
        await expect(rows).toContainText('INPUT_HEX:16');

        await running.app.evaluate(({ clipboard }) => clipboard.writeText('TEXT_PASTE'));
        await input.press('Meta+V');
        await expect(rows).toContainText('INPUT_HEX:544558545f5041535445');

        const closed = running.app.waitForEvent('close');
        try {
            /**
             * Bypass the wrapped Playwright close path to prove Main's `before-quit` guardian restores the clipboard.
             */
            await running.app.evaluate(({ app }) => app.quit());
        } catch {
            // The evaluation transport may close before returning because quitting is the operation under test.
        }
        await closed;
        await running.app.close();
        isClosed = true;
        expect(await readSystemClipboardText()).toBe(originalClipboardText);
    } finally {
        if (!isClosed) {
            try {
                await running.app.close();
            } catch {
                // Ignore close failures during cleanup.
            }
        }
        await removeQuitTestDirectory(testDirectory);
    }
});
