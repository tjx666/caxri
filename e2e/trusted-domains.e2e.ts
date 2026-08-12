import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import type { MessageBoxOptions } from 'electron';

import { launchCaxri, pageRequest, typeTerminal } from './helpers.ts';

async function createFocusedShell(page: Page): Promise<void> {
    const rootPath = await pageRequest<string | null>(page, 'dialog.selectDirectory');
    if (!rootPath) throw new Error('Expected the deterministic test Project root');
    const project = await pageRequest<{ id: string }>(page, 'project.create', { rootPath });
    await pageRequest(page, 'session.create', { projectId: project.id, defaultAgent: 'shell' });
    await expect(page.locator('.xterm-helper-textarea')).toBeVisible();
}

async function terminalTextBounds(page: Page, text: string) {
    return page.locator('.xterm-rows').evaluate((rows, target) => {
        let matched: { x: number; y: number; width: number; height: number } | undefined;
        for (const row of rows.children) {
            const rowText = row.textContent ?? '';
            const targetStart = rowText.indexOf(target);
            if (targetStart < 0) continue;
            const range = document.createRange();
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            let offset = 0;
            let start: { node: Node; offset: number } | undefined;
            let end: { node: Node; offset: number } | undefined;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const length = node.textContent?.length ?? 0;
                if (!start && targetStart >= offset && targetStart <= offset + length)
                    start = { node, offset: targetStart - offset };
                const targetEnd = targetStart + target.length;
                if (targetEnd >= offset && targetEnd <= offset + length) {
                    end = { node, offset: targetEnd - offset };
                    break;
                }
                offset += length;
            }
            if (!start || !end) continue;
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            const bounds = range.getBoundingClientRect();
            matched = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        }
        return matched ?? null;
    }, text);
}

async function clickTerminalText(page: Page, text: string): Promise<void> {
    /** The xterm container can match a command whose URL is still wrapped across multiple rows. */
    await expect.poll(() => terminalTextBounds(page, text)).not.toBeNull();
    const bounds = await terminalTextBounds(page, text);
    if (!bounds) throw new Error(`Terminal text not found: ${text}`);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.waitForTimeout(100);
    await page.keyboard.down('Meta');
    try {
        await page.mouse.click(x, y);
    } finally {
        await page.keyboard.up('Meta');
    }
}

test('Trusted Domains persists, bypasses repeat prompts, and can be revoked in Settings', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-trusted-domains-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        /** Project creation is not under test here, so avoid the animated Agent picker surface. */
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
        await typeTerminal(running.page, `printf '%s\\n' '${firstUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(firstUrl);
        await clickTerminalText(running.page, firstUrl);
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
        await expect(
            pageRequest<{ value: { 'security.trustedDomains': string[] } }>(
                running.page,
                'settings.get',
            ).then((result) => result.value['security.trustedDomains']),
        ).resolves.toEqual(['https://example.com']);

        const secondUrl = 'https://example.com/without-prompt';
        await typeTerminal(running.page, `printf '%s\\n' '${secondUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(secondUrl);
        await clickTerminalText(running.page, secondUrl);
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

        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Manage Trusted Domains');
        await palette.getByRole('option').filter({ hasText: 'Manage Trusted Domains' }).click();
        const settings = running.page.getByRole('dialog');
        const ruleInput = settings.getByRole('textbox', {
            name: 'Trusted domain rule',
            exact: true,
        });
        await expect(ruleInput).toBeFocused();
        await expect(settings.getByRole('list', { name: 'Trusted domain rules' })).toContainText(
            'https://example.com',
        );
        await ruleInput.fill('HTTPS://*.Example.ORG.:443');
        await settings.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(settings.getByRole('list', { name: 'Trusted domain rules' })).toContainText(
            'https://*.example.org',
        );
        await settings
            .getByRole('button', { name: 'Remove trusted domain https://example.com' })
            .click();
        await settings.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: { 'security.trustedDomains': string[] };
                }>(running.page, 'settings.get');
                return result.value['security.trustedDomains'];
            })
            .toEqual(['https://*.example.org']);
        await running.page.keyboard.press('Escape');
        await expect(settings).toHaveCount(0);

        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriTrustedDomainProbe?: { response: number };
            };
            target.caxriTrustedDomainProbe!.response = 0;
        });
        const revokedUrl = 'https://example.com/after-revoke';
        await typeTerminal(running.page, `printf '%s\\n' '${revokedUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(revokedUrl);
        await clickTerminalText(running.page, revokedUrl);
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
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
