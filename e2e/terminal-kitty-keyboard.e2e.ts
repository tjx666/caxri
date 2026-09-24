import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    terminalTextBounds,
    typeTerminal,
} from './support/helpers.ts';

const SELECTABLE_WORD = 'KITTYSELECTABLE';

/**
 * A stand-in for a TUI such as Codex that keeps its own selection: it pushes the kitty keyboard protocol's
 * "disambiguate" flag and appends every stdin chunk to a log so the test can see exactly what reached the PTY.
 */
function kittyKeyboardProbeSource(logPath: string): string {
    return String.raw`const { appendFileSync } = require('node:fs');
process.stdin.setRawMode(true);
process.stdout.write('\x1b[>1u');
process.stdout.write(${JSON.stringify(`${SELECTABLE_WORD}\nkitty-keyboard-ready\n`)});
process.stdin.on('data', (chunk) => {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(chunk.toString('latin1')) + '\n');
    if (chunk.includes(3) || chunk.toString('latin1').includes('\x1b[99;5u')) {
        process.stdout.write('\x1b[<u');
        process.exit(0);
    }
});
`;
}

/**
 * Returns the PTY input the probe logged, with ESC spelled out so assertions can match CSI u sequences as text.
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

test('Cmd+C reaches a kitty-keyboard app only without a Terminal selection', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-kitty-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const probePath = join(testDirectory, 'kitty-probe.cjs');
    const logPath = join(testDirectory, 'kitty-probe.log');
    await mkdir(root, { recursive: true });
    await writeFile(probePath, kittyKeyboardProbeSource(logPath));

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        await typeTerminal(running.page, `'${process.execPath}' '${probePath}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText('kitty-keyboard-ready');
        const input = running.page.locator('.terminal-pane .xterm-helper-textarea').last();
        await input.focus();

        await input.press('Meta+C');
        await expect.poll(() => readProbeInput(logPath)).toContain('<ESC>[99;9u');

        /**
         * Caxri's Cmd shortcuts stay with Caxri even after the app opted into reporting modifiers: Cmd+V must still
         * paste instead of being encoded as `CSI 118;9u`.
         */
        const pasted = 'KITTY_PASTE_TEXT';
        await running.clipboard.writeText(pasted);
        await input.press('Meta+V');
        await expect.poll(() => readProbeInput(logPath)).toContain(pasted);
        await input.press('Meta+A');
        const afterShortcuts = await readProbeInput(logPath);
        expect(afterShortcuts).not.toContain('<ESC>[118;9u');
        expect(afterShortcuts).not.toContain('<ESC>[97;9u');

        const wordBounds = await terminalTextBounds(running.page, SELECTABLE_WORD);
        if (!wordBounds) throw new Error('The selectable probe word is not visible');
        await running.page.mouse.dblclick(
            wordBounds.x + wordBounds.width / 2,
            wordBounds.y + wordBounds.height / 2,
        );
        /**
         * Copy-on-select writes the new selection asynchronously; let it land before the sentinel so only `Cmd+C` can
         * restore the word afterwards.
         */
        await expect.poll(() => running.clipboard.textEquals(SELECTABLE_WORD)).toBe(true);
        await running.clipboard.claimText(SELECTABLE_WORD);
        await running.clipboard.writeText('KITTY_COPY_SENTINEL');
        await input.focus();
        await input.press('Meta+C');
        await expect.poll(() => running.clipboard.textEquals(SELECTABLE_WORD)).toBe(true);
        await running.clipboard.claimText(SELECTABLE_WORD);
        expect((await readProbeInput(logPath)).match(/<ESC>\[99;9u/gu)).toHaveLength(1);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
