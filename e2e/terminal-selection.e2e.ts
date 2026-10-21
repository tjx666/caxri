import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { E2EApp as ElectronApp } from './support/electron-app.ts';
import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    splitTerminalToRight,
    waitForNewTerminalId,
} from './support/helpers.ts';
import { openSettingsSection, openSettingsTab } from './support/settings.ts';

interface CharacterBounds {
    height: number;
    width: number;
    x: number;
    y: number;
}

interface TextBounds {
    end: CharacterBounds;
    start: CharacterBounds;
}

async function terminalTextBounds(
    page: Page,
    terminalId: string,
    text: string,
): Promise<TextBounds> {
    return page
        .locator(`.terminal-pane[data-terminal-id="${terminalId}"] .xterm-rows`)
        .evaluate((rows, target) => {
            const rowElements = [...rows.children];
            const renderedText = rowElements.map((row) => row.textContent).join('');
            const targetStart = renderedText.indexOf(target);
            if (targetStart === -1) throw new Error(`Terminal text not found: ${target}`);

            const characterBounds = (targetOffset: number): CharacterBounds => {
                let renderedOffset = 0;
                for (const row of rowElements) {
                    const rowText = row.textContent;
                    if (targetOffset >= renderedOffset + rowText.length) {
                        renderedOffset += rowText.length;
                        continue;
                    }
                    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                        const length = node.textContent?.length ?? 0;
                        if (targetOffset < renderedOffset + length) {
                            const offset = targetOffset - renderedOffset;
                            const range = document.createRange();
                            range.setStart(node, offset);
                            range.setEnd(node, offset + 1);
                            const bounds = range.getBoundingClientRect();
                            return {
                                height: bounds.height,
                                width: bounds.width,
                                x: bounds.x,
                                y: bounds.y,
                            };
                        }
                        renderedOffset += length;
                    }
                }
                throw new Error(`Terminal text bounds not found: ${target}`);
            };

            return {
                end: characterBounds(targetStart + target.length - 1),
                start: characterBounds(targetStart),
            };
        }, text);
}

async function selectTerminalText(
    page: Page,
    terminalId: string,
    firstLine: string,
    lastLine: string,
): Promise<void> {
    const start = await terminalTextBounds(page, terminalId, firstLine);
    const end = await terminalTextBounds(page, terminalId, lastLine);
    await page.mouse.move(start.start.x + 2, start.start.y + start.start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.end.x + end.end.width - 2, end.end.y + end.end.height / 2, {
        steps: 8,
    });
    await page.mouse.up();
}

async function typeInTerminal(page: Page, terminalId: string, command: string): Promise<void> {
    const input = page.locator(
        `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`,
    );
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

async function terminalIds(page: Page): Promise<string[]> {
    const bootstrap = await pageRequest<{ terminals: Array<{ id: string }> }>(
        page,
        'app.bootstrap',
    );
    return bootstrap.terminals.map((terminal) => terminal.id);
}

async function terminalCopyMenuItem(
    app: ElectronApp,
): Promise<{ accelerator: string | null; label: string } | undefined> {
    return app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('command.terminal.copy');
        return item ? { accelerator: item.accelerator, label: item.label } : undefined;
    });
}

async function clickTerminalCopyMenuItem(app: ElectronApp): Promise<void> {
    await app.evaluate(({ BrowserWindow, Menu }) => {
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const item = Menu.getApplicationMenu()?.getMenuItemById('command.terminal.copy');
        if (!item) {
            throw new Error('Terminal copy menu item is unavailable');
        }
        const click = item.click as (...arguments_: unknown[]) => void;
        click(item, window, { triggeredByAccelerator: false });
    });
}

test('Cmd+C copies the focused Editor or Terminal selection across split panes', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-selection-e2e-'));
    const isCiParity = process.env.CAXRI_CI_PARITY_CASE === 'long-path-wrapped-terminal';
    const longPath = isCiParity
        ? join(
              'ci-parity-path-segment-0123456789',
              'another-long-path-segment-0123456789',
              'final-long-path-segment-0123456789',
          )
        : '';
    const userData = join(testDirectory, longPath, 'user-data');
    const root = join(testDirectory, longPath, 'project');
    const multilineOutput = join(testDirectory, 'multiline-output.sh');
    const splitOutput = join(testDirectory, 'split-output.sh');
    const splitText = 'PANE_TWO';
    const editorCopyText = 'EDITOR_COPY_TARGET';
    const firstLine = isCiParity ? `FIRST Ω 中 ${'wrapped-content-'.repeat(16)}END` : 'FIRST Ω 中';
    const lastLine = 'SECOND  spaced text';
    await mkdir(root, { recursive: true });
    await Promise.all([
        writeFile(multilineOutput, `#!/bin/sh\nprintf '${firstLine}\\n${lastLine}\\n'\n`),
        writeFile(splitOutput, `#!/bin/sh\nprintf '${splitText}\\n'\n`),
        writeFile(join(root, 'editor-copy.ts'), editorCopyText),
    ]);
    await Promise.all([chmod(multilineOutput, 0o700), chmod(splitOutput, 0o700)]);

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
    });
    let isClosed = false;
    try {
        await expect
            .poll(() => terminalCopyMenuItem(running.app))
            .toEqual({
                accelerator: null,
                label: 'Copy Selection [⌘C]',
            });
        if (isCiParity) {
            await running.app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0]?.setBounds({ width: 720, height: 640 }),
            );
        }
        await createShellSession(running.page);
        const firstTerminalId = (await terminalIds(running.page))[0];
        await typeInTerminal(running.page, firstTerminalId, multilineOutput);
        const firstRows = running.page.locator(
            `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
        );
        await expect(firstRows).toContainText(firstLine);
        await expect(firstRows).toContainText(lastLine);
        if (isCiParity) {
            const wrappedBounds = await terminalTextBounds(
                running.page,
                firstTerminalId,
                firstLine,
            );
            expect(wrappedBounds.end.y).toBeGreaterThan(wrappedBounds.start.y);
        }
        await running.clipboard.writeText('BEFORE_SELECTION');
        await selectTerminalText(running.page, firstTerminalId, firstLine, lastLine);
        await expect
            .poll(() => running.clipboard.textEquals(`${firstLine}\n${lastLine}`))
            .toBe(true);
        await running.clipboard.claimText(`${firstLine}\n${lastLine}`);

        await running.clipboard.writeText('KEEP_ON_EMPTY');
        const firstBounds = await terminalTextBounds(running.page, firstTerminalId, firstLine);
        await running.page.mouse.click(
            firstBounds.start.x + 2,
            firstBounds.start.y + firstBounds.start.height / 2,
        );
        const firstInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-helper-textarea`,
        );
        await firstInput.focus();
        await firstInput.press('Meta+C');
        await expect.poll(() => running.clipboard.textEquals('KEEP_ON_EMPTY')).toBe(true);

        /**
         * SearchAddon represents its active match as a Terminal selection, so copy-on-select must skip exactly that
         * navigation, and nothing else. An open search bar is not a reason to stop copying a mouse selection, which is
         * what a guard keyed on "is the search bar open" would do.
         */
        await running.clipboard.writeText('SEARCH_NAVIGATION_SENTINEL');
        await firstInput.press('Meta+F');
        const search = running.page.getByRole('search', { name: 'Terminal buffer search' });
        const searchInput = search.getByRole('textbox', { name: 'Find in Terminal' });
        await expect(searchInput).toBeFocused();
        await searchInput.fill('SECOND');
        await expect(search).toContainText('1/1');
        expect(await running.clipboard.textEquals('SEARCH_NAVIGATION_SENTINEL')).toBe(true);
        await selectTerminalText(running.page, firstTerminalId, lastLine, lastLine);
        await expect.poll(() => running.clipboard.textEquals(lastLine)).toBe(true);
        await running.clipboard.claimText(lastLine);
        /**
         * The addon also re-runs its cached query by itself shortly after every Terminal write, which is the path a
         * guard wrapped around this pane's own navigation calls would miss. Typing a second match forces that re-search
         * while the user's selection is the one thing the clipboard must keep.
         */
        await firstInput.focus();
        await firstInput.pressSequentially('# SECOND_AGAIN');
        await expect(search).toContainText('/2');
        expect(await running.clipboard.textEquals(lastLine)).toBe(true);
        await searchInput.focus();
        await searchInput.press('Escape');
        await expect(search).toHaveCount(0);

        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        await typeInTerminal(running.page, secondTerminalId, splitOutput);
        const secondRows = running.page.locator(
            `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-rows`,
        );
        await expect(secondRows).toContainText(splitText);
        await selectTerminalText(running.page, secondTerminalId, splitText, splitText);
        await expect.poll(() => running.clipboard.textEquals(splitText)).toBe(true);
        await running.clipboard.claimText(splitText);

        const secondInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-helper-textarea`,
        );
        /**
         * `terminal.copy` (Cmd+C) is a distinct affordance from copy-on-select, and this proves it without touching
         * `terminal.copyOnSelect`: turning that setting off would race the `settings.changed` broadcast the Renderer
         * needs before `use-terminal-pane` stops copying. Instead, reuse the selection copy-on-select just proved live
         * and overwrite the clipboard underneath it. Copy-on-select only reacts to a selection _change_, so nothing can
         * restore the text except the command under test.
         *
         * Deliberately before the paste case below rather than after it: a second drag would have to re-measure
         * `PANE_TWO`'s bounds against a viewport the pasted command is still scrolling, so the mouse could land a row
         * off and select nothing at all.
         */
        await running.clipboard.writeText('COPY_COMMAND_SENTINEL');
        await secondInput.focus();
        expect(await running.clipboard.textEquals('COPY_COMMAND_SENTINEL')).toBe(true);
        await secondInput.focus();
        await expect(secondInput).toBeFocused();
        await secondInput.press('Meta+C');
        await expect.poll(() => running.clipboard.textEquals(splitText)).toBe(true);
        await running.clipboard.claimText(splitText);

        await running.page.getByRole('treeitem', { name: 'editor-copy.ts', exact: true }).click();
        const editor = running.page.locator('.monaco-editor').first();
        await expect(editor).toBeVisible();
        /**
         * The 720px parity window leaves only about 104px of Editor visible beside the open Secondary Sidebar.
         */
        await editor.click({ position: { x: 20, y: 24 } });
        await running.clipboard.writeText('EDITOR_COPY_SENTINEL');
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.press('Meta+C');
        await expect.poll(() => running.clipboard.textEquals(editorCopyText)).toBe(true);
        await running.clipboard.claimText(editorCopyText);

        /**
         * An ordinary input is the fourth focus surface in the #264 priority contract. A background Terminal selection
         * must not replace the input's selected text when the user presses Cmd+C.
         */
        const settingsTab = await openSettingsTab(running.page);
        const settingsSearch = settingsTab.getByLabel('Search settings');
        const inputCopyText = 'INPUT_COPY_TARGET';
        await settingsSearch.fill(inputCopyText);
        await settingsSearch.press('Meta+A');
        await running.clipboard.writeText('INPUT_COPY_SENTINEL');
        await settingsSearch.press('Meta+C');
        await expect.poll(() => running.clipboard.textEquals(inputCopyText)).toBe(true);
        await running.clipboard.claimText(inputCopyText);
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `Cmd+W` closes it
        // outright, the tab-appropriate replacement for the old "Escape to dismiss the dialog" step.
        await running.page.keyboard.press('Meta+w');
        await expect(settingsTab).toHaveCount(0);

        const keybindings = await pageRequest<{
            value: Array<{ command: string; key: string; when?: 'terminalFocus' }>;
        }>(running.page, 'keybindings.get');
        const customCopyKeybindings = keybindings.value.map((binding) =>
            binding.command === 'terminal.copy' ? { ...binding, key: 'cmd+shift+c' } : binding,
        );
        await pageRequest(running.page, 'keybindings.update', {
            source: JSON.stringify(customCopyKeybindings, null, 2),
        });
        await expect
            .poll(() => terminalCopyMenuItem(running.app))
            .toEqual({
                accelerator: null,
                label: 'Copy Selection [⇧⌘C]',
            });

        const keybindingsTab = await openSettingsTab(running.page);
        await openSettingsSection(keybindingsTab, 'Keybindings');
        const keybindingsSearch = keybindingsTab.getByLabel('Search keyboard shortcuts');
        await keybindingsSearch.fill('terminal.copy');
        await expect(keybindingsTab.locator('[data-shortcut="cmd+shift+c"]')).toBeVisible();
        await keybindingsSearch.press('Meta+A');
        await running.clipboard.writeText('REBIND_INPUT_COPY_SENTINEL');
        await keybindingsSearch.press('Meta+C');
        await expect.poll(() => running.clipboard.textEquals('terminal.copy')).toBe(true);
        await running.clipboard.claimText('terminal.copy');
        await running.page.keyboard.press('Meta+w');
        await expect(keybindingsTab).toHaveCount(0);

        await running.page
            .locator(`.work-tab[data-terminal-id="${secondTerminalId}"] [role="tab"]`)
            .click();
        await expect(secondRows).toContainText(splitText);
        await selectTerminalText(running.page, secondTerminalId, splitText, splitText);
        await expect.poll(() => running.clipboard.textEquals(splitText)).toBe(true);
        await running.clipboard.claimText(splitText);
        await running.clipboard.writeText('CUSTOM_COPY_COMMAND_SENTINEL');
        await secondInput.focus();
        await secondInput.press('Meta+Shift+C');
        await expect.poll(() => running.clipboard.textEquals(splitText)).toBe(true);
        await running.clipboard.claimText(splitText);

        /**
         * Invoke the built application menu item separately from its displayed label and keyboard route. The acceptance
         * pass covers the physical macOS menu click; this assertion keeps the Main-to-Renderer command dispatch and
         * focused Terminal clipboard behavior under deterministic Electron regression coverage.
         */
        await running.clipboard.writeText('NATIVE_TERMINAL_MENU_COPY_SENTINEL');
        await secondInput.focus();
        await clickTerminalCopyMenuItem(running.app);
        await expect.poll(() => running.clipboard.textEquals(splitText)).toBe(true);
        await running.clipboard.claimText(splitText);

        await pageRequest(running.page, 'keybindings.update', {
            source: JSON.stringify(
                customCopyKeybindings.filter((binding) => binding.command !== 'terminal.copy'),
                null,
                2,
            ),
        });
        await expect
            .poll(() => terminalCopyMenuItem(running.app))
            .toEqual({
                accelerator: null,
                label: 'Copy Selection',
            });

        await running.clipboard.writeText(String.raw`printf 'PASTE_STILL_WORKS\n'`);
        await running.page
            .locator(`.work-tab[data-terminal-id="${secondTerminalId}"] [role="tab"]`)
            .click();
        await secondInput.focus();
        await secondInput.press('Meta+V');
        await secondInput.press('Enter');
        await expect(secondRows).toContainText('PASTE_STILL_WORKS');

        await running.app.close();
        isClosed = true;
        expect(await running.clipboard.restoreOutcome()).toMatchObject({ status: 'restored' });
    } finally {
        if (!isClosed) {
            try {
                await running.app.close();
            } catch {
                // Ignore close failures during cleanup.
            }
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
