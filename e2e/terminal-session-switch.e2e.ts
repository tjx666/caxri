import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from './fixtures.ts';

import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
    typeTerminal,
} from './helpers.ts';

const execFileAsync = promisify(execFile);

test('Session switches preserve a cursor-addressed Terminal screen and its live PTY', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-session-switch-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const backgroundComplete = join(root, 'terminal-screen-complete');
    const backgroundTrigger = join(root, 'terminal-screen-trigger');
    await execFileAsync('mkdir', ['-p', root]);
    await writeFile(
        join(root, 'terminal-screen-fixture.zsh'),
        [
            "printf '\\033[?1049h\\033[2J\\033[H'",
            'cols=$(tput cols)',
            'rows=$(tput lines)',
            "printf '\\033[1;1HSESSION_SWITCH_TOP_界'",
            "printf '\\033[4;1H'",
            "printf '%*s' \"$cols\" '' | tr ' ' '-'",
            "printf '\\033[4;3HSESSION_SWITCH_RULE_界'",
            "printf '\\033[8;5HSESSION_SWITCH_MIDDLE_界'",
            'printf \'\\033[%d;%dHSESSION_SWITCH_EDGE_界\' "$((rows - 2))" "$((cols - 22))"',
            `while [ ! -f '${backgroundTrigger}' ]; do sleep 0.05; done`,
            `awk 'BEGIN { for (i = 0; i < 120000; i += 1) printf "\\033[2;1Hbackground-%06d", i }'`,
            "printf '\\033[12;5HSESSION_SWITCH_BACKGROUND_界'",
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
        const screen = running.page.locator('.xterm-rows');
        await expect(screen).toContainText('SESSION_SWITCH_TOP_界');
        await expect(screen).toContainText('SESSION_SWITCH_RULE_界');
        await expect(screen).toContainText('SESSION_SWITCH_MIDDLE_界');
        await expect(screen).toContainText('SESSION_SWITCH_EDGE_界');
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        const firstSession = sessionCard(running.page, firstSessionId);
        const secondSession = sessionCard(running.page, secondSessionId);

        await writeFile(backgroundTrigger, 'go', 'utf8');
        await expect
            .poll(() => readFile(backgroundComplete, 'utf8').catch(() => ''))
            .toBe('complete');
        await firstSession.click();
        await expect(firstSession).toHaveClass(/active/);
        await expect(screen).toContainText('SESSION_SWITCH_TOP_界');
        await expect(screen).toContainText('SESSION_SWITCH_RULE_界');
        await expect(screen).toContainText('SESSION_SWITCH_MIDDLE_界');
        await expect(screen).toContainText('SESSION_SWITCH_EDGE_界');
        await expect(screen).toContainText('SESSION_SWITCH_BACKGROUND_界');
        await expect(screen).toContainText('background-119999');
        const expectedScreen = await screen.textContent();

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await secondSession.click();
            await expect(secondSession).toHaveClass(/active/);
            await firstSession.click();
            await expect(firstSession).toHaveClass(/active/);
            await expect(screen).toContainText('SESSION_SWITCH_EDGE_界');
            await expect.poll(() => screen.textContent()).toBe(expectedScreen);
        }

        const input = running.page.locator('.xterm-helper-textarea').last();
        await input.focus();
        await input.press('Control+C');
        await input.pressSequentially("printf 'SESSION_SWITCH_INTERACTIVE\\n'");
        await input.press('Enter');
        await expect(screen).toContainText('SESSION_SWITCH_INTERACTIVE');
        await expect.poll(() => pageRequest<number>(running.page, 'terminal.runningCount')).toBe(2);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
