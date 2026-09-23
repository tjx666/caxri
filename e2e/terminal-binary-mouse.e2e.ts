import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, typeTerminal } from './support/helpers.ts';

test('forwards default-encoded xterm wheel reports to the PTY', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-binary-mouse-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const report = join(root, 'mouse-report.txt');
    await mkdir(root, { recursive: true });
    await writeFile(
        join(root, 'capture-mouse.sh'),
        [
            '#!/bin/sh',
            'stty raw -echo',
            String.raw`printf '\033[?1003hMOUSE_READY\r\n'`,
            'dd bs=1 count=6 2>/dev/null | od -An -tx1 > mouse-report.txt',
            String.raw`printf '\033[?1003l'`,
            'stty sane',
            String.raw`printf 'MOUSE_DONE\n'`,
            '',
        ].join('\n'),
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const terminal = running.page.locator('.terminal-pane:visible .xterm');
        await terminal.hover();
        await typeTerminal(running.page, 'sh ./capture-mouse.sh');
        await expect(terminal).toContainText('MOUSE_READY');
        await running.page.mouse.wheel(0, -120);

        await expect
            .poll(async () => {
                try {
                    return (await readFile(report, 'utf8')).trim().replaceAll(/\s+/g, '');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                    throw error;
                }
            })
            .toMatch(/^1b5b4d[\da-f]{6}$/);
        await expect(terminal).toContainText('MOUSE_DONE');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
