import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    selectedSessionId,
    sessionCard,
    typeTerminal,
    VISIBLE_SESSION,
    waitForNewTerminalId,
} from './support/helpers.ts';
import { openSettingsTab, revealSettingsSection } from './support/settings.ts';

function osc52(payload: string, selection = 'c'): string {
    return String.raw`printf '\033]52;${selection};${payload}\007'`;
}

const encoded = (text: string): string => Buffer.from(text).toString('base64');

interface StructuredLogRecord {
    event: string;
    fields?: Record<string, unknown>;
}

async function readStructuredLog(path: string): Promise<StructuredLogRecord[]> {
    try {
        const content = await readFile(path, 'utf8');
        const completeContent = content.endsWith('\n')
            ? content
            : content.slice(0, content.lastIndexOf('\n') + 1);
        return completeContent
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as StructuredLogRecord);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

const OSC52_BLOCKED_TOASTS = {
    disabled:
        'A Terminal program tried to copy to the clipboard, but OSC 52 access is off in Settings.',
    malformed: 'A Terminal program sent a malformed clipboard request; it was ignored.',
    rateLimited:
        'A Terminal program is copying to the clipboard too quickly; extra requests are being ignored.',
} as const;

test('OSC 52 clipboard writes honor opt-out and remain bounded, write-only, and lifecycle-safe', async () => {
    // The opt-out asserted below tells the user once that a Terminal program was denied the clipboard, and both refused
    // writes fail in Main, where Renderer copies are written.
    allowE2EErrors([
        { source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 },
        { source: 'desktop', event: 'ipc.request_failed', code: 'INTERNAL', count: 2 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-osc52-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        const firstTerminalId = await running.page
            .locator(`${VISIBLE_SESSION} .work-tab.active[data-terminal-id]`)
            .getAttribute('data-terminal-id');
        if (!firstTerminalId) throw new Error('First Terminal identity was not rendered');
        await running.clipboard.writeText('OSC52_SENTINEL');
        await running.page.evaluate(() => {
            const clipboard = navigator.clipboard;
            const originalRead = clipboard.readText.bind(clipboard);
            Object.defineProperty(globalThis, '__osc52ReadCount', { value: 0, writable: true });
            Object.defineProperty(clipboard, 'readText', {
                configurable: true,
                value: () => {
                    const state = globalThis as unknown as { __osc52ReadCount: number };
                    state.__osc52ReadCount += 1;
                    return originalRead();
                },
            });
        });

        const initialSettingsTab = await openSettingsTab(running.page);
        await revealSettingsSection(initialSettingsTab, 'Terminal');
        const initialSetting = initialSettingsTab.getByRole('switch', {
            name: 'Let programs in the Terminal copy to your clipboard',
        });
        await expect(initialSetting).toBeChecked();
        await initialSetting.uncheck();
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.osc52ClipboardWrite': boolean };
                }>(running.page, 'settings.get');
                return settings.value['terminal.osc52ClipboardWrite'];
            })
            .toBe(false);
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): it occupies the
        // same pane a Terminal session would, so `Cmd+W` closes it outright to get the Terminal
        // back in view before typing into it below; there is no "Close" button to click anymore.
        await running.page.keyboard.press('Meta+w');

        await typeTerminal(running.page, osc52(encoded('DISABLED_BLOCKED')));
        await typeTerminal(running.page, osc52('?'));
        /**
         * A write blocked because the setting is off now reports through the same notification path as a real clipboard
         * failure, with plain language pointing at Settings. Both writes above land inside the same per-reason throttle
         * window, so only one toast is expected.
         */
        await expect(
            running.page.getByText(OSC52_BLOCKED_TOASTS.disabled, { exact: true }),
        ).toBeVisible();
        expect(await running.clipboard.textEquals('OSC52_SENTINEL')).toBe(true);
        expect(
            await running.page.evaluate(
                () => (globalThis as unknown as { __osc52ReadCount: number }).__osc52ReadCount,
            ),
        ).toBe(0);

        const settingsTab = await openSettingsTab(running.page);
        // Settings rows are virtualized, so reveal the Terminal section before querying its switch.
        await revealSettingsSection(settingsTab, 'Terminal');
        const setting = settingsTab.getByRole('switch', {
            name: 'Let programs in the Terminal copy to your clipboard',
        });
        await expect(setting).not.toBeChecked();
        await setting.check();
        /**
         * Settings apply immediately (there is no Apply button); the observable invariant is the Runtime actually
         * persisting the change, not an arbitrary wait.
         */
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.osc52ClipboardWrite': boolean };
                }>(running.page, 'settings.get');
                return settings.value['terminal.osc52ClipboardWrite'];
            })
            .toBe(true);
        // See the comment above the earlier `Meta+w`: same tab-close replacement for the removed
        // "Close" button, needed again here to get the Terminal back before the next write.
        await running.page.keyboard.press('Meta+w');

        await typeTerminal(
            running.page,
            String.raw`printf '\033]52;c;${encoded('FIRST_WRITE')}\007\033]52;c;${encoded('RATE_BLOCKED')}\007'`,
        );
        /**
         * The second write inside the same 1s window is blocked by rate limiting, not silently dropped, and reports
         * through its own distinct message. Asserted before the clipboard poll below because an `info` toast
         * auto-dismisses after 4s (`stores/toasts.ts`) while the clipboard keeps its contents indefinitely: waiting on
         * the expiring signal first costs the durable one nothing, but not the other way round.
         */
        await expect(
            running.page.getByText(OSC52_BLOCKED_TOASTS.rateLimited, { exact: true }),
        ).toBeVisible();
        await expect.poll(() => running.clipboard.textEquals('FIRST_WRITE')).toBe(true);
        await running.clipboard.claimText('FIRST_WRITE');

        await running.page.waitForTimeout(1_050);
        await typeTerminal(running.page, osc52('%%%'));
        await typeTerminal(running.page, osc52(encoded('PRIMARY_BLOCKED'), 'p'));
        /**
         * Malformed base64 ('%%%') reports its own message; a valid write to a non-primary selection ('p') stays a
         * silent no-op, so exactly one new toast is expected here.
         */
        await expect(
            running.page.getByText(OSC52_BLOCKED_TOASTS.malformed, { exact: true }),
        ).toBeVisible();
        expect(await running.clipboard.textEquals('FIRST_WRITE')).toBe(true);

        await createAdditionalShellSession(running.page);
        const secondTerminalTab = running.page.locator(
            `${VISIBLE_SESSION} .work-tab.active[data-terminal-id]`,
        );
        const secondTerminalId = await secondTerminalTab.getAttribute('data-terminal-id');
        if (!secondTerminalId) throw new Error('Second Terminal identity was not rendered');
        await typeTerminal(running.page, osc52(encoded('SECOND_SESSION_WRITE')));
        await expect.poll(() => running.clipboard.textEquals('SECOND_SESSION_WRITE')).toBe(true);
        await running.clipboard.claimText('SECOND_SESSION_WRITE');

        await running.page.waitForTimeout(1_050);
        await running.clipboard.writeText('CLOSE_SENTINEL');
        /**
         * The sibling Terminal below keeps the Session from ending up with no tab at all and re-selects
         * `secondTerminalId`'s own tab first, so the close below stays an ordinary one that destroys the Terminal this
         * clipboard assertion tracks. Done before typing the delayed write so the 0.5s race against the close below is
         * unchanged.
         */
        await pressNewTerminal(running.page);
        await waitForNewTerminalId(running.page, [firstTerminalId, secondTerminalId]);
        await running.page.locator(`.work-tab[data-terminal-id="${secondTerminalId}"]`).click();
        await typeTerminal(
            running.page,
            `(sleep 0.5; ${osc52(encoded('CLOSED_TERMINAL_WRITE'))}) &`,
        );
        await running.app.evaluate(({ Menu }) => {
            Menu.getApplicationMenu()
                ?.getMenuItemById('command.terminal.close')
                ?.click({ triggeredByAccelerator: false });
        });
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
        expect(await running.clipboard.textEquals('CLOSE_SENTINEL')).toBe(true);

        const firstSession = sessionCard(running.page, firstSessionId);
        await firstSession.click();
        await expect(firstSession).toHaveClass(/active/);
        await running.page.waitForTimeout(1_050);

        const historicalClipboardPayload = encoded('HISTORICAL_REPLAY_WRITE');
        /**
         * Zsh's line editor redraws typed input even after `stty -echo`, so the command line itself lands in the
         * buffer. Split the payload across two printf arguments: the contiguous payload then exists only inside the OSC
         * 52 sequence, which is what must never be persisted and replayed.
         */
        const payloadSplit = Math.floor(historicalClipboardPayload.length / 2);
        await typeTerminal(
            running.page,
            String.raw`printf 'SNAPSHOT_REPLAY_VISIBLE\n'; printf '\033]52;c;%s%s\007' '${historicalClipboardPayload.slice(0, payloadSplit)}' '${historicalClipboardPayload.slice(payloadSplit)}'; exit`,
        );
        await expect(running.page.locator('[data-terminal-exit-state="stopped"]')).toBeVisible();
        await expect.poll(() => running.clipboard.textEquals('HISTORICAL_REPLAY_WRITE')).toBe(true);
        await running.clipboard.claimText('HISTORICAL_REPLAY_WRITE');
        await running.clipboard.writeText('RESTORE_SENTINEL');

        await createAdditionalShellSession(running.page);
        const liveSessionId = await selectedSessionId(running.page);
        const liveTerminalId = await running.page
            .locator(`${VISIBLE_SESSION} .work-tab.active[data-terminal-id]`)
            .getAttribute('data-terminal-id');
        if (!liveTerminalId) throw new Error('Live Terminal identity was not rendered');
        const persisted = await pageRequest<{
            encodingVersion: number;
            payload: string;
        } | null>(running.page, 'terminal.snapshot', { terminalId: firstTerminalId });
        expect(persisted).toMatchObject({ encodingVersion: 3 });
        expect(persisted?.payload).toContain('SNAPSHOT_REPLAY_VISIBLE');
        expect(persisted?.payload).not.toContain(historicalClipboardPayload);

        await firstSession.click();
        await expect(running.page.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'SNAPSHOT_REPLAY_VISIBLE',
        );
        await running.page.waitForTimeout(250);
        expect(await running.clipboard.textEquals('RESTORE_SENTINEL')).toBe(true);

        await sessionCard(running.page, liveSessionId).click();
        await expect(
            running.page.locator(`${VISIBLE_SESSION} .xterm-helper-textarea`),
        ).toBeFocused();
        await running.page.waitForTimeout(1_050);
        // Renderer copies write through Main's clipboard, so the refusal is injected there.
        await running.clipboard.refuseTextWrites();
        await typeTerminal(running.page, osc52(encoded('PERMISSION_FIXTURE')));
        const permissionToast = running.page.getByText(
            'A Terminal program could not write to the clipboard. Check diagnostics for details.',
            { exact: true },
        );
        await expect(permissionToast).toHaveCount(1);
        let clipboardDiagnostic: Record<string, unknown> | undefined;
        await expect
            .poll(async () => {
                const records = await readStructuredLog(join(userData, 'logs', 'desktop.jsonl'));
                clipboardDiagnostic = records.findLast(
                    (record) =>
                        record.event === 'renderer.terminal_osc52_clipboard_write_failed' &&
                        record.fields?.terminalId === liveTerminalId,
                )?.fields;
                return clipboardDiagnostic;
            })
            .toBeTruthy();
        expect(clipboardDiagnostic).toMatchObject({
            code: 'TERMINAL_OSC52_CLIPBOARD_WRITE_FAILED',
            errorCategory: 'error',
            terminalId: liveTerminalId,
        });
        expect(['denied', 'granted', 'prompt', 'query-failed']).toContain(
            clipboardDiagnostic?.clipboardWritePermission,
        );
        await running.page.waitForTimeout(1_050);
        await typeTerminal(running.page, osc52(encoded('SECOND_PERMISSION_FIXTURE')));
        await expect(permissionToast).toHaveCount(1);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
