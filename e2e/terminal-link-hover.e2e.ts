import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    hoverTerminalLink,
    launchCaxri,
    typeTerminal,
} from './support/helpers.ts';

test('Terminal links delay contextual hover hints and reserve the pointer cursor for Cmd', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-link-hover-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const sourceDirectory = join(root, 'src');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'example.ts'), 'first\nsecond\n');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const fileLink = 'src/example.ts:2';
        const url = 'https://example.com/hover-link';
        const urlLine = `${url}(覆盖 6/6 checks)。`;
        const oscBrowserLabel = 'OSC browser';
        const oscEditorLabel = 'OSC editor';
        const oscFileUrl = pathToFileURL(join(sourceDirectory, 'example.ts')).href;
        await typeTerminal(
            running.page,
            String.raw`printf '%s\n' '${fileLink}' '${urlLine}'; printf '\033]8;;https://example.com/osc-link\007${oscBrowserLabel}\033]8;;\007\n'; printf '\033]8;;${oscFileUrl}\007${oscEditorLabel}\033]8;;\007\n'`,
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

        await running.page.keyboard.down('Meta');
        await expect(running.page.locator('.xterm-cursor-pointer')).toBeVisible();
        await running.page.keyboard.up('Meta');
        await expect(running.page.locator('.xterm-cursor-pointer')).toHaveCount(0);
        await running.page.mouse.click(
            fileBounds.x + fileBounds.width / 2,
            fileBounds.y + fileBounds.height / 2,
        );
        await expect(running.page.getByRole('tab', { name: 'example.ts' })).toHaveCount(0);

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
