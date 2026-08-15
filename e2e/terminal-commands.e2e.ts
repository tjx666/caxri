import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
    splitTerminalToRight,
    typeTerminal,
    waitForNewTerminalId,
} from './support/helpers.ts';

function terminalSurface(page: Page, terminalId: string): Locator {
    return page.locator(`.terminal-pane[data-terminal-id="${terminalId}"] .terminal-surface`);
}

function terminalCommandStatus(page: Page, terminalId: string): Locator {
    return page.locator(
        `.terminal-pane[data-terminal-id="${terminalId}"] .terminal-command-status`,
    );
}

async function activeTerminalId(page: Page): Promise<string> {
    const terminalId = await page
        .locator('.work-tab.active[data-terminal-id]')
        .getAttribute('data-terminal-id');
    if (!terminalId) throw new Error('Active Terminal ID was not rendered');
    return terminalId;
}

async function typeInTerminal(page: Page, terminalId: string, command: string): Promise<void> {
    const input = page.locator(
        `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`,
    );
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

async function expectCommandState(
    surface: Locator,
    expected: { commandCount: number; completedCount: number; lastExitStatus?: number },
): Promise<void> {
    await expect(surface).toHaveAttribute(
        'data-terminal-command-count',
        String(expected.commandCount),
    );
    await expect(surface).toHaveAttribute(
        'data-terminal-command-completed-count',
        String(expected.completedCount),
    );
    if (expected.lastExitStatus === undefined)
        await expect(surface).not.toHaveAttribute('data-terminal-command-last-exit-status', /.+/u);
    else
        await expect(surface).toHaveAttribute(
            'data-terminal-command-last-exit-status',
            String(expected.lastExitStatus),
        );
}

test('zsh command boundaries survive scrollback, split resize, Session switches, and reload', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-commands-zsh-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({
        env: { SHELL: '/bin/zsh' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        const firstTerminalId = await activeTerminalId(running.page);
        const firstSurface = terminalSurface(running.page, firstTerminalId);
        await expectCommandState(firstSurface, { commandCount: 0, completedCount: 0 });

        await typeTerminal(
            running.page,
            String.raw`for value in {1..120}; do printf 'COMMAND_NAV_%03d\n' "$value"; done`,
        );
        await expectCommandState(firstSurface, {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });
        await expect(terminalCommandStatus(running.page, firstTerminalId)).toHaveText(
            'Command completed successfully.',
        );
        await typeTerminal(running.page, 'false');
        await expectCommandState(firstSurface, {
            commandCount: 2,
            completedCount: 2,
            lastExitStatus: 1,
        });
        await expect(terminalCommandStatus(running.page, firstTerminalId)).toHaveText(
            'Command failed with exit status 1.',
        );
        await expect(firstSurface.locator('[data-terminal-command-phase="failed"]')).toHaveCount(1);

        const visibleRows = firstSurface.locator('.xterm-rows');
        await running.page.keyboard.press('Meta+Shift+ArrowUp');
        await running.page.keyboard.press('Meta+Shift+ArrowUp');
        await expect(visibleRows).toContainText('COMMAND_NAV_001');
        await running.page.keyboard.press('Meta+Shift+ArrowDown');
        await expect(visibleRows).toContainText('COMMAND_NAV_120');

        await running.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        await expect(terminalSurface(running.page, firstTerminalId)).toBeVisible();
        /**
         * A parsed attach snapshot cannot prove historical OSC boundaries. The remounted tracker must start empty
         * instead of fabricating or duplicating status from visible text.
         */
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 0,
            completedCount: 0,
        });
        await running.page
            .locator(`.work-tab[data-terminal-id="${firstTerminalId}"] [role="tab"]`)
            .click();
        await typeInTerminal(running.page, firstTerminalId, 'true # AFTER_SPLIT');
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });
        await expect(terminalCommandStatus(running.page, firstTerminalId)).toHaveText(
            'Command completed successfully.',
        );
        const splitter = running.page.getByRole('separator', { name: /Terminal split/u });
        const splitterBox = await splitter.boundingBox();
        if (!splitterBox) throw new Error('Terminal split handle was not rendered');
        await running.page.mouse.move(
            splitterBox.x + splitterBox.width / 2,
            splitterBox.y + splitterBox.height / 2,
        );
        await running.page.mouse.down();
        await running.page.mouse.move(splitterBox.x + 60, splitterBox.y);
        await running.page.mouse.up();
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });

        await createAdditionalShellSession(running.page);
        await sessionCard(running.page, firstSessionId).click();
        await expect(sessionCard(running.page, firstSessionId)).toHaveClass(/active/u);
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 0,
            completedCount: 0,
        });
        await running.page
            .locator(`.work-tab[data-terminal-id="${firstTerminalId}"] [role="tab"]`)
            .click();
        await typeInTerminal(running.page, firstTerminalId, 'true # AFTER_SESSION_SWITCH');
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });

        await running.page.reload();
        await expect(terminalSurface(running.page, firstTerminalId)).toBeVisible();
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 0,
            completedCount: 0,
        });
        await typeInTerminal(running.page, firstTerminalId, 'true # AFTER_RENDERER_RELOAD');
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
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

test('bash reports successful and failed command status without retaining command text', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-commands-bash-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({
        env: { SHELL: '/bin/bash' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const terminalId = await activeTerminalId(running.page);
        const surface = terminalSurface(running.page, terminalId);
        await expectCommandState(surface, { commandCount: 0, completedCount: 0 });
        await typeTerminal(running.page, 'true # COMMAND_BODY_PRIVATE');
        await expectCommandState(surface, {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });
        await expect(terminalCommandStatus(running.page, terminalId)).toHaveText(
            'Command completed successfully.',
        );
        await typeTerminal(running.page, 'false');
        await expectCommandState(surface, {
            commandCount: 2,
            completedCount: 2,
            lastExitStatus: 1,
        });
        await expect(terminalCommandStatus(running.page, terminalId)).toHaveText(
            'Command failed with exit status 1.',
        );
        await expect(surface.locator('[data-terminal-command-phase="failed"]')).toHaveCount(1);
        const commandMetadata = await surface.evaluate((element) => ({
            decorations: [...element.querySelectorAll('.terminal-command-decoration')].map(
                (decoration) => ({ ...(decoration as HTMLElement).dataset }),
            ),
            surface: { ...(element as HTMLElement).dataset },
        }));
        expect(JSON.stringify(commandMetadata)).not.toContain('COMMAND_BODY_PRIVATE');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('unsupported shells and Agent Terminals remain usable without inferred boundaries', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-commands-fallback-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { startupOutput: 'COMMAND_AGENT_READY\r\n' } },
    });

    const running = await launchCaxri({
        agentMode,
        env: { SHELL: '/bin/sh' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const shellSurface = terminalSurface(running.page, await activeTerminalId(running.page));
        await typeTerminal(running.page, String.raw`printf 'UNSUPPORTED_SHELL_READY\n'`);
        await expect(shellSurface.locator('.xterm-rows')).toContainText('UNSUPPORTED_SHELL_READY');
        await expectCommandState(shellSurface, { commandCount: 0, completedCount: 0 });
        await expect(
            terminalCommandStatus(running.page, await activeTerminalId(running.page)),
        ).toBeEmpty();

        const shellSessionId = await selectedSessionId(running.page);
        const shellTerminalId = await activeTerminalId(running.page);
        await running.page
            .locator('.project-heading')
            .filter({ has: running.page.getByRole('button', { name: /^New Session in /u }) })
            .hover();
        await running.page.getByRole('button', { name: /^New Session in /u }).click();
        await running.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Codex', exact: true })
            .click();
        await expect.poll(() => selectedSessionId(running.page)).not.toBe(shellSessionId);
        const agentTerminalId = await waitForNewTerminalId(running.page, [shellTerminalId]);
        const agentSurface = terminalSurface(running.page, agentTerminalId);
        await expect(agentSurface.locator('.xterm-rows')).toContainText('COMMAND_AGENT_READY');
        await expectCommandState(agentSurface, { commandCount: 0, completedCount: 0 });
        await expect(agentSurface.locator('.terminal-command-decoration')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
