import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { closeAppQuietly, createProjectSession, launchCaxri } from './support/helpers.ts';

const FIRST_FRAME = 'Fake codex first frame';
const FIRST_FRAME_DELAY_MS = 3_000;

/**
 * Issue #1459: a delegated Codex Session seemed to show a Shell prompt before Codex appeared. An Agent Terminal (a
 * delegated one included, which shares the launch plan) runs `zsh -l` whose Caxri `.zshenv` starts the Agent before any
 * startup file or prompt hook, so the shell can only print a prompt once the Agent exits. A fake Codex that holds its
 * first frame for seconds proves the pane stays empty until then; its exit afterwards proves the sampler does see the
 * prompt the shell prints once it finally gets to.
 */
test('an Agent Terminal shows no Shell prompt before the Agent first frame', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-first-frame-e2e-'));
    const userData = join(directory, 'profile');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
setTimeout(() => {
  process.stdout.write(${JSON.stringify(`${FIRST_FRAME}\r\n`)});
  setTimeout(() => process.exit(0), 1_000);
}, ${FIRST_FRAME_DELAY_MS});
`,
            },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page, 'codex');
        const rows = running.page.locator('.terminal-pane .xterm-rows');
        const screen = async () =>
            (await rows.evaluateAll((nodes) => nodes.map((node) => node.textContent)))
                .join('\n')
                .trim();

        const beforeFirstFrame: string[] = [];
        let mountedSamples = 0;
        await expect
            .poll(
                async () => {
                    const text = await screen();
                    if (text.includes(FIRST_FRAME)) return true;
                    beforeFirstFrame.push(text);
                    if ((await rows.count()) > 0) mountedSamples += 1;
                    return false;
                },
                { intervals: [50], timeout: 20_000 },
            )
            .toBe(true);
        // The pane was on screen for part of the wait, and nothing (no prompt, no shell output) reached it.
        expect(mountedSamples).toBeGreaterThan(0);
        expect(beforeFirstFrame.filter(Boolean)).toEqual([]);

        // Once the Agent exits the shell finishes starting and prints its prompt below the Agent's last frame.
        await expect
            .poll(async () => (await screen()).split(FIRST_FRAME).at(1)?.trim() ?? '')
            .not.toBe('');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
