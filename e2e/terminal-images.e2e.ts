import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from './fixtures.ts';

import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
    typeTerminal,
} from './helpers.ts';

const RECOVERY_PLACEHOLDER = 'Caxri inline image unavailable after restore';

async function createPngBase64(page: Page, width: number, height: number): Promise<string> {
    return page.evaluate(
        ({ height: imageHeight, width: imageWidth }) => {
            const canvas = document.createElement('canvas');
            canvas.width = imageWidth;
            canvas.height = imageHeight;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Canvas context is unavailable');
            context.fillStyle = '#ff0000';
            context.fillRect(0, 0, imageWidth, imageHeight);
            return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
        },
        { height, width },
    );
}

async function redPixelCount(app: ElectronApplication, surface: Locator): Promise<number> {
    const screenshot = await surface.screenshot();
    return app.evaluate(({ nativeImage }, screenshotBase64) => {
        const image = nativeImage.createFromBuffer(Buffer.from(screenshotBase64, 'base64'));
        const bitmap = image.toBitmap();
        let count = 0;
        for (let offset = 0; offset < bitmap.length; offset += 4) {
            const firstColorChannel = bitmap[offset];
            const thirdColorChannel = bitmap[offset + 2];
            if (
                Math.max(firstColorChannel, thirdColorChannel) > 220 &&
                bitmap[offset + 1] < 45 &&
                Math.min(firstColorChannel, thirdColorChannel) < 45
            )
                count += 1;
        }
        return count;
    }, screenshot.toString('base64'));
}

function iipImage(base64: string, width: number, height: number): string {
    return `\x1b]1337;File=inline=1;width=${width}px;height=${height}px:${base64}\x07`;
}

function sixelImage(): string {
    return `\x1bPq"1;1;64;48#0;2;100;0;0${Array.from({ length: 8 }, () => '!64~').join('-')}\x1b\\`;
}

test('inline images render real pixels, enforce budgets, and restore as content-free placeholders', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-images-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const smallPng = await createPngBase64(running.page, 64, 48);
        const cachePng = await createPngBase64(running.page, 512, 512);
        const iipPath = join(root, 'iip-image.bin');
        const sixelPath = join(root, 'sixel-image.bin');
        const cachePath = join(root, 'cache-image.bin');
        const oversizedPath = join(root, 'oversized-image.bin');
        await Promise.all([
            writeFile(iipPath, iipImage(smallPng, 64, 48)),
            writeFile(sixelPath, sixelImage()),
            writeFile(cachePath, iipImage(cachePng, 512, 512)),
            writeFile(
                oversizedPath,
                `\x1b]1337;File=inline=1:${'A'.repeat(70 * 1024)}\x07AFTER_IMAGE_LIMIT\r\n`,
            ),
        ]);
        expect(Buffer.byteLength(smallPng)).toBeGreaterThan(100);
        expect(Buffer.byteLength(iipImage(cachePng, 512, 512))).toBeLessThan(64 * 1024);

        await createShellSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        const pane = running.page.locator('.terminal-pane');
        const terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        const surface = pane.locator('.terminal-surface');
        await expect(surface).toHaveAttribute('data-terminal-image-status', 'active');
        await expect(surface).toHaveAttribute('data-terminal-images-added', '0');
        const baselineRedPixels = await redPixelCount(running.app, surface);

        await typeTerminal(running.page, `cat '${iipPath}'`);
        await expect(surface).toHaveAttribute('data-terminal-images-added', '1');
        await expect
            .poll(() => redPixelCount(running.app, surface))
            .toBeGreaterThan(baselineRedPixels + 1_000);

        await typeTerminal(running.page, "printf '\\033c'");
        const sixelBaselineRedPixels = await redPixelCount(running.app, surface);
        await typeTerminal(running.page, `cat '${sixelPath}'`);
        await expect(surface).toHaveAttribute('data-terminal-images-added', '2');
        await expect
            .poll(() => redPixelCount(running.app, surface))
            .toBeGreaterThan(sixelBaselineRedPixels + 1_000);

        await typeTerminal(running.page, `cat '${oversizedPath}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText('AFTER_IMAGE_LIMIT');
        await expect(surface).toHaveAttribute('data-terminal-images-added', '2');

        for (let image = 0; image < 10; image += 1)
            await typeTerminal(running.page, `cat '${cachePath}'`);
        await expect(surface).toHaveAttribute('data-terminal-images-added', '12');
        await expect
            .poll(async () => Number(await surface.getAttribute('data-terminal-image-storage-mb')))
            .toBeLessThanOrEqual(8);
        await expect(surface).toHaveAttribute('data-terminal-image-storage-limit-mb', '8');
        await expect(surface).toHaveAttribute('data-terminal-image-global-storage-limit-mb', '24');

        await createAdditionalShellSession(running.page);
        await sessionCard(running.page, firstSessionId).click();
        await expect(sessionCard(running.page, firstSessionId)).toHaveClass(/active/);
        await expect(running.page.locator('.xterm-rows')).toContainText(RECOVERY_PLACEHOLDER);

        await running.page.reload();
        await expect(running.page.locator('.terminal-pane')).toHaveAttribute(
            'data-terminal-id',
            terminalId,
        );
        await expect(running.page.locator('.xterm-rows')).toContainText(RECOVERY_PLACEHOLDER);

        const terminalTab = running.page.locator(`.work-tab[data-terminal-id="${terminalId}"]`);
        await terminalTab.hover();
        await terminalTab.getByRole('button', { name: 'Close Terminal' }).click();
        await expect
            .poll(async () => {
                const state = await pageRequest<{ terminals: Array<{ id: string }> }>(
                    running.page,
                    'app.bootstrap',
                );
                return state.terminals.some(({ id }) => id === terminalId);
            })
            .toBe(false);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
