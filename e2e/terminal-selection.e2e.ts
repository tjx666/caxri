import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from './fixtures.ts';

import {
    createShellSession,
    launchCaxri,
    pageRequest,
    splitTerminalToRight,
    waitForNewTerminalId,
} from './helpers.ts';

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
            const renderedText = rowElements.map((row) => row.textContent ?? '').join('');
            const targetStart = renderedText.indexOf(target);
            if (targetStart < 0) throw new Error(`Terminal text not found: ${target}`);

            const characterBounds = (targetOffset: number): CharacterBounds => {
                let renderedOffset = 0;
                for (const row of rowElements) {
                    const rowText = row.textContent ?? '';
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

test('Terminal selection copies exact text and stays isolated across split panes', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-selection-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const multilineOutput = join(testDirectory, 'multiline-output.sh');
    const splitOutput = join(testDirectory, 'split-output.sh');
    const splitText = 'PANE_TWO';
    await mkdir(root);
    await Promise.all([
        writeFile(multilineOutput, "#!/bin/sh\nprintf 'FIRST Ω 中\\nSECOND  spaced text\\n'\n"),
        writeFile(splitOutput, `#!/bin/sh\nprintf '${splitText}\\n'\n`),
    ]);
    await Promise.all([chmod(multilineOutput, 0o700), chmod(splitOutput, 0o700)]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const firstTerminalId = (await terminalIds(running.page))[0];
        await typeInTerminal(running.page, firstTerminalId, multilineOutput);
        const firstRows = running.page.locator(
            `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
        );
        await expect(firstRows).toContainText('FIRST Ω 中');
        await expect(firstRows).toContainText('SECOND  spaced text');
        await running.app.evaluate(({ clipboard }) => clipboard.writeText('BEFORE_SELECTION'));
        await selectTerminalText(
            running.page,
            firstTerminalId,
            'FIRST Ω 中',
            'SECOND  spaced text',
        );
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText()))
            .toBe('FIRST Ω 中\nSECOND  spaced text');

        await running.app.evaluate(({ clipboard }) => clipboard.writeText('KEEP_ON_EMPTY'));
        const firstBounds = await terminalTextBounds(running.page, firstTerminalId, 'FIRST Ω 中');
        await running.page.mouse.click(
            firstBounds.start.x + 2,
            firstBounds.start.y + firstBounds.start.height / 2,
        );
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText()))
            .toBe('KEEP_ON_EMPTY');

        await running.page.getByRole('button', { name: 'New Terminal' }).click();
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        await typeInTerminal(running.page, secondTerminalId, splitOutput);
        const secondRows = running.page.locator(
            `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-rows`,
        );
        await expect(secondRows).toContainText(splitText);
        await selectTerminalText(running.page, secondTerminalId, splitText, splitText);
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText()))
            .toBe(splitText);

        await running.app.evaluate(({ clipboard }) =>
            clipboard.writeText("printf 'PASTE_STILL_WORKS\\n'"),
        );
        const secondInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-helper-textarea`,
        );
        await secondInput.focus();
        await secondInput.press('Meta+V');
        await secondInput.press('Enter');
        await expect(secondRows).toContainText('PASTE_STILL_WORKS');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
