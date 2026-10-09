import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { E2E_SHELL_PROMPT } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    typeTerminal,
    VISIBLE_SESSION,
} from './support/helpers.ts';

function escapeRegExp(value: string): string {
    return value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

/**
 * A short account name such as `ci` would match inside ordinary words, so it only counts as a leak when it stands alone
 * the way a prompt renders it (`user@host`, `host:dir user$`).
 */
function standaloneWord(value: string): RegExp {
    return new RegExp(String.raw`(?:^|[^\w.-])${escapeRegExp(value)}(?:[^\w-]|$)`, 'u');
}

/**
 * E2E failure screenshots and traces can capture the Terminal. The default launch must render a fixed synthetic prompt
 * instead of the runner's real `%n@%m` prompt or dotfiles, for every shell family the integration supports (issue
 * #1461).
 */
for (const shell of ['/bin/zsh', '/bin/bash']) {
    test(`default E2E ${shell} Terminal shows no runner host, account, or home`, async () => {
        const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-prompt-isolation-e2e-'));
        const userData = join(testDirectory, 'user-data');
        const root = join(testDirectory, 'project');
        await mkdir(root);

        const running = await launchCaxri({
            env: { SHELL: shell },
            userDataDir: userData,
            testRootPath: root,
        });
        try {
            await createShellSession(running.page);
            const rows = running.page.locator(`${VISIBLE_SESSION} .xterm-rows`);
            await typeTerminal(running.page, String.raw`printf 'PROMPT_PROBE_%s\n' READY`);
            await expect(rows).toContainText('PROMPT_PROBE_READY');
            const promptAfterOutput = new RegExp(
                String.raw`PROMPT_PROBE_READY[\s\S]*${escapeRegExp(E2E_SHELL_PROMPT.trimEnd())}`,
                'u',
            );
            await expect(rows).toHaveText(promptAfterOutput);

            const buffer = (await rows.textContent()) ?? '';
            const account = userInfo();
            const host = hostname();
            const homes = new Set([account.homedir, process.env.HOME].filter(Boolean) as string[]);
            expect(buffer).not.toContain(host);
            expect(buffer).not.toContain(host.split('.', 1)[0]);
            expect(buffer).not.toMatch(standaloneWord(account.username));
            for (const home of homes) expect(buffer).not.toContain(home);
        } finally {
            try {
                await running.app.close();
            } catch {
                // Ignore close failures during cleanup.
            }
            await rm(testDirectory, { recursive: true, force: true });
        }
    });
}
