import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, typeTerminal } from './support/helpers.ts';

const execFileAsync = promisify(execFile);

/**
 * Agent CLIs (Codex) probe the terminal's default colors with OSC 10/11 right after spawn and
 * give up within ~100ms. The Runtime must answer at the PTY boundary because the Renderer's
 * xterm.js attaches too late to make that deadline (`src/runtime/terminal/color-query.ts`).
 * This regression test replays the probe from inside a real shell Terminal and requires an
 * `rgb:` reply to come back through the PTY within the probe-scale timeout.
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
