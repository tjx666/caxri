import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageBoxOptions } from 'electron';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    clickTerminalLink,
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
    typeTerminal,
} from './support/helpers.ts';

test('Terminal links open Project files and confirm URLs through Main', async () => {
    allowE2EErrors([{ source: 'main', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 }]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-links-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const isolatedHome = join(userData, 'e2e-agents', 'home');
    const root = join(isolatedHome, 'project');
    const file = join(root, 'link-target.ts');
    const outsideRoot = join(isolatedHome, 'outside-project');
    const outsideFile = join(outsideRoot, 'outside-target.ts');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(outsideRoot, { recursive: true })]);
    await writeFile(file, 'first line\nsecond line\nthird line\n');
    await writeFile(outsideFile, 'outside first\noutside second\n');

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([root, outsideRoot]) },
    });
    try {
        await createShellSession(running.page);
        const sourceSessionId = await selectedSessionId(running.page);
        const fileLink = 'link-target.ts:2:3';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${fileLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(fileLink);
        await clickTerminalLink(running.page, fileLink);

        await expect(running.page.getByRole('tab', { name: 'link-target.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 2, Col 3/)).toBeVisible();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const existingHomeLink = '~/project/link-target.ts:3:2';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${existingHomeLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(existingHomeLink);
        await clickTerminalLink(running.page, existingHomeLink);
        await expect(running.page.getByRole('tab', { name: 'link-target.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 3, Col 2/)).toBeVisible();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const outsideHomeLink = '~/outside-project/outside-target.ts:2:4';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${outsideHomeLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(outsideHomeLink);
        await clickTerminalLink(running.page, outsideHomeLink);
        await expect(running.page.getByRole('tab', { name: 'outside-target.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 2, Col 4/)).toBeVisible();
        await expect(
            running.page.getByRole('treeitem', { name: /outside-project/ }).first(),
        ).toBeVisible();
        await sessionCard(running.page, sourceSessionId).click();
        await expect(running.page.getByRole('tab', { name: 'Shell' })).toBeVisible();

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
        await typeTerminal(running.page, String.raw`printf '%s\n' '${url}'`);
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
        await typeTerminal(running.page, String.raw`printf '%s\n' '${canceledUrl}'`);
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
        await typeTerminal(running.page, String.raw`printf '%s\n' '${failedUrl}'`);
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
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Terminal detected-link picker opens file and OSC 8 links without a pointer', async () => {
    allowE2EErrors([
        { source: 'main', event: 'ipc.request_failed', code: 'PATH_DENIED', count: 1 },
        { source: 'runtime', event: 'ipc.request_failed', code: 'PATH_DENIED', count: 1 },
        { source: 'main', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
        { source: 'runtime', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-link-picker-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const isolatedHome = join(userData, 'e2e-agents', 'home');
    const root = join(isolatedHome, 'project');
    const file = join(root, 'link-target.ts');
    const deniedFile = join(testDirectory, 'denied-target.ts');
    await mkdir(root, { recursive: true });
    await Promise.all([
        writeFile(file, 'first line\nsecond line\nthird line\n'),
        writeFile(deniedFile, 'outside Project root\n'),
    ]);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([root]) },
    });
    try {
        await createShellSession(running.page);
        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & {
                caxriKeyboardLinkProbe?: {
                    confirmations: string[];
                    opened: string[];
                    response: number;
                };
            };
            target.caxriKeyboardLinkProbe = { confirmations: [], opened: [], response: 0 };
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                target.caxriKeyboardLinkProbe!.confirmations.push(options.message);
                return Promise.resolve({
                    response: target.caxriKeyboardLinkProbe!.response,
                    checkboxChecked: false,
                });
            };
            shell.openExternal = (url) => {
                target.caxriKeyboardLinkProbe!.opened.push(url);
                return Promise.resolve();
            };
        });

        const fileLink = 'link-target.ts:2:3';
        const homeLink = '~/project/link-target.ts:3:2';
        const url = 'https://example.org/keyboard-link';
        const rejectedUrl = 'https://user:password@example.net/rejected';
        const oscUrl = 'https://example.com/osc-keyboard-link';
        await typeTerminal(
            running.page,
            String.raw`printf '%s\n' '${fileLink}' '${homeLink}' '${url}' '${rejectedUrl}'; printf '\033]8;;https://example.com/%s\007OSC link label\033]8;;\007\n' 'osc-keyboard-link'`,
        );
        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await expect(running.page.locator('.xterm-rows')).toContainText('OSC link label');

        const openLink = async (target: string, accessibleName: string): Promise<void> => {
            await terminalInput.focus();
            await running.page.keyboard.press('Meta+Shift+O');
            const dialog = running.page.getByRole('dialog');
            await expect(dialog.getByRole('heading', { name: 'Open Detected Link' })).toBeVisible();
            const search = dialog.getByPlaceholder('Search links in the visible Terminal…');
            await search.fill(target);
            await expect(
                dialog.getByRole('option', { name: accessibleName, exact: true }),
            ).toBeVisible();
            await search.press('Enter');
            await expect(dialog).toHaveCount(0);
        };

        await terminalInput.focus();
        await running.page.keyboard.press('Meta+Shift+O');
        await running.page.keyboard.press('Escape');
        await expect(terminalInput).toBeFocused();

        await openLink(oscUrl, `Open external link ${oscUrl}`);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriKeyboardLinkProbe?: { opened: string[] };
                    };
                    return target.caxriKeyboardLinkProbe?.opened;
                }),
            )
            .toContain(oscUrl);

        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriKeyboardLinkProbe?: { response: number };
            };
            target.caxriKeyboardLinkProbe!.response = 2;
        });
        await openLink(url, `Open external link ${url}`);
        await expect(terminalInput).toBeFocused();
        await openLink(rejectedUrl, `Open external link ${rejectedUrl}`);
        await expect(running.page.locator('.toast')).toContainText(
            'External links cannot include credentials',
        );
        await expect(terminalInput).toBeFocused();
        await expect(
            running.app.evaluate(() => {
                const target = globalThis as typeof globalThis & {
                    caxriKeyboardLinkProbe?: {
                        confirmations: string[];
                        opened: string[];
                    };
                };
                return target.caxriKeyboardLinkProbe;
            }),
        ).resolves.toMatchObject({
            confirmations: [
                'Open example.com in your default browser?',
                'Open example.org in your default browser?',
            ],
            opened: [oscUrl],
        });

        await openLink(fileLink, `Open file link ${fileLink}`);
        await expect(running.page.getByRole('tab', { name: 'link-target.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 2, Col 3/)).toBeVisible();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriKeyboardLinkProbe?: { response: number };
            };
            target.caxriKeyboardLinkProbe!.response = 0;
        });
        await openLink(oscUrl, `Open external link ${oscUrl}`);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriKeyboardLinkProbe?: { opened: string[] };
                    };
                    return target.caxriKeyboardLinkProbe?.opened;
                }),
            )
            .toEqual([oscUrl, oscUrl]);
        await openLink(homeLink, `Open file link ${homeLink}`);
        await expect(running.page.getByLabel(/^Editor position: Ln 3, Col 2/)).toBeVisible();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const beforeRejectedLinks = await pageRequest<{
            projects: unknown[];
            sessions: unknown[];
        }>(running.page, 'app.bootstrap');
        const deniedLink = deniedFile;
        await typeTerminal(running.page, String.raw`printf '%s\n' '${deniedLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(deniedLink);
        await openLink(deniedLink, `Open file link ${deniedLink}`);
        await expect(
            running.page
                .locator('.toast')
                .filter({ hasText: 'Symlink target is outside the Project root' }),
        ).toBeVisible();
        await expect(terminalInput).toBeFocused();

        const missingLink = '~/project/missing-target.ts';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${missingLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(missingLink);
        await openLink(missingLink, `Open file link ${missingLink}`);
        await expect(
            running.page
                .locator('.toast')
                .filter({ hasText: 'Terminal link target was not found' }),
        ).toBeVisible();
        await expect(terminalInput).toBeFocused();
        const afterRejectedLinks = await pageRequest<{
            projects: unknown[];
            sessions: unknown[];
        }>(running.page, 'app.bootstrap');
        expect(afterRejectedLinks.projects).toHaveLength(beforeRejectedLinks.projects.length);
        expect(afterRejectedLinks.sessions).toHaveLength(beforeRejectedLinks.sessions.length);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
