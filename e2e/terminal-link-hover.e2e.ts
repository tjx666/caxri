import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    hoverTerminalLink,
    launchCaxri,
    terminalTextBounds,
    typeTerminal,
} from './support/helpers.ts';

test('Terminal links delay contextual hover hints and reserve the pointer cursor for Cmd', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-link-hover-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const sourceDirectory = join(root, 'src');
    const wrappedSegments = Array.from(
        { length: 24 },
        (_, index) => `segment-${index.toString().padStart(2, '0')}`,
    );
    const wrappedSourceDirectory = join(root, ...wrappedSegments);
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(wrappedSourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'example.ts'), 'first\nsecond\n');
    await writeFile(join(wrappedSourceDirectory, 'wrapped-example.ts'), 'first\nsecond\n');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const fileLink = 'src/example.ts:2';
        const wrappedFileLink = `${wrappedSegments.join('/')}/wrapped-example.ts:2`;
        const wrappedFirstFragment = `${wrappedSegments[0]}/${wrappedSegments[1]}`;
        const wrappedLastFragment = `${wrappedSegments.at(-1)}/wrapped-example.ts:2`;
        const slashSeparatedProse = '账单/配置状态给了陌生人。';
        const url = 'https://example.com/hover-link';
        const urlLine = `${url}(覆盖 6/6 checks)。`;
        const oscBrowserLabel = 'OSC browser';
        const oscEditorLabel = 'OSC editor';
        const oscFileUrl = pathToFileURL(join(sourceDirectory, 'example.ts')).href;
        await typeTerminal(
            running.page,
            String.raw`printf '%s\n' '${fileLink}' '${wrappedFileLink}' '${slashSeparatedProse}' '${urlLine}'; printf '\033]8;;https://example.com/osc-link\007${oscBrowserLabel}\033]8;;\007\n'; printf '\033]8;;${oscFileUrl}\007${oscEditorLabel}\033]8;;\007\n'`,
        );
        await expect(running.page.locator('.xterm-rows')).toContainText(urlLine);
        await expect(running.page.locator('.terminal-command-status')).toHaveText(
            'Command completed successfully.',
        );

        const fileBounds = await hoverTerminalLink(running.page, fileLink);
        const hint = running.page.locator('.terminal-link-hint');
        await expect(hint).toHaveCount(0);
        await expect(hint).toHaveText('⌘ click to open in editor');
        const fileHintBounds = await hint.boundingBox();
        if (!fileHintBounds) throw new Error('Terminal file-link hint bounds are unavailable');
        expect(fileHintBounds.y + fileHintBounds.height).toBeLessThanOrEqual(fileBounds.y);
        const wrappedFirstBounds = await hoverTerminalLink(running.page, wrappedFirstFragment);
        await expect(hint).toHaveText('⌘ click to open in editor');
        await hint.evaluate((element) => {
            element.dataset.e2eStableLinkHint = 'true';
        });
        const wrappedLastBounds = await terminalTextBounds(running.page, wrappedLastFragment);
        if (!wrappedLastBounds) throw new Error('Wrapped Terminal file-link row was not found');
        expect(wrappedLastBounds.y).toBeGreaterThan(wrappedFirstBounds.y);
        /**
         * `wrappedFileLink` itself spans the same soft wrap `wrappedFirstFragment`/`wrappedLastFragment` sit on either
         * side of. Searching for the whole, unsplit string exercises `terminalTextBounds` joining consecutive rows into
         * one logical line instead of only ever matching a fragment confined to a single row, the gap that let a real,
         * longer wrapped path (an absolute temp-directory file link, for example) go unfound in CI while the same case
         * always passed locally against a narrower path that happened to fit on one row
         * (github.com/tjx666/caxri/issues/1418).
         */
        const wrappedFullBounds = await terminalTextBounds(running.page, wrappedFileLink);
        if (!wrappedFullBounds)
            throw new Error(
                'Terminal text bounds must locate a link that spans a soft wrap, not just a one-row fragment of it',
            );
        expect(wrappedFullBounds.y).toBeGreaterThanOrEqual(wrappedFirstBounds.y);
        expect(wrappedFullBounds.y).toBeLessThanOrEqual(wrappedLastBounds.y);
        await running.page.mouse.move(
            wrappedLastBounds.x + wrappedLastBounds.width / 2,
            wrappedLastBounds.y + wrappedLastBounds.height / 2,
        );
        expect(await hint.count()).toBe(1);
        expect(await hint.getAttribute('data-e2e-stable-link-hint')).toBe('true');

        await running.page.keyboard.down('Meta');
        await expect(running.page.locator('.xterm-cursor-pointer')).toBeVisible();
        await running.page.keyboard.up('Meta');
        await expect(running.page.locator('.xterm-cursor-pointer')).toHaveCount(0);
        await running.page.mouse.click(
            fileBounds.x + fileBounds.width / 2,
            fileBounds.y + fileBounds.height / 2,
        );
        await expect(running.page.getByRole('tab', { name: 'example.ts' })).toHaveCount(0);

        await hoverTerminalLink(running.page, slashSeparatedProse);
        await expect(
            running.page
                .locator('.xterm-rows span[style*="text-decoration: underline"]')
                .filter({ hasText: '账单/' }),
        ).toHaveCount(0);
        await expect(hint).toHaveCount(0);

        const urlBounds = await hoverTerminalLink(running.page, url);
        await expect(hint).toHaveText('⌘ click to open in browser');
        await expect(
            running.page
                .locator('.xterm-rows span[style*="text-decoration: underline"]')
                .filter({ hasText: url })
                .last(),
        ).toHaveText(url);
        const urlHintBounds = await hint.boundingBox();
        if (!urlHintBounds) throw new Error('Terminal URL hint bounds are unavailable');
        expect(urlHintBounds.y + urlHintBounds.height).toBeLessThanOrEqual(urlBounds.y);

        await hoverTerminalLink(running.page, oscBrowserLabel, {
            expectPointerClass: true,
        });
        const terminal = running.page.locator('.xterm');
        await expect(terminal).toHaveCSS('cursor', 'text');
        await expect(hint).toHaveText('⌘ click to open in browser');
        await running.page.keyboard.down('Meta');
        await expect(terminal).toHaveCSS('cursor', 'pointer');
        await running.page.keyboard.up('Meta');
        await expect(terminal).toHaveCSS('cursor', 'text');

        await hoverTerminalLink(running.page, oscEditorLabel, {
            expectPointerClass: true,
        });
        await expect(hint).toHaveText('⌘ click to open in editor');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
