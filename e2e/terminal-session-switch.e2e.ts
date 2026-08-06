import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

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
        const expectedScreen = await screen.textContent();

        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        const firstSession = sessionCard(running.page, firstSessionId);
        const secondSession = sessionCard(running.page, secondSessionId);

        for (let attempt = 0; attempt < 6; attempt += 1) {
            await firstSession.click();
            await expect(firstSession).toHaveClass(/active/);
            await expect(screen).toContainText('SESSION_SWITCH_EDGE_界');
            await expect.poll(() => screen.textContent()).toBe(expectedScreen);
            await secondSession.click();
            await expect(secondSession).toHaveClass(/active/);
        }

        await expect.poll(() => pageRequest<number>(running.page, 'terminal.runningCount')).toBe(2);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
