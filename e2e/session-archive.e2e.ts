import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    openSettingsTab,
    pageRequest,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';
import { runningWork } from './support/running-work.ts';

const MESSAGE_BOX_CALL_COUNT_KEY = '__caxriE2EMessageBoxCallCount';

async function stubMessageBoxResponse(app: E2EApp, response: number): Promise<void> {
    await app.evaluate(({ dialog }, nextResponse) => {
        Reflect.set(globalThis, '__caxriE2EMessageBoxCallCount', 0);
        dialog.showMessageBox = () => {
            const calls = Number(Reflect.get(globalThis, '__caxriE2EMessageBoxCallCount') ?? 0);
            Reflect.set(globalThis, '__caxriE2EMessageBoxCallCount', calls + 1);
            return Promise.resolve({ response: nextResponse, checkboxChecked: false });
        };
    }, response);
}

/**
 * A row that remains visible does not prove its canceled deletion request completed. Wait until Main consumes the
 * native-dialog response before replacing the stub for a subsequent request.
 */
async function waitForMessageBoxCall(app: E2EApp): Promise<void> {
    await expect
        .poll(() =>
            app.evaluate(
                (_electron, key) => Number(Reflect.get(globalThis, key) ?? 0),
                MESSAGE_BOX_CALL_COUNT_KEY,
            ),
        )
        .toBe(1);
}

test('Session archive hides active navigation, parks its Terminals, and restores on selection', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-archive-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        await pageRequest(running.page, 'session.rename', {
            sessionId: secondSessionId,
            displayTitle: 'Archived investigation',
        });
        await expect(sessionCard(running.page, secondSessionId)).toContainText(
            'Archived investigation',
        );
        await expect(running.page.locator('.session-card')).toHaveCount(2);
        const runningCount = () => runningWork(running.page);
        const runningBeforeArchive = await runningCount();

        const secondRow = sessionCard(running.page, secondSessionId).locator('..');
        await secondRow.hover();
        await secondRow.getByRole('button', { name: /^Archive / }).click();

        await expect(sessionCard(running.page, secondSessionId)).toHaveCount(0);
        await expect(sessionCard(running.page, firstSessionId)).toHaveClass(/active/);
        // An archived Session has no viewer, so its live Terminal is parked (suspended) rather than kept resident.
        await expect.poll(runningCount).toEqual({
            ...runningBeforeArchive,
            terminals: runningBeforeArchive.terminals - 1,
        });
        await expect(running.page.locator('.project-group .archived-sessions')).toHaveCount(0);
        const archivedEntry = running.page.locator('aside .archived-sessions-entry');
        await expect(archivedEntry).toHaveAccessibleName('Archived Sessions (1)');
        await archivedEntry.click();
        const dialog = running.page.getByRole('dialog');
        await expect(dialog.getByRole('heading', { name: 'Archived Sessions' })).toBeVisible();
        await dialog.getByLabel('Search').fill('investigation');
        await dialog.getByLabel('Filter by Project').click();
        await running.page.getByRole('option', { name: 'project', exact: true }).click();
        await dialog.getByLabel('Filter by Agent').click();
        await running.page.getByRole('option', { name: 'Shell', exact: true }).click();
        await expect(dialog.locator('.archived-manager-row')).toHaveCount(1);
        const restore = dialog.getByRole('button', { name: 'Restore Archived investigation' });
        await restore.click();

        await expect(running.page.locator('.session-card')).toHaveCount(2);
        await dialog.getByRole('button', { name: 'Done' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(archivedEntry).toHaveAccessibleName('Archived Sessions (0)');
        // Restoring alone leaves the Terminal parked; selecting the Session relaunches it.
        await sessionCard(running.page, secondSessionId).click();
        await expect(sessionCard(running.page, secondSessionId)).toHaveClass(/active/);
        await expect.poll(runningCount).toEqual(runningBeforeArchive);
        const snapshot = await pageRequest<{
            sessions: Array<{ archivedAt?: number; id: string }>;
        }>(running.page, 'app.bootstrap');
        expect(
            snapshot.sessions.find((session) => session.id === secondSessionId)?.archivedAt,
        ).toBe(undefined);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Archived Sessions manager deletes only after native confirmation', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-archive-delete-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await createAdditionalShellSession(running.page);
        const archivedSessionId = await selectedSessionId(running.page);

        const archivedSourceRow = sessionCard(running.page, archivedSessionId).locator('..');
        await archivedSourceRow.hover();
        await archivedSourceRow.getByRole('button', { name: /^Archive / }).click();
        await expect(sessionCard(running.page, archivedSessionId)).toHaveCount(0);

        // The manager's global entry point lives in Settings now, not in the primarySidebar.
        const settingsTab = await openSettingsTab(running.page);
        await settingsTab.locator('.archived-sessions-entry').click();
        // The manager is its own dialog, floating over the Settings tab like any other modal
        // opened over a document (issue caxri#1289): Settings is a Workbench tab now, not a
        // dialog, so there is no modal layer for it to close first; it stays open underneath.
        await expect(settingsTab).toBeVisible();
        const dialog = running.page.getByRole('dialog');
        const archivedRow = dialog.locator('.archived-manager-row');
        await expect(archivedRow).toHaveCount(1);
        const archivedRowDeleteButton = archivedRow.getByRole('button', { name: /^Delete / });
        await expect(archivedRowDeleteButton).toBeVisible();

        // Cancel keeps the archived row.
        await stubMessageBoxResponse(running.app, 1);
        await archivedRowDeleteButton.click();
        await waitForMessageBoxCall(running.app);
        await expect(archivedRow).toHaveCount(1);

        // Confirm removes the archived row and the now-empty Archived group.
        await stubMessageBoxResponse(running.app, 0);
        await archivedRowDeleteButton.click();

        await expect(archivedRow).toHaveCount(0);
        await expect(dialog.getByText('No archived Sessions yet')).toBeVisible();
        await dialog.getByRole('button', { name: 'Done' }).click();
        await expect(dialog).toHaveCount(0);
        // Deleting the last archived Session clears the primarySidebar's per-Project archived badge.
        await expect(running.page.locator('.project-archived-count')).toHaveCount(0);
        const snapshot = await pageRequest<{ sessions: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        expect(
            snapshot.sessions.find((session) => session.id === archivedSessionId),
        ).toBeUndefined();
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Cmd+W on a Session’s last Terminal tab closes the Terminal and leaves the Session open', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-archive-close-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        const bootstrap = () =>
            pageRequest<{ terminals: Array<{ id: string; sessionId: string }> }>(
                running.page,
                'app.bootstrap',
            );
        const secondTerminalIds = (await bootstrap()).terminals
            .filter((terminal) => terminal.sessionId === secondSessionId)
            .map((terminal) => terminal.id);
        expect(secondTerminalIds).toHaveLength(1);
        /**
         * The pane attaches its PTY asynchronously; waiting for it keeps the keypress from racing that attach, as in
         * `terminal-shortcuts.e2e.ts`.
         */
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${secondTerminalIds[0]}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();

        await running.page.keyboard.press('Meta+W');

        // The Terminal closes, but Cmd+W never archives: the Session stays selected, listed, and empty.
        await expect
            .poll(async () =>
                (await bootstrap()).terminals.filter(
                    (terminal) => terminal.sessionId === secondSessionId,
                ),
            )
            .toHaveLength(0);
        await expect(sessionCard(running.page, secondSessionId)).toHaveClass(/active/);
        await expect(running.page.locator('aside .archived-sessions-entry')).toHaveCount(0);
        expect((await bootstrap()).terminals.map((terminal) => terminal.id)).toContain(
            secondTerminalIds[0],
        );
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
