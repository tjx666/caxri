import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';
import { listPaneTerminalIds } from '@caxri/protocol';

import type { E2EApp } from './support/electron-app.ts';
import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    sessionCard,
    VISIBLE_SESSION,
    waitForNewTerminalId,
} from './support/helpers.ts';
import {
    chooseContextMenuItem,
    dismissContextMenu,
    isContextMenuItemEnabled,
} from './support/native-context-menu.ts';

/**
 * `:not([inert])` because Move to New Session leaves the source Session's tab behind as an exit-animation ghost with
 * the same Terminal id, and Session keep-alive now holds that Session mounted instead of unmounting it on the switch —
 * so for the length of the animation one Terminal really does have two tabs in the DOM. Only one of them is real.
 */
function terminalTab(page: Page, terminalId: string) {
    return page.locator(
        `${VISIBLE_SESSION} .work-tab:not([inert])[data-terminal-id="${terminalId}"]`,
    );
}

async function isMoveActionEnabled(app: E2EApp, page: Page, terminalId: string) {
    await terminalTab(page, terminalId).click({ button: 'right' });
    return isContextMenuItemEnabled(app, 'Move to New Session');
}

async function typeInTerminal(page: Page, terminalId: string, command: string): Promise<void> {
    const input = page.locator(
        `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`,
    );
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

test('Move to New Session keeps the live Terminal and disables the only-tab action', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-move-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const initial = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const sourceSessionId = initial.selectedSessionId;
        const firstTerminalId = initial.terminals[0]?.id;
        const sourceSession = initial.sessions.find(({ id }) => id === sourceSessionId);
        if (!sourceSessionId || !sourceSession || !firstTerminalId)
            throw new Error('Initial Session and Terminal were not created');

        expect(await isMoveActionEnabled(running.app, running.page, firstTerminalId)).toBe(false);
        await dismissContextMenu(running.app);
        const afterDisabledActivation = await pageRequest<BootstrapState>(
            running.page,
            'app.bootstrap',
        );
        expect(afterDisabledActivation.selectedSessionId).toBe(sourceSessionId);
        expect(afterDisabledActivation.sessions.map(({ id }) => id)).toEqual(
            initial.sessions.map(({ id }) => id),
        );
        expect(afterDisabledActivation.terminals).toEqual(initial.terminals);

        await pressNewTerminal(running.page);
        const movedTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        const beforeMove = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const movedBefore = beforeMove.terminals.find(({ id }) => id === movedTerminalId);
        expect(movedBefore?.sessionId).toBe(sourceSessionId);
        expect(typeof movedBefore?.processId).toBe('number');
        await typeInTerminal(running.page, movedTerminalId, 'export CAXRI_MOVE_SENTINEL=preserved');
        await typeInTerminal(
            running.page,
            movedTerminalId,
            String.raw`printf 'BEFORE_MOVE_%s\n' "$CAXRI_MOVE_SENTINEL"`,
        );
        const movedRows = running.page.locator(
            `.terminal-pane[data-terminal-id="${movedTerminalId}"] .xterm-rows`,
        );
        await expect(movedRows).toContainText('BEFORE_MOVE_preserved');

        expect(await isMoveActionEnabled(running.app, running.page, movedTerminalId)).toBe(true);
        await chooseContextMenuItem(running.app, 'Move to New Session');

        let settled: BootstrapState | undefined;
        await expect
            .poll(async () => {
                const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
                const moved = state.terminals.find(({ id }) => id === movedTerminalId);
                if (
                    state.selectedSessionId === sourceSessionId ||
                    moved?.sessionId !== state.selectedSessionId
                )
                    return false;
                settled = state;
                return true;
            })
            .toBe(true);
        const movedSessionId = settled!.selectedSessionId!;
        const movedAfter = settled!.terminals.find(({ id }) => id === movedTerminalId);
        const sourceSessionAfter = settled!.sessions.find(({ id }) => id === sourceSessionId);
        const movedSession = settled!.sessions.find(({ id }) => id === movedSessionId);
        const sourceState = settled!.sessionStates.find(
            ({ sessionId }) => sessionId === sourceSessionId,
        );
        const movedState = settled!.sessionStates.find(
            ({ sessionId }) => sessionId === movedSessionId,
        );
        expect(movedAfter).toMatchObject({
            id: movedTerminalId,
            processId: movedBefore!.processId,
            sessionId: movedSessionId,
        });
        expect(sourceSessionAfter).toMatchObject({
            id: sourceSessionId,
            projectId: sourceSession.projectId,
        });
        expect(movedSession).toMatchObject({
            id: movedSessionId,
            projectId: sourceSession.projectId,
        });
        expect(sourceState).toBeDefined();
        expect(movedState).toBeDefined();
        expect(listPaneTerminalIds(sourceState!.paneLayout)).toEqual([firstTerminalId]);
        expect(listPaneTerminalIds(movedState!.paneLayout)).toEqual([movedTerminalId]);
        await expect(sessionCard(running.page, movedSessionId)).toHaveClass(/active/);
        await expect(terminalTab(running.page, movedTerminalId).getByRole('tab')).toHaveAttribute(
            'aria-selected',
            'true',
        );

        await typeInTerminal(
            running.page,
            movedTerminalId,
            String.raw`printf 'AFTER_MOVE_%s\n' "$CAXRI_MOVE_SENTINEL"`,
        );
        await expect(movedRows).toContainText('AFTER_MOVE_preserved');
        expect(await pageRequest(running.page, 'terminal.runningCount')).toBe(2);

        expect(await isMoveActionEnabled(running.app, running.page, movedTerminalId)).toBe(false);
        await dismissContextMenu(running.app);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
