import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a signed-out Agent reads Sign in required in the New Terminal menu and says how to sign in', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-sign-in-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: {}, codex: {} },
    });
    // The fake Agents cannot answer a status command, so under the fake-Agent policy the Server reads this marker
    // instead: Codex reports signed out, Claude Code reports signed in.
    await writeFile(`${agentMode.executables.codex}.sign-in`, 'signedOut\n');
    await writeFile(`${agentMode.executables.claude}.sign-in`, 'signedIn\n');
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
        await expect(terminalMenu.getByRole('menuitem')).toHaveText([
            'Claude',
            'CodexSign in required',
            'Grok BuildNot installed',
            'AntigravityNot installed',
            'Shell',
        ]);
        await terminalMenu.getByRole('menuitem', { name: /^Codex/u }).hover();
        await expect(page.getByRole('tooltip')).toHaveText(
            'Codex is signed out. Run "codex login" in a Terminal.',
        );
        await page.screenshot({ path: testInfo.outputPath('agent-sign-in-required-menu.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { force: true, recursive: true });
    }
});
