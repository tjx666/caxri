import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { expect, test } from './support/fixtures.ts';
import {
    clickTerminalLink,
    createShellSession,
    launchCaxri,
    typeTerminal,
} from './support/helpers.ts';

/**
 * A stand-in for a fullscreen TUI such as Codex with `fullscreen_transcript`: it prints a URL, turns on click tracking
 * with SGR encoding, and appends every stdin chunk to a log so the test can see exactly what reached the PTY.
 */
function mouseTrackingProbeSource(url: string, logPath: string): string {
    return String.raw`const { appendFileSync } = require('node:fs');
process.stdout.write(${JSON.stringify(`${url}\n`)});
process.stdin.setRawMode(true);
process.stdout.write('\x1b[?1000h\x1b[?1006h');
process.stdout.write('mouse-tracking-ready\n');
process.stdin.on('data', (chunk) => {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(chunk.toString('latin1')) + '\n');
    if (chunk.includes(3)) {
        process.stdout.write('\x1b[?1006l\x1b[?1000l');
        process.exit(0);
    }
});
`;
}

/**
 * Returns the PTY input the probe logged, with ESC spelled out so assertions can match SGR mouse reports as text.
 */
async function readProbeInput(logPath: string): Promise<string> {
    try {
        return (await readFile(logPath, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as string).replaceAll('\u{1B}', '<ESC>'))
            .join('');
    } catch {
        return '';
    }
}

test('Cmd+click on a link inside a mouse-tracking app opens it once and is not forwarded', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-link-mouse-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const probePath = join(testDirectory, 'mouse-probe.cjs');
    const logPath = join(testDirectory, 'mouse-probe.log');
    const url = 'https://example.com/caxri-mouse-tracking-link';
    await mkdir(root, { recursive: true });
    await writeFile(probePath, mouseTrackingProbeSource(url, logPath));

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & {
                caxriMouseTrackingLinkProbe?: { opened: string[] };
            };
            target.caxriMouseTrackingLinkProbe = { opened: [] };
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
            shell.openExternal = (openedUrl) => {
                target.caxriMouseTrackingLinkProbe!.opened.push(openedUrl);
                return Promise.resolve();
            };
        });
        await createShellSession(running.page);
        await typeTerminal(running.page, `'${process.execPath}' '${probePath}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText('mouse-tracking-ready');

        await clickTerminalLink(running.page, url);
        await expect
            .poll(() =>
                running.app.evaluate(
                    () =>
                        (
                            globalThis as typeof globalThis & {
                                caxriMouseTrackingLinkProbe?: { opened: string[] };
                            }
                        ).caxriMouseTrackingLinkProbe?.opened,
                ),
            )
            .toEqual([url]);

        /**
         * A plain click on an empty row must still reach the app, which proves tracking was active during the Cmd+click
         * above and that its absence from the log is the fix rather than a probe that never enabled reporting.
         */
        const emptyRow = await running.page.locator('.xterm-rows > div').last().boundingBox();
        if (!emptyRow) throw new Error('The empty Terminal row is not visible');
        await running.page.mouse.click(emptyRow.x + 4, emptyRow.y + emptyRow.height / 2);
        await expect.poll(() => readProbeInput(logPath)).toMatch(/<ESC>\[<0;\d+;\d+M/u);
        const input = await readProbeInput(logPath);
        expect(input.match(/<ESC>\[<\d+;\d+;\d+M/gu)).toHaveLength(1);
        expect(
            await running.app.evaluate(
                () =>
                    (
                        globalThis as typeof globalThis & {
                            caxriMouseTrackingLinkProbe?: { opened: string[] };
                        }
                    ).caxriMouseTrackingLinkProbe?.opened,
            ),
        ).toEqual([url]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
