import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from './fixtures.ts';
import type { MessageBoxOptions } from 'electron';

import { createShellSession, launchCaxri, typeTerminal } from './helpers.ts';

async function terminalTextBounds(page: Page, text: string) {
    const row = page.locator('.xterm-rows > div').filter({ hasText: text }).last();
    await expect(row).toContainText(text);
    return row.evaluate((element, target) => {
        const rowText = element.textContent ?? '';
        const targetStart = rowText.indexOf(target);
        const targetEnd = targetStart + target.length;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let offset = 0;
        let start: { node: Node; offset: number } | undefined;
        let end: { node: Node; offset: number } | undefined;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const length = node.textContent?.length ?? 0;
            if (!start && targetStart >= offset && targetStart <= offset + length)
                start = { node, offset: targetStart - offset };
            if (targetEnd >= offset && targetEnd <= offset + length) {
                end = { node, offset: targetEnd - offset };
                break;
            }
            offset += length;
        }
        if (!start || !end) throw new Error(`Terminal text bounds not found: ${target}`);
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        const bounds = range.getBoundingClientRect();
        return {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        };
    }, text);
}

async function clickTerminalText(page: Page, text: string): Promise<void> {
    const bounds = await terminalTextBounds(page, text);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.waitForTimeout(50);
    await page.keyboard.down('Meta');
    try {
        await page.mouse.click(x, y);
    } finally {
        await page.keyboard.up('Meta');
    }
}

test('Terminal links open Project files and confirm URLs through Main', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-links-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const file = join(root, 'link-target.ts');
    await mkdir(root);
    await writeFile(file, 'first line\nsecond line\nthird line\n');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const fileLink = `${file}:2:3`;
        await typeTerminal(running.page, `printf '%s\\n' '${fileLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(fileLink);
        await clickTerminalText(running.page, fileLink);

        await expect(running.page.getByRole('tab', { name: 'link-target.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 2, Col 3/)).toBeVisible();

        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & {
                caxriExternalLinkProbe?: { confirmations: string[]; opened: string[] };
            };
            target.caxriExternalLinkProbe = { confirmations: [], opened: [] };
            dialog.showMessageBox = ((options: MessageBoxOptions) => {
                target.caxriExternalLinkProbe!.confirmations.push(options.message);
                return Promise.resolve({ response: 0, checkboxChecked: false });
            }) as typeof dialog.showMessageBox;
            shell.openExternal = (url) => {
                target.caxriExternalLinkProbe!.opened.push(url);
                return Promise.resolve();
            };
        });
        await running.page.evaluate(() => window.open('file:///tmp/caxri-denied-link'));
        const url = 'https://example.com/caxri-link';
        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await typeTerminal(running.page, `printf '%s\\n' '${url}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(url);
        await clickTerminalText(running.page, url);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriExternalLinkProbe?: { confirmations: string[]; opened: string[] };
                    };
                    return target.caxriExternalLinkProbe?.opened;
                }),
            )
            .toContain(url);
        await expect(
            running.app.evaluate(() => {
                const target = globalThis as typeof globalThis & {
                    caxriExternalLinkProbe?: { confirmations: string[]; opened: string[] };
                };
                return target.caxriExternalLinkProbe;
            }),
        ).resolves.toEqual({
            confirmations: ['Open example.com in your default browser?'],
            opened: [url],
        });
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
