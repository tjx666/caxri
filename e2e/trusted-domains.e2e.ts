import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageBoxOptions } from 'electron';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { clickTerminalLink, launchCaxri, pageRequest, typeTerminal } from './support/helpers.ts';

async function createFocusedShell(page: Page): Promise<void> {
    const rootPath = await pageRequest<string | null>(page, 'dialog.selectDirectory');
    if (!rootPath) throw new Error('Expected the deterministic test Project root');
    const project = await pageRequest<{ id: string }>(page, 'project.create', { rootPath });
    await pageRequest(page, 'session.create', { projectId: project.id, defaultAgent: 'shell' });
    await expect(page.locator('.xterm-helper-textarea')).toBeVisible();
}

test('Trusted Domains persists, bypasses repeat prompts, and can be revoked in Settings', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-trusted-domains-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        /**
         * Project creation is not under test here, so avoid the animated Agent picker surface.
         */
        await createFocusedShell(running.page);
        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & {
                caxriTrustedDomainProbe?: {
                    confirmations: Array<{ buttons: string[]; message: string }>;
                    opened: string[];
                    response: number;
                };
            };
            target.caxriTrustedDomainProbe = { confirmations: [], opened: [], response: 1 };
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                target.caxriTrustedDomainProbe!.confirmations.push({
                    buttons: options.buttons ?? [],
                    message: options.message,
                });
                return Promise.resolve({
                    response: target.caxriTrustedDomainProbe!.response,
                    checkboxChecked: false,
                });
            };
            shell.openExternal = (url) => {
                target.caxriTrustedDomainProbe!.opened.push(url);
                return Promise.resolve();
            };
        });

        const firstUrl = 'https://example.com/first';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${firstUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(firstUrl);
        await clickTerminalLink(running.page, firstUrl);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriTrustedDomainProbe?: { opened: string[] };
                    };
                    return target.caxriTrustedDomainProbe?.opened;
                }),
            )
            .toContain(firstUrl);
        const trustedDomainsSettings = await pageRequest<{
            value: { 'security.trustedDomains': string[] };
        }>(running.page, 'settings.get');
        expect(trustedDomainsSettings.value['security.trustedDomains']).toEqual([
            'https://example.com',
        ]);

        const secondUrl = 'https://example.com/without-prompt';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${secondUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(secondUrl);
        await clickTerminalLink(running.page, secondUrl);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriTrustedDomainProbe?: { opened: string[] };
                    };
                    return target.caxriTrustedDomainProbe?.opened.length;
                }),
            )
            .toBe(2);
        await expect(
            running.app.evaluate(() => {
                const target = globalThis as typeof globalThis & {
                    caxriTrustedDomainProbe?: {
                        confirmations: Array<{ buttons: string[]; message: string }>;
                    };
                };
                return target.caxriTrustedDomainProbe?.confirmations;
            }),
        ).resolves.toEqual([
            {
                buttons: ['Open Once', 'Trust Domain and Open', 'Cancel'],
                message: 'Open example.com in your default browser?',
            },
        ]);

        await running.page.evaluate(() => window.open('https://example.com/passive'));
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriTrustedDomainProbe?: { opened: string[] };
                    };
                    return target.caxriTrustedDomainProbe?.opened;
                }),
            )
            .toEqual([firstUrl, secondUrl]);

        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Manage Trusted Domains');
        await palette.getByRole('option').filter({ hasText: 'Manage Trusted Domains' }).click();
        // Settings is a Workbench tab now, not a modal (issue caxri#1289).
        const settings = running.page.locator('[data-settings-page]');
        const ruleInput = settings.getByRole('textbox', {
            name: 'Trusted domain rule',
            exact: true,
        });
        await expect(ruleInput).toBeFocused();
        await expect(settings.getByRole('list', { name: 'Trusted domain rules' })).toContainText(
            'https://example.com',
        );
        await ruleInput.fill('HTTPS://*.Example.ORG.:443');
        await settings
            .getByLabel('Trusted Domains editor')
            .getByRole('button', { name: 'Add', exact: true })
            .click();
        await expect(settings.getByRole('list', { name: 'Trusted domain rules' })).toContainText(
            'https://*.example.org',
        );
        await settings
            .getByRole('button', { name: 'Remove trusted domain https://example.com' })
            .click();
        // Trusted-domain rule edits write immediately (debounced) now that the dialog has no Apply
        // button; the persisted value read back is the synchronization point.
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: { 'security.trustedDomains': string[] };
                }>(running.page, 'settings.get');
                return result.value['security.trustedDomains'];
            })
            .toEqual(['https://*.example.org']);
        // Settings is a Workbench tab now, not a modal (issue caxri#1289), and it occupies
        // the same pane the Terminal does: close it outright so the Terminal below is mounted
        // again for `typeTerminal` to find below.
        await running.page.keyboard.press('Meta+w');
        await expect(settings).toHaveCount(0);

        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriTrustedDomainProbe?: { response: number };
            };
            target.caxriTrustedDomainProbe!.response = 0;
        });
        const revokedUrl = 'https://example.com/after-revoke';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${revokedUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(revokedUrl);
        await clickTerminalLink(running.page, revokedUrl);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriTrustedDomainProbe?: { confirmations: unknown[] };
                    };
                    return target.caxriTrustedDomainProbe?.confirmations.length;
                }),
            )
            .toBe(2);

        await expect(
            pageRequest(running.page, 'external.open', {
                url: 'https://docs.example.org/trusted-subdomain',
            }),
        ).resolves.toEqual({ status: 'opened' });
        const beforeRejected = await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriTrustedDomainProbe?: { confirmations: unknown[]; opened: string[] };
            };
            return {
                confirmations: target.caxriTrustedDomainProbe!.confirmations.length,
                opened: target.caxriTrustedDomainProbe!.opened.length,
            };
        });
        await expect(
            pageRequest(running.page, 'external.open', { url: 'custom://example.org/private' }),
        ).resolves.toEqual({ status: 'rejected', reason: 'unsupported_protocol' });
        await expect(
            running.app.evaluate(() => {
                const target = globalThis as typeof globalThis & {
                    caxriTrustedDomainProbe?: { confirmations: unknown[]; opened: string[] };
                };
                return {
                    confirmations: target.caxriTrustedDomainProbe!.confirmations.length,
                    opened: target.caxriTrustedDomainProbe!.opened.length,
                };
            }),
        ).resolves.toEqual(beforeRejected);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
