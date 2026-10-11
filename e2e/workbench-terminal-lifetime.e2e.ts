import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState, TerminalRecord } from '@caxri/protocol';
import { createPaneLayout } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    waitForNewTerminalId,
} from './support/helpers.ts';

test('Workbench Root switches preserve the visible Terminal view and input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-root-lifetime-'));
    const root = join(await realpath(directory), 'owner');
    const worktree = join(await realpath(directory), 'worktree');
    await mkdir(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'fixture.txt'), 'fixture\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await execFileAsync('git', ['worktree', 'add', '-b', 'feature/other', worktree], { cwd: root });
    const worktreeFolder = join(worktree, 'packages');
    await mkdir(worktreeFolder);

    const running = await launchCaxri({
        userDataDir: join(directory, 'profile'),
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const before = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const terminal = before.terminals[0];
        const input = running.page.locator('.terminal-pane .xterm-helper-textarea');
        await expect(
            running.page.locator('.terminal-pane [data-terminal-attached]'),
        ).toHaveAttribute('data-terminal-attached', 'true');
        const original = await input.elementHandle();
        await input.focus();
        await input.press('Meta+f');
        const search = running.page.getByRole('textbox', { name: 'Find in Terminal', exact: true });
        await search.fill('retained-search');

        await running.page
            .getByRole('combobox', { name: /^Switch Workbench Root from owner/ })
            .click();
        await running.page
            .getByRole('option', { name: 'feature/other, Authorize', exact: true })
            .click();
        await running.page
            .getByRole('dialog', { name: 'Authorize worktree?' })
            .getByRole('button', { name: 'Authorize and switch', exact: true })
            .click();
        await expect(
            running.page.getByRole('combobox', { name: /^Switch Workbench Root from worktree/ }),
        ).toBeVisible();
        expect(await original.evaluate((element) => element.isConnected)).toBe(true);
        expect(await input.evaluate((element, previous) => element === previous, original)).toBe(
            true,
        );
        await expect(search).toHaveValue('retained-search');

        const switched = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const state = switched.sessionStates.find(
            ({ sessionId }) => sessionId === before.selectedSessionId,
        )!;
        const filePane = createPaneLayout({
            kind: 'file',
            path: join(worktree, 'fixture.txt'),
        }).root;
        await pageRequest(running.page, 'session.updateState', {
            ...state,
            paneLayout: {
                activePaneId: state.paneLayout.activePaneId,
                root: {
                    type: 'split',
                    id: 'fixture-split',
                    direction: 'horizontal',
                    ratio: 0.5,
                    first: filePane,
                    second: state.paneLayout.root,
                },
            },
        });
        // updateState replies to its optimistic caller without a broadcast; converge this fixture explicitly.
        await pageRequest(running.page, 'session.select', { sessionId: state.sessionId });
        await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
        expect(await original.evaluate((element) => element.isConnected)).toBe(true);
        await expect(search).toHaveValue('retained-search');

        await running.page
            .getByRole('combobox', { name: /^Switch Workbench Root from worktree/ })
            .click();
        await running.page
            .getByRole('option', { name: 'main, Main worktree', exact: true })
            .click();
        await expect(
            running.page.getByRole('combobox', { name: /^Switch Workbench Root from owner/ }),
        ).toBeVisible();
        await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
        expect(await original.evaluate((element) => element.isConnected)).toBe(true);
        await expect(search).toHaveValue('retained-search');
        await running.page.getByRole('button', { name: 'Close Find', exact: true }).click();
        await input.focus();
        await input.pressSequentially(String.raw`printf 'ROOT_%s_OK\n' SWITCH_INPUT`);
        await input.press('Enter');
        await expect(running.page.locator('.terminal-pane .xterm-rows')).toContainText(
            'ROOT_SWITCH_INPUT_OK',
        );
        const after = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(after.terminals.find(({ id }) => id === terminal.id)?.processId).toBe(
            terminal.processId,
        );
        await running.page
            .locator('.workbench')
            .screenshot({ path: test.info().outputPath('terminal-root-returned.png') });

        await running.page
            .getByRole('combobox', { name: /^Switch Workbench Root from owner/ })
            .click();
        await running.page.getByRole('option', { name: 'feature/other', exact: true }).click();
        await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
        await expect(running.page.getByRole('tab', { name: /fixture.txt/ })).toBeVisible();
        expect(await original.evaluate((element) => element.isConnected)).toBe(true);

        await pressNewTerminal(running.page);
        const newTerminalId = await waitForNewTerminalId(running.page, [terminal.id]);
        const withWorktreeTerminal = await pageRequest<BootstrapState>(
            running.page,
            'app.bootstrap',
        );
        expect(withWorktreeTerminal.terminals.find(({ id }) => id === newTerminalId)?.cwd).toBe(
            worktree,
        );
        expect(withWorktreeTerminal.terminals.find(({ id }) => id === terminal.id)).toMatchObject({
            cwd: root,
            processId: terminal.processId,
        });
        const explicitWorktreeTerminal = await pageRequest<TerminalRecord>(
            running.page,
            'terminal.create',
            {
                sessionId: state.sessionId,
                kind: 'shell',
                cwd: worktreeFolder,
            },
        );
        expect(explicitWorktreeTerminal.cwd).toBe(worktreeFolder);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
