import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, typeTerminal } from './support/helpers.ts';

/**
 * OSC 0 is the window-title escape every terminal emulator has honoured since xterm, and the only thing a Shell or an
 * Agent CLI can use to say what it is currently doing.
 */
function osc0(title: string): string {
    return String.raw`printf '\033]0;${title}\007'`;
}

test('a PTY window title reaches the tab label and survives a Renderer reload', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-title-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const tabLabel = running.page.locator('.work-tab.active[data-terminal-id] .tab-label');
        const tab = running.page.locator('.work-tab.active[data-terminal-id]').getByRole('tab');
        const terminalRegion = running.page.getByRole('region', { name: 'Shell' });
        await expect(tabLabel).toHaveText('Shell');
        await expect(tab).toHaveAccessibleName('Shell');
        await expect(terminalRegion).toBeVisible();

        await typeTerminal(running.page, osc0('caxri-title-probe'));
        await expect(tabLabel).toHaveText('caxri-title-probe');
        await expect(tab).toHaveAccessibleName('caxri-title-probe');
        await expect(terminalRegion).toBeVisible();

        // Persisted in `terminals.pty_title`, not held in Renderer state: a reload has to bring it back.
        await running.page.reload();
        await expect(tabLabel).toHaveText('caxri-title-probe');

        // A prompt-shaped title is compressed down to its identifying tail for the narrow tab, so the untouched
        // original has to stay reachable as the tooltip. A title the label shows in full offers no tooltip at all.
        await typeTerminal(running.page, osc0('dev@probe:~/code/demo-worktrees/feat-title'));
        await expect(tabLabel).toHaveText('~/…/feat-title');
        await tab.hover();
        await expect(running.page.locator('.tooltip-popup[data-open]')).toHaveText(
            'dev@probe:~/code/demo-worktrees/feat-title',
        );

        // Untrusted PTY output: control characters must never reach the label, and an empty payload
        // leaves the previous title in place rather than blanking the tab.
        await typeTerminal(running.page, String.raw`printf '\033]0;a\007'`);
        await expect(tabLabel).toHaveText('a');
        await typeTerminal(running.page, String.raw`printf '\033]0;\007'`);
        await expect(tabLabel).toHaveText('a');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
