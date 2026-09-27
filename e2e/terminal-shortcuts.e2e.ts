import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings } from '@caxri/protocol';
import { MAX_TERMINAL_INPUT_LENGTH, MAX_TERMINAL_INPUT_PAYLOAD_LENGTH } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { stubAppQuitDecision } from './support/app-quit.ts';
import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    createShellSession,
    launchCaxri,
    openSettingsTab,
    pageReply,
    pageRequest,
    pressNewTerminal,
    splitTerminalToRight,
    typeTerminal,
    waitForNewTerminalId,
} from './support/helpers.ts';

async function terminalIds(page: Page): Promise<string[]> {
    const state = await pageRequest<{ terminals: Array<{ id: string }> }>(page, 'app.bootstrap');
    return state.terminals.map((terminal) => terminal.id);
}

/**
 * A tab whose Terminal the Runtime no longer owns renders an empty pane that no close reaches, so tab identity — not
 * tab count — is what proves the layout stayed consistent.
 *
 * Polled rather than sampled once: a close that overtakes its own create legitimately shows the doomed tab for a frame
 * or two, and only a tab that is still orphaned once the system settles is the defect.
 */
async function expectNoOrphanTabs(page: Page): Promise<void> {
    await expect
        .poll(async () => {
            const tabbed = await page
                .locator('.work-tab[data-terminal-id]')
                .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.terminalId));
            const owned = new Set(await terminalIds(page));
            return tabbed.filter((id) => id === undefined || !owned.has(id));
        })
        .toEqual([]);
}

async function sessionStateOf(page: Page): Promise<unknown> {
    const bootstrap = await pageRequest<{
        selectedSessionId?: string;
        sessionStates: Array<{ sessionId: string }>;
    }>(page, 'app.bootstrap');
    return bootstrap.sessionStates.find(
        (candidate) => candidate.sessionId === bootstrap.selectedSessionId,
    );
}

/**
 * The Session state the selected Session currently holds, asserted to still carry `terminalId` so the caller cannot
 * silently capture a layout that never contained the Terminal whose removal it is about to race.
 */
async function sessionStateCarrying(page: Page, terminalId: string): Promise<unknown> {
    const state = await sessionStateOf(page);
    expect(JSON.stringify(state)).toContain(terminalId);
    return state;
}

async function removeQuitTestDirectory(path: string): Promise<void> {
    await expect
        .poll(async () => {
            try {
                await rm(path, { recursive: true, force: true });
                return true;
            } catch (error) {
                if (
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    Reflect.get(error, 'code') === 'ENOTEMPTY'
                )
                    return false;
                throw error;
            }
        })
        .toBe(true);
}

test('Command+Shift+K and Command+T/W affect only the active Terminal and pause behind modals', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-shortcuts-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const firstTerminalId = (await terminalIds(running.page))[0];
        await typeTerminal(running.page, String.raw`printf 'FIRST_MARKER\n'`, firstTerminalId);
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('FIRST_MARKER');

        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        await expect(running.page.locator('.terminal-pane')).toHaveCount(2);
        await typeTerminal(running.page, String.raw`printf 'SECOND_MARKER\n'`, secondTerminalId);
        await running.page
            .locator(`.work-tab[data-terminal-id="${firstTerminalId}"] [role="tab"]`)
            .click();
        // Clear Terminal is gated on `terminalFocus` so it cannot shadow Monaco's own Cmd+Shift+K (Delete Line);
        // clicking the tab leaves focus on the tab button, so the xterm has to take it back first.
        await running.page
            .locator(`.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-helper-textarea`)
            .focus();
        await running.page.keyboard.press('Meta+Shift+K');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).not.toContainText('FIRST_MARKER');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('SECOND_MARKER');
        await typeTerminal(running.page, String.raw`printf 'AFTER_CLEAR\n'`, firstTerminalId);
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('AFTER_CLEAR');

        await running.page.keyboard.press('Meta+T');
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(3);
        const openedTab = running.page.locator('.workbench-pane.active .work-tab.active');
        await expect(openedTab).toHaveAttribute('data-terminal-id', /.+/);
        /**
         * A new Terminal's pane attaches its PTY asynchronously (`use-terminal-pane-runtime.ts`). Pressing `Meta+W`
         * before that round-trip resolves queues `terminal.close` behind it on the Server's ordered command queue
         * (`apps/server/src/core/control-server.ts`) and the tab is still open when the assertion below runs — a race
         * no human could hit by hand, but one Playwright's instant keypress does under CI's contended pool. Mirrors the
         * same wait in `session-title.e2e.ts`.
         */
        const openedTerminalId = await openedTab.getAttribute('data-terminal-id');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${openedTerminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        await running.page.keyboard.press('Meta+W');
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);

        await running.page.locator('.project-heading').hover();
        await running.page.getByRole('button', { name: /^New Session in / }).click();
        // The Terminal choice is an anchored menu, which registers as a modal for the same reason a dialog does: it
        // traps focus, so app-wide Terminal shortcuts must stand down while it owns the keyboard.
        const createMenu = running.page.getByRole('menu');
        await expect(createMenu).toBeVisible();
        // Not Cmd+Shift+K: the menu owns focus, so `terminalFocus` is already false and the press would prove nothing
        // about the modal. Cmd+T and Cmd+W are ungated and do exercise the stand-down.
        await running.page.keyboard.press('Meta+T');
        await running.page.keyboard.press('Meta+W');
        await expect(createMenu).toBeVisible();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        await running.page.keyboard.press('Escape');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('AFTER_CLEAR');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Cmd+Backslash opens fresh Terminals in right panes and keeps the newest pane focused', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-split-shortcut-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const firstTerminalId = (await terminalIds(running.page))[0];

        const beforeSecondSplit = await terminalIds(running.page);
        await running.page.keyboard.press('Meta+\\');
        const secondTerminalId = await waitForNewTerminalId(running.page, beforeSecondSplit);
        await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${secondTerminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        await expect(
            running.page
                .locator('.workbench-pane')
                .nth(0)
                .locator(`.terminal-pane[data-terminal-id="${firstTerminalId}"]`),
        ).toBeVisible();
        await expect(
            running.page
                .locator('.workbench-pane')
                .nth(1)
                .locator(`.terminal-pane[data-terminal-id="${secondTerminalId}"]`),
        ).toBeVisible();
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-helper-textarea`,
            ),
        ).toBeFocused();

        const beforeThirdSplit = await terminalIds(running.page);
        await running.page.keyboard.press('Meta+\\');
        const thirdTerminalId = await waitForNewTerminalId(running.page, beforeThirdSplit);
        await expect(running.page.locator('.workbench-pane')).toHaveCount(3);
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${thirdTerminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        await expect(
            running.page
                .locator('.workbench-pane')
                .nth(0)
                .locator(`.terminal-pane[data-terminal-id="${firstTerminalId}"]`),
        ).toBeVisible();
        await expect(
            running.page
                .locator('.workbench-pane')
                .nth(1)
                .locator(`.terminal-pane[data-terminal-id="${secondTerminalId}"]`),
        ).toBeVisible();
        await expect(
            running.page
                .locator('.workbench-pane')
                .nth(2)
                .locator(`.terminal-pane[data-terminal-id="${thirdTerminalId}"]`),
        ).toBeVisible();
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${thirdTerminalId}"] .xterm-helper-textarea`,
            ),
        ).toBeFocused();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * `Cmd+T` immediately followed by `Cmd+W` can send a layout write that still carries the Terminal the very next command
 * deletes. Whether the two round-trips actually interleave that way depends on machine load — it reproduced on CI's
 * contended pool and never on an idle laptop — so the interleaving is driven here instead of waited for: the layout
 * captured while both tabs existed is replayed after the close, which is byte-for-byte the write the losing race
 * sends.
 *
 * Only a real Electron run proves the transport and persistence half: the write crosses Desktop and Server, and no unit
 * test can show that the Runtime prunes a stale placement before storing it. The Renderer's own two defences —
 * declining to re-place a Terminal closed mid-creation, and adopting the Runtime's pruned canonical state — are covered
 * narrowly in `terminal-commands.test.ts` and `workbench-session-state.test.ts`, because the replay below bypasses the
 * Renderer's create path by sending the layout straight over IPC.
 */
test('a Terminal closed while its layout write was in flight leaves no tab behind', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-close-race-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const tabs = running.page.locator('.work-tab[data-terminal-id]');
        await expect(tabs).toHaveCount(1);
        const firstTerminalId = (await terminalIds(running.page))[0];

        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        await expect(tabs).toHaveCount(2);
        const staleState = await sessionStateCarrying(running.page, secondTerminalId);

        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${secondTerminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        await running.page.keyboard.press('Meta+W');
        await expect(tabs).toHaveCount(1);

        // The write the slower Renderer would still be sending. A client layout is a view preference, never authority
        // over which Terminals exist, so this must not bring the closed Terminal's tab back. Closing the Terminal
        // advanced the stored revision, so the Runtime now refuses the whole write instead of reconciling it, and the
        // caller re-derives from the current state.
        const reply = await pageReply(running.page, 'session.updateState', staleState);
        expect(reply.ok).toBe(false);
        expect(reply.ok ? undefined : reply.error.code).toBe('CONFLICT');
        await expect(tabs).toHaveCount(1);
        await expectNoOrphanTabs(running.page);
        // The Renderer declines to render a tab whose Terminal is gone, so the layout the Runtime actually stored is
        // what has to be inspected: a resurrected placement is invisible until the next reload replays it.
        await expect
            .poll(async () =>
                JSON.stringify(await sessionStateOf(running.page)).includes(secondTerminalId),
            )
            .toBe(false);

        // The layout the Runtime persisted is what a reload replays; an orphan tab that only lived in Renderer state
        // would disappear here and hide the defect.
        await running.page.reload();
        await expect(tabs).toHaveCount(1);
        await expectNoOrphanTabs(running.page);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Codex Terminal maps input shortcuts and restores the clipboard on quit', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-input-shortcuts-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capture = join(testDirectory, 'agent-input.hex');
    await Promise.all([mkdir(root), writeFile(capture, '')]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                startupOutput: 'FAKE_CODEX_READY\r\n',
                inputCapture: { path: capture, encoding: 'hex', echoPrefix: 'INPUT_HEX:' },
            },
        },
    });

    const running = await launchCaxri({
        agentMode,
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    let isClosed = false;
    try {
        await createProjectSession(running.page, 'codex');
        const input = running.page.locator('.xterm-helper-textarea');
        const rows = running.page.locator('.xterm-rows');
        await expect(rows).toContainText('FAKE_CODEX_READY');
        await input.focus();

        const keybindings = await pageRequest<{
            value: Array<{
                args?: Record<string, unknown>;
                command: string;
                key: string;
                when?: 'terminalFocus';
            }>;
        }>(running.page, 'keybindings.get');
        expect(keybindings.value).toContainEqual({
            args: { text: '\t\n' },
            command: 'workbench.action.terminal.sendSequence',
            key: 'cmd+shift+enter',
            when: 'terminalFocus',
        });
        await pageRequest(running.page, 'keybindings.update', {
            source: JSON.stringify(
                [
                    ...keybindings.value,
                    {
                        args: { text: '\u{1B}[1;3B' },
                        command: 'workbench.action.terminal.sendSequence',
                        key: 'cmd+enter',
                        when: 'terminalFocus',
                    },
                ],
                null,
                2,
            ),
        });
        const keybindingsTab = await openSettingsTab(running.page);
        await keybindingsTab.getByRole('tab', { name: 'Keybindings', exact: true }).click();
        await keybindingsTab.getByLabel('Search keyboard shortcuts').fill('send sequence');
        await expect(keybindingsTab.locator('[data-shortcut="cmd+enter"]')).toBeVisible();
        await expect(keybindingsTab.locator('[data-shortcut="cmd+shift+enter"]')).toBeVisible();
        // Settings is a Workbench tab now, not a modal (issue caxri#1289), and it occupies
        // the same pane the Terminal does: close it outright so the Terminal below is mounted
        // again for `input.focus()` to find.
        await running.page.keyboard.press('Meta+w');
        await input.focus();

        await input.press('Meta+Shift+Enter');
        await expect(rows).toContainText('INPUT_HEX:090d');
        await input.press('Meta+Enter');
        await expect(rows).toContainText('INPUT_HEX:1b5b313b3342');

        await input.press('Shift+Enter');
        await expect(rows).toContainText('INPUT_HEX:1b0d');
        await input.press('Meta+ArrowLeft');
        await expect(rows).toContainText('INPUT_HEX:01');
        expect(await rows.textContent()).not.toContain('INPUT_HEX:1b0dINPUT_HEX:0d');
        await input.press('Meta+ArrowRight');
        await expect(rows).toContainText('INPUT_HEX:05');

        await running.clipboard.writePngBase64(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        );
        await input.press('Meta+V');
        await expect(rows).toContainText('INPUT_HEX:16');

        await running.clipboard.writeText('TEXT_PASTE');
        await input.press('Meta+V');
        await expect(rows).toContainText('INPUT_HEX:544558545f5041535445');

        const closed = running.app.waitForEvent('close');
        try {
            /**
             * Bypass the wrapped Playwright close path to prove Main's `before-quit` guardian restores the clipboard.
             */
            await stubAppQuitDecision(running.app, 'stop');
            await running.app.evaluate(({ app }) => app.quit());
        } catch {
            // The evaluation transport may close before returning because quitting is the operation under test.
        }
        await closed;
        await running.app.close();
        isClosed = true;
        expect(await running.clipboard.restoreOutcome()).toMatchObject({ status: 'restored' });
    } finally {
        if (!isClosed) {
            try {
                await running.app.close();
            } catch {
                // Ignore close failures during cleanup.
            }
        }
        await removeQuitTestDirectory(testDirectory);
    }
});

test('Codex Terminal preserves an oversized bracketed paste across private input frames', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-oversized-paste-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capture = join(testDirectory, 'agent-input.raw');
    await Promise.all([mkdir(root), writeFile(capture, '')]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                startupOutput: '\u{1B}[?2004hFAKE_CODEX_READY\r\n',
                inputCapture: { path: capture, encoding: 'raw' },
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        /**
         * This test isolates raw PTY input framing, so opt out of the user-facing long-paste transformation before
         * launching the Agent Terminal whose captured bytes are asserted below.
         */
        const currentSettings = await pageRequest<{ value: AppSettings }>(
            running.page,
            'settings.get',
        );
        const settings = structuredClone(currentSettings.value);
        settings['terminal.longPasteThreshold'] = MAX_TERMINAL_INPUT_PAYLOAD_LENGTH - 12;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings, null, 2),
        });
        await createProjectSession(running.page, 'codex');
        const input = running.page.locator('.xterm-helper-textarea');
        await expect(running.page.locator('.xterm-rows')).toContainText('FAKE_CODEX_READY');
        await input.focus();

        /**
         * The emoji's surrogate pair straddles the first private-frame boundary after xterm adds its prefix.
         */
        const paste = `${'x'.repeat(MAX_TERMINAL_INPUT_LENGTH - 7)}🙂\nPASTE_END`;
        /**
         * Xterm normalizes clipboard line feeds to the carriage returns expected by a PTY.
         */
        const expected = Buffer.from(`\u{1B}[200~${paste.replaceAll('\n', '\r')}\u{1B}[201~`);
        await running.clipboard.writeText(paste);
        await input.press('Meta+V');

        await expect.poll(async () => (await stat(capture)).size).toBe(expected.byteLength);
        const captured = await readFile(capture);
        expect(createHash('sha256').update(captured).digest('hex')).toBe(
            createHash('sha256').update(expected).digest('hex'),
        );
        await expect(running.page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
