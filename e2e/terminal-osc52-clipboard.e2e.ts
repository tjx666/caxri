import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './fixtures.ts';

import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
    typeTerminal,
} from './helpers.ts';

function osc52(payload: string, selection = 'c'): string {
    return `printf '\\033]52;${selection};${payload}\\007'`;
}

const encoded = (text: string): string => Buffer.from(text).toString('base64');

test('OSC 52 clipboard writes remain opt-in, bounded, write-only, and lifecycle-safe', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-osc52-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        await running.app.evaluate(({ clipboard }) => clipboard.writeText('OSC52_SENTINEL'));
        await running.page.evaluate(() => {
            const clipboard = navigator.clipboard;
            const originalRead = clipboard.readText.bind(clipboard);
            Object.defineProperty(window, '__osc52ReadCount', { value: 0, writable: true });
            Object.defineProperty(clipboard, 'readText', {
                configurable: true,
                value: () => {
                    const state = window as unknown as { __osc52ReadCount: number };
                    state.__osc52ReadCount += 1;
                    return originalRead();
                },
            });
        });

        await typeTerminal(running.page, osc52(encoded('DEFAULT_BLOCKED')));
        await typeTerminal(running.page, osc52('?'));
        await running.page.waitForTimeout(200);
        expect(await running.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
            'OSC52_SENTINEL',
        );
        expect(
            await running.page.evaluate(
                () => (window as unknown as { __osc52ReadCount: number }).__osc52ReadCount,
            ),
        ).toBe(0);

        await running.page.keyboard.press('Meta+,');
        const dialog = running.page.getByRole('dialog');
        const setting = dialog.getByLabel('Allow OSC 52 clipboard writes');
        await expect(setting).not.toBeChecked();
        await setting.check();
        await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.osc52ClipboardWrite': boolean };
                }>(running.page, 'settings.get');
                return settings.value['terminal.osc52ClipboardWrite'];
            })
            .toBe(true);
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();

        await typeTerminal(
            running.page,
            `printf '\\033]52;c;${encoded('FIRST_WRITE')}\\007\\033]52;c;${encoded('RATE_BLOCKED')}\\007'`,
        );
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText()))
            .toBe('FIRST_WRITE');

        await running.page.waitForTimeout(1_050);
        await typeTerminal(running.page, osc52('%%%'));
        await typeTerminal(running.page, osc52(encoded('PRIMARY_BLOCKED'), 'p'));
        await running.page.waitForTimeout(200);
        expect(await running.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
            'FIRST_WRITE',
        );

        await createAdditionalShellSession(running.page);
        const secondTerminalTab = running.page.locator('.work-tab.active[data-terminal-id]');
        const secondTerminalId = await secondTerminalTab.getAttribute('data-terminal-id');
        expect(secondTerminalId).toBeTruthy();
        await typeTerminal(running.page, osc52(encoded('SECOND_SESSION_WRITE')));
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText()))
            .toBe('SECOND_SESSION_WRITE');

        await running.page.waitForTimeout(1_050);
        await running.app.evaluate(({ clipboard }) => clipboard.writeText('CLOSE_SENTINEL'));
        await typeTerminal(
            running.page,
            `(sleep 0.5; ${osc52(encoded('CLOSED_TERMINAL_WRITE'))}) &`,
        );
        await secondTerminalTab.hover();
        await secondTerminalTab.getByRole('button', { name: 'Close Terminal' }).click();
        await expect
            .poll(async () => {
                const state = await pageRequest<{ terminals: Array<{ id: string }> }>(
                    running.page,
                    'app.bootstrap',
                );
                return state.terminals.some(({ id }) => id === secondTerminalId);
            })
            .toBe(false);
        await running.page.waitForTimeout(750);
        expect(await running.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
            'CLOSE_SENTINEL',
        );

        const firstSession = sessionCard(running.page, firstSessionId);
        await firstSession.click();
        await expect(firstSession).toHaveClass(/active/);
        await running.page.waitForTimeout(1_050);
        await running.page.evaluate(() => {
            Object.defineProperty(navigator.clipboard, 'writeText', {
                configurable: true,
                value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
            });
        });
        await typeTerminal(running.page, osc52(encoded('PERMISSION_FIXTURE')));
        const permissionToast = running.page.getByText(
            'OSC 52 clipboard write was denied. Check macOS clipboard permissions.',
            { exact: true },
        );
        await expect(permissionToast).toHaveCount(1);
        await running.page.waitForTimeout(1_050);
        await typeTerminal(running.page, osc52(encoded('SECOND_PERMISSION_FIXTURE')));
        await expect(permissionToast).toHaveCount(1);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
