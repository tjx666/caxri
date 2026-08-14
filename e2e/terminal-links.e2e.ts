import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import type { MessageBoxOptions } from 'electron';

import {
    clickTerminalLink,
    createShellSession,
    launchCaxri,
    pageRequest,
    typeTerminal,
} from './support/helpers.ts';

test('Terminal links open Project files and confirm URLs through Main', async () => {
    allowE2EErrors([{ source: 'main', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 }]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-links-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const file = join(root, 'link-target.ts');
    await mkdir(root);
    await writeFile(file, 'first line\nsecond line\nthird line\n');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const fileLink = 'link-target.ts:2:3';
        await typeTerminal(running.page, `printf '%s\\n' '${fileLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(fileLink);
        await clickTerminalLink(running.page, fileLink);

        await expect(running.page.getByRole('tab', { name: 'link-target.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 2, Col 3/)).toBeVisible();

        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & {
                caxriExternalLinkProbe?: {
                    confirmations: string[];
                    failOpen: boolean;
                    opened: string[];
                    response: number;
                };
            };
            target.caxriExternalLinkProbe = {
                confirmations: [],
                failOpen: false,
                opened: [],
                response: 0,
            };
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                target.caxriExternalLinkProbe!.confirmations.push(options.message);
                return Promise.resolve({
                    response: target.caxriExternalLinkProbe!.response,
                    checkboxChecked: false,
                });
            };
            shell.openExternal = (url) => {
                if (target.caxriExternalLinkProbe!.failOpen)
                    return Promise.reject(new Error('browser unavailable'));
                target.caxriExternalLinkProbe!.opened.push(url);
                return Promise.resolve();
            };
        });

        await expect(
            pageRequest(running.page, 'external.open', { url: 'not a URL' }),
        ).resolves.toEqual({ status: 'rejected', reason: 'invalid_url' });
        await expect(
            pageRequest(running.page, 'external.open', { url: 'file:///tmp/caxri-denied-link' }),
        ).resolves.toEqual({ status: 'rejected', reason: 'unsupported_protocol' });
        await running.page.evaluate(() => window.open('file:///tmp/caxri-denied-link'));
        const url = 'https://example.com/caxri-link';
        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await typeTerminal(running.page, `printf '%s\\n' '${url}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(url);
        await clickTerminalLink(running.page, url);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriExternalLinkProbe?: { opened: string[] };
                    };
                    return target.caxriExternalLinkProbe?.opened;
                }),
            )
            .toContain(url);
        await expect(running.page.locator('.toast')).toHaveCount(0);

        const canceledUrl = 'https://example.org/canceled';
        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriExternalLinkProbe?: { response: number };
            };
            target.caxriExternalLinkProbe!.response = 2;
        });
        await typeTerminal(running.page, `printf '%s\\n' '${canceledUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(canceledUrl);
        await clickTerminalLink(running.page, canceledUrl);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriExternalLinkProbe?: { confirmations: string[] };
                    };
                    return target.caxriExternalLinkProbe?.confirmations.length;
                }),
            )
            .toBe(2);
        await expect(running.page.locator('.toast')).toHaveCount(0);

        const failedUrl = 'https://example.net/failure';
        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriExternalLinkProbe?: { failOpen: boolean; response: number };
            };
            target.caxriExternalLinkProbe!.response = 0;
            target.caxriExternalLinkProbe!.failOpen = true;
        });
        await typeTerminal(running.page, `printf '%s\\n' '${failedUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(failedUrl);
        await clickTerminalLink(running.page, failedUrl);
        await expect(running.page.locator('.toast')).toContainText('browser unavailable');
        await expect(running.page.locator('.toast')).not.toContainText('Popup blocked');

        await expect(
            running.app.evaluate(() => {
                const target = globalThis as typeof globalThis & {
                    caxriExternalLinkProbe?: {
                        confirmations: string[];
                        opened: string[];
                    };
                };
                return target.caxriExternalLinkProbe;
            }),
        ).resolves.toMatchObject({
            confirmations: [
                'Open example.com in your default browser?',
                'Open example.org in your default browser?',
                'Open example.net in your default browser?',
            ],
            opened: [url],
        });
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
