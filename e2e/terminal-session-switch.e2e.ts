import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
    typeTerminal,
    VISIBLE_SESSION,
    VISIBLE_TERMINAL_INPUT,
} from './support/helpers.ts';
import { runningWork } from './support/running-work.ts';
import { removeE2ETemporaryDirectory } from './support/worker-isolation.ts';

test('Session switches preserve a cursor-addressed Terminal screen and its live PTY', async () => {
    /**
     * Playwright escapes non-ASCII static text inside `String.raw`; runtime substitutions keep the fixture glyphs.
     */
    const cjkGlyph = String.fromCodePoint(0x75_4c);
    const combiningAcute = String.fromCodePoint(0x301);
    const powerlineGlyph = String.fromCodePoint(0xe0_b0);
    const facepalmGlyph = String.fromCodePoint(0x1_f926);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-session-switch-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const backgroundComplete = join(root, 'terminal-screen-complete');
    const backgroundTrigger = join(root, 'terminal-screen-trigger');
    await execFileAsync('mkdir', ['-p', root]);
    await writeFile(
        join(root, 'terminal-screen-fixture.zsh'),
        [
            String.raw`printf '\033[?1049h\033[2J\033[H'`,
            'cols=$(tput cols)',
            'rows=$(tput lines)',
            String.raw`printf '\033[1;1HSESSION_SWITCH_TOP_${cjkGlyph}_e${combiningAcute}_${powerlineGlyph}'`,
            String.raw`printf '\033[4;1H'`,
            "printf '%*s' \"$cols\" '' | tr ' ' '-'",
            String.raw`printf '\033[4;3HSESSION_SWITCH_RULE_${cjkGlyph}'`,
            String.raw`printf '\033[8;5HSESSION_SWITCH_MIDDLE_${cjkGlyph}'`,
            String.raw`printf '\033[10;1H'`,
            String.raw`printf '%*s${facepalmGlyph}X\rZ' "$((cols - 2))" ''`,
            // Keep the wide glyph inside the grid after the viewport resize narrows this Terminal.
            String.raw`printf '\033[%d;%dHSESSION_SWITCH_EDGE_${cjkGlyph}' "$((rows - 2))" "$((cols - 32))"`,
            `while [ ! -f '${backgroundTrigger}' ]; do sleep 0.05; done`,
            String.raw`awk 'BEGIN { for (i = 0; i < 120000; i += 1) printf "\033[2;1Hbackground-%06d", i }'`,
            String.raw`printf '\033[12;5HSESSION_SWITCH_BACKGROUND_${cjkGlyph}'`,
            'sleep 1',
            `printf complete > '${backgroundComplete}'`,
            'sleep 60',
        ].join('\n'),
        'utf8',
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        await typeTerminal(running.page, 'zsh terminal-screen-fixture.zsh');
        const screen = running.page.locator(`${VISIBLE_SESSION} .xterm-rows`);
        await expect(screen).toContainText('SESSION_SWITCH_TOP_界_é_');
        await expect(screen).toContainText('SESSION_SWITCH_RULE_界');
        await expect(screen).toContainText('SESSION_SWITCH_MIDDLE_界');
        await expect(screen).toContainText('SESSION_SWITCH_EDGE_界');
        await expect(screen.locator(':scope > div').nth(9)).toContainText('🤦');
        await expect(screen.locator(':scope > div').nth(10)).toHaveText('Z');
        await running.page.setViewportSize({ height: 900, width: 1_400 });
        await expect(screen).toContainText('SESSION_SWITCH_TOP_界_é_');
        await expect(screen).toContainText('SESSION_SWITCH_EDGE_界');
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        const firstSession = sessionCard(running.page, firstSessionId);
        const secondSession = sessionCard(running.page, secondSessionId);

        await writeFile(backgroundTrigger, 'go', 'utf8');
        await expect
            .poll(async () => {
                try {
                    return await readFile(backgroundComplete, 'utf8');
                } catch {
                    return '';
                }
            })
            .toBe('complete');
        await firstSession.click();
        await expect(firstSession).toHaveClass(/active/);
        await expect(screen).toContainText('SESSION_SWITCH_TOP_界_é_');
        await expect(screen).toContainText('SESSION_SWITCH_RULE_界');
        await expect(screen).toContainText('SESSION_SWITCH_MIDDLE_界');
        await expect(screen).toContainText('SESSION_SWITCH_EDGE_界');
        await expect(screen).toContainText('SESSION_SWITCH_BACKGROUND_界');
        await expect(screen).toContainText('background-119999');
        const expectedScreen = await screen.textContent();

        for (let attempt = 0; attempt < 5; attempt += 1) {
            // Session switches must be exercised sequentially, attempt-by-attempt, to prove the
            // Terminal screen is stably restored on each repeated switch rather than only once.
            // eslint-disable-next-line no-await-in-loop
            await secondSession.click();
            // eslint-disable-next-line no-await-in-loop
            await expect(secondSession).toHaveClass(/active/);
            // eslint-disable-next-line no-await-in-loop
            await firstSession.click();
            // eslint-disable-next-line no-await-in-loop
            await expect(firstSession).toHaveClass(/active/);
            // eslint-disable-next-line no-await-in-loop
            await expect(screen).toContainText('SESSION_SWITCH_EDGE_界');
            // eslint-disable-next-line no-await-in-loop
            await expect.poll(() => screen.textContent()).toBe(expectedScreen);
        }

        const input = running.page.locator(VISIBLE_TERMINAL_INPUT).last();
        await input.focus();
        await input.press('Control+C');
        await input.pressSequentially(String.raw`printf 'SESSION_SWITCH_INTERACTIVE\n'`);
        await input.press('Enter');
        await expect(screen).toContainText('SESSION_SWITCH_INTERACTIVE');
        await expect.poll(() => runningWork(running.page)).toEqual({ terminals: 2, chats: 0 });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await removeE2ETemporaryDirectory(testDirectory);
    }
});
