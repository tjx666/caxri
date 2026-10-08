import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createShellSession,
    hoverTerminalLink,
    launchCaxri,
    typeTerminal,
} from './support/helpers.ts';

const COMMIT_SUBJECT = 'Add the hover preview fixture';

/**
 * Commits until the abbreviated sha carries a letter, because a purely numeric abbreviation is deliberately not
 * detected as a commit reference: it is indistinguishable from an ordinary number in Terminal output.
 */
async function commitWithHexadecimalSha(root: string): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        // Each commit has to land on top of the previous one, so these cannot run concurrently.
        // eslint-disable-next-line no-await-in-loop
        await writeFile(join(root, `fixture-${attempt}.txt`), `${attempt}\n`, 'utf8');
        // eslint-disable-next-line no-await-in-loop
        await execFileAsync('git', ['add', '.'], { cwd: root });
        // eslint-disable-next-line no-await-in-loop
        await execFileAsync('git', ['commit', '-m', COMMIT_SUBJECT], { cwd: root });
        // eslint-disable-next-line no-await-in-loop
        const { stdout } = await execFileAsync('git', ['rev-parse', '--short=9', 'HEAD'], {
            cwd: root,
        });
        const shortSha = stdout.trim();
        if (/[a-f]/.test(shortSha)) return shortSha;
    }
    throw new Error('Unable to produce a commit whose abbreviated sha contains a letter');
}

test('hovering a Terminal commit reference previews it and Escape dismisses the card', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-reference-preview-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: root });
    const shortSha = await commitWithHexadecimalSha(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await typeTerminal(running.page, String.raw`printf '%s\n' '${shortSha}'`);
        await expect(running.page.locator('.terminal-command-status')).toHaveText(
            'Command completed successfully.',
        );

        await hoverTerminalLink(running.page, shortSha, { expectHint: true });
        const hint = running.page.locator('.terminal-link-hint');
        /**
         * The whole point of the card: the subject answers "what is this commit" without leaving the Terminal, and the
         * affordance line still tells the user how to open it. Both have to be on screen at once.
         */
        await expect(hint).toContainText(COMMIT_SUBJECT);
        await expect(hint).toContainText('Caxri Test');
        await expect(hint).toContainText(`⌘ click to show commit ${shortSha} in Git`);

        await running.page.keyboard.press('Escape');
        await expect(hint).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
