import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest, typeTerminal } from './support/helpers.ts';

/**
 * Agent CLIs (Codex) probe the terminal's default colors with OSC 10/11 right after spawn and give up within ~100ms.
 * The Runtime must answer at the PTY boundary because the Renderer's xterm.js attaches too late to make that deadline
 * (`apps/server/src/domains/terminal/color-query.ts`). This regression test replays the probe from inside a real shell
 * Terminal and requires an `rgb:` reply to come back through the PTY within the probe-scale timeout.
 */
test('Runtime answers OSC 10/11 color queries at the PTY boundary', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-color-query-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        // ST-terminated background query, exactly as codex-rs `terminal_probe.rs` sends it. The
        // read stops at the reply's terminating backslash; deleting the ESC bytes turns the rest
        // of the reply into plain printable text the assertion below can see.
        await typeTerminal(
            running.page,
            String.raw`printf '\033]11;?\033\\'; IFS= read -r -t 1 -d '\' r </dev/tty; printf 'COLOR-REPLY-%s\n' "$r" | tr -d '\033'`,
        );
        await expect(running.page.locator('.xterm-rows')).toContainText(/COLOR-REPLY-\]11;rgb:/);
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
 * A fresh profile follows the system appearance. Server Core has no display, so Desktop Main reports the appearance it
 * observes (`nativeTheme`); the host must then answer a running shell's OSC 11 query with the preset paired with that
 * appearance, and keep answering correctly after the appearance switches while the same Terminal stays open.
 */
test('Runtime OSC 11 reply follows the system appearance while the Terminal stays open', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-color-follow-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const setSystemAppearance = (source: 'dark' | 'light') =>
        running.app.evaluate(({ nativeTheme }, value) => {
            nativeTheme.themeSource = value;
        }, source);
    let probe = 0;
    const queryBackground = async (): Promise<void> => {
        probe += 1;
        await typeTerminal(
            running.page,
            String.raw`printf '\033]11;?\033\\'; IFS= read -r -t 1 -d '\' r </dev/tty; printf 'COLOR-REPLY-${probe}-%s\n' "$r" | tr -d '\033'`,
        );
    };
    try {
        // The E2E profile pins one explicit theme; opt in to following the system like a fresh install does.
        const current = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(
                { ...current.value, 'workbench.theme.followSystem': true },
                null,
                2,
            ),
        });
        await setSystemAppearance('light');
        await createShellSession(running.page);
        await queryBackground();
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'COLOR-REPLY-1-]11;rgb:ffff/ffff/ffff',
        );

        await setSystemAppearance('dark');
        await expect
            .poll(async () => {
                await queryBackground();
                return running.page.locator('.xterm-rows').textContent();
            })
            .toMatch(/COLOR-REPLY-\d+-\]11;rgb:2828\/2a2a\/3636/);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
