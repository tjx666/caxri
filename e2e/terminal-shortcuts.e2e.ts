import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type Page } from './support/fixtures.ts';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import {
    createProjectSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    splitTerminalToRight,
    waitForNewTerminalId,
} from './support/helpers.ts';

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

        await running.page.getByRole('button', { name: 'New Terminal' }).click();
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
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
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Codex Terminal maps multiline, line-boundary, and image-paste shortcuts', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-input-shortcuts-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capture = join(testDirectory, 'agent-input.hex');
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
    try {
        await createProjectSession(running.page, 'codex');
        const input = running.page.locator('.xterm-helper-textarea');
        const rows = running.page.locator('.xterm-rows');
        await expect(rows).toContainText('FAKE_CODEX_READY');
        await input.focus();

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
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
