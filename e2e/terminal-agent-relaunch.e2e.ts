import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';
import { runningWork } from './support/running-work.ts';
import {
    bootstrapTerminal,
    interruptibleAgentFixture,
    typeTerminal,
} from './support/terminal-recovery.ts';

test('same-provider relaunch restores Agent Actions until the manual Agent exits', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-shell-return-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const launchLog = join(testDirectory, 'codex-launches.log');
    const launches = async () => {
        try {
            return (await readFile(launchLog, 'utf8')).split('\n').filter(Boolean).length;
        } catch {
            return 0;
        }
    };
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { executableSource: interruptibleAgentFixture(launchLog) } },
    });
    const shellHome = agentMode.environment.HOME;
    if (!shellHome) throw new Error('Fake Agent HOME was not isolated');
    /**
     * A queued exit interrupt must not prevent the following user alias from loading.
     */
    await writeFile(join(shellHome, '.zshrc'), 'kill -INT $$\nalias cc=codex\n');
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page, 'codex');
        const pane = running.page.locator('.terminal-pane');
        const rows = pane.locator('.xterm-rows');
        const input = pane.locator('.xterm-helper-textarea');
        await expect(rows).toContainText('FAKE_CODEX_READY');

        const terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        const processId = (await bootstrapTerminal(running.page, terminalId))?.processId;
        expect(typeof processId).toBe('number');

        /**
         * Exercise the waiting zsh startup process receiving the exit interrupt too; an Agent's raw-mode exit alone
         * leaves this signal path untested. The PID comes from this isolated Terminal, never host discovery.
         */
        if (!processId) throw new Error('Managed Terminal process was not started');
        process.kill(processId, 'SIGINT');
        await input.focus();
        await input.press('Control+C');
        await expect(rows).toContainText('FAKE_CODEX_EXITED');
        await expect(running.page.locator('[data-terminal-exit-state]')).toHaveCount(0);
        await expect
            .poll(async () => {
                const terminal = await bootstrapTerminal(running.page, terminalId);
                return {
                    agent: terminal?.lastAgentProcessState,
                    process: terminal?.lastProcessState,
                    processId: terminal?.processId,
                };
            })
            .toEqual({ agent: 'stopped', process: 'running', processId });

        await typeTerminal(running.page, String.raw`printf 'RETURNED_TO_SHELL\n'`);
        await expect(rows).toContainText('RETURNED_TO_SHELL');
        await expect(pane).toHaveAttribute('data-terminal-id', terminalId);
        await expect.poll(() => runningWork(running.page)).toEqual({ terminals: 1, chats: 0 });

        await input.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        await expect(running.page.locator('[data-agent-actions-picker]')).toHaveCount(0);

        const agentState = async () =>
            (await bootstrapTerminal(running.page, terminalId))?.lastAgentProcessState;
        // CODEX_SHIM separates a PATH that lost the E2E shim from a launch that failed after resolving it.
        await typeTerminal(
            running.page,
            String.raw`alias cc >/dev/null && printf 'SAME_PROVIDER_ALIAS_READY\n'; [[ $commands[codex] == */shell-bin/codex ]] && echo CODEX_SHIM`,
        );
        await expect(rows).toContainText('SAME_PROVIDER_ALIAS_READY');
        await expect(rows).toContainText('CODEX_SHIM');
        /**
         * The first launch's banner is still on screen, so without clearing it the readiness check below passed before
         * `cc` ran at all, and a hosted failure could not tell an alias that never started the Agent from a started
         * Agent the Server never promoted.
         */
        await typeTerminal(running.page, 'clear');
        await expect(rows).not.toContainText('FAKE_CODEX_READY');
        // Bare `cc` only: shell promotion skips any command containing `;`, `&`, `|`, or a redirect.
        const launchesBefore = await launches();
        await typeTerminal(running.page, 'cc');
        // Fails here when `cc` never started the fake Agent; past it, only the banner's rendering is missing.
        await expect.poll(launches).toBe(launchesBefore + 1);
        await expect(rows).toContainText('FAKE_CODEX_READY');
        await expect.poll(agentState).toBe('running');

        await input.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        await expect(running.page.locator('[data-agent-actions-picker]')).toBeVisible();

        await running.page.keyboard.press('Escape');
        await expect(running.page.locator('[data-agent-actions-picker]')).toHaveCount(0);
        await input.focus();
        await input.press('Control+C');
        await expect.poll(agentState).toBe('stopped');

        await input.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        await expect(running.page.locator('[data-agent-actions-picker]')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
