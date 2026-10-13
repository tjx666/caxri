import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    clickTerminalLink,
    createShellSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

/**
 * Agent Commander workflows that hand off to the Workbench. Both reach `focusMainWindow()` in Main, which for a hidden
 * E2E launch only focuses the Workbench web contents (`bringWindowForward`): it never shows the window or takes OS
 * focus, so these tests run in the parallel-safe pool beside sibling workers.
 */

/**
 * The Commander window has no Settings surface of its own, so the failed Terminal's Open Settings must bring the
 * Workbench forward with Settings open instead of updating a dialog store nothing in this window renders. It also
 * scrolls straight to the failing Agent's own executable row (`agentCommander.openSettings`'s `target`) instead of
 * landing on Settings' default view, so the Codex executable field must already be on screen with no further
 * navigation; Settings rows outside the viewport are not in the DOM at all (virtual rendering).
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander Terminal opens Settings in the Workbench scrolled to the missing Agent executable', async ({}, testInfo) => {
    allowE2EErrors([
        { source: 'server-core', event: 'pty.spawn_failed', code: 'UNAVAILABLE', count: 1 },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-missing-cli-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        agentMode: { mode: 'blocked' },
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: '/caxri-e2e-missing', SHELL: '/usr/bin/false' },
    });
    try {
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        const failed = commander.locator('[data-terminal-exit-state="failed"]');
        await expect(failed).toContainText('Codex CLI was not found');
        await testInfo.attach('commander-missing-cli', {
            body: await failed.screenshot(),
            contentType: 'image/png',
        });

        await failed.getByRole('button', { name: 'Open Settings' }).click();
        const settingsTab = running.page.locator('[data-settings-page]');
        await expect(settingsTab).toBeVisible();
        await expect(settingsTab.getByLabel('Codex executable')).toBeVisible();
        await testInfo.attach('workbench-settings-from-commander', {
            body: await running.page.screenshot(),
            contentType: 'image/png',
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * A commit link opens the Workbench Git view, which the Commander window does not have, so its Terminal never offers
 * one. A URL still opens in the browser as before. A file link is different: the Commander now hands it to the
 * Workbench through `agentCommander.openFileLink` instead of the ordinary `terminal.openFileLink`, so the file must be
 * inside a Project some visible Session already has open (here the same `root` the Shell Session below uses) and it
 * opens there, never through the Commander's own hidden system Project.
 *
 * The link is printed as an absolute path rather than a bare `notes.md:3`. The Commander's own Terminal's Workbench
 * Root is its hidden system Project, and `terminal.fileLink.resolve`'s bare-relative fallback only searches that
 * Terminal's own Workbench Root by suffix (see `apps/server/src/domains/terminal/file-links.ts`); a real bare relative
 * link from the Commander would never match a file that lives in a different, visible Project. An absolute path (or a
 * `~/...` one) is matched by containment across every added Project instead, which is what a real Commander transcript
 * (quoting an absolute path from a delegated Session's own output) would actually contain.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander Terminal links URLs and files, opening a file through the Workbench', async ({}, testInfo) => {
    const directory = await realpath(await mkdtemp(`${tmpdir()}/caxri-commander-links-e2e-`));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const notesPath = join(root, 'notes.md');
    await writeFile(notesPath, 'first line\nsecond line\nthird line\n');
    const fileLink = `${notesPath}:3`;
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: { startupOutput: `Edited ${fileLink} see https://example.com/commander` },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        const pane = commander.locator('.terminal-pane');
        await expect(pane.locator('.xterm-rows')).toContainText('https://example.com/commander');

        await pane.locator('.xterm-screen').click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Open Detected Link…');
        const picker = commander.getByRole('dialog', { name: 'Open Detected Link' });
        await expect(
            picker.getByRole('option', {
                name: 'Open external link https://example.com/commander',
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            picker.getByRole('option', { name: `Open file link ${fileLink}`, exact: true }),
        ).toBeVisible();
        await expect(picker.getByRole('option')).toHaveCount(2);
        await testInfo.attach('commander-detected-links', {
            body: await commander.screenshot(),
            contentType: 'image/png',
        });
        await commander.keyboard.press('Escape');

        await clickTerminalLink(commander, fileLink);
        await expect(running.page.getByRole('tab', { name: 'notes.md' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 3/)).toBeVisible();
        await testInfo.attach('commander-file-link-opened-in-workbench', {
            body: await running.page.screenshot(),
            contentType: 'image/png',
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
