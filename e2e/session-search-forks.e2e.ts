import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

const ORIGINAL = '4c2e8a1f-6b3d-4e7a-9f10-2d5c8b7a6e41';
const FORK_A = '5d3f9b2a-7c4e-4f8b-8a21-3e6d9c8b7f52';
const FORK_B = '6e4a0c3b-8d5f-4a9c-9b32-4f7e0d9c8a63';
const PHRASE = 'Why does the invoice total drift by a cent?';

/**
 * A Claude transcript. A fork (`claude --fork-session`) copies the shared records under its own ID, each stamped with
 * `forkedFrom`, then continues with its own prompt.
 */
async function writeTranscript(
    configDirectory: string,
    cwd: string,
    sessionId: string,
    options: { followUp?: string; forkedFrom?: string; mtime: Date },
): Promise<void> {
    const path = join(
        configDirectory,
        'projects',
        cwd.replaceAll(/[^a-z0-9]/giu, '-'),
        `${sessionId}.jsonl`,
    );
    const base = {
        cwd,
        entrypoint: 'cli',
        isSidechain: false,
        sessionId,
        ...(options.forkedFrom && { forkedFrom: { sessionId: options.forkedFrom } }),
    };
    const records = [
        { ...base, type: 'user', message: { role: 'user', content: PHRASE } },
        {
            ...base,
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Rounding happens per line item before tax.' }],
            },
        },
        ...(options.followUp
            ? [
                  {
                      ...base,
                      forkedFrom: undefined,
                      type: 'user',
                      message: { role: 'user', content: options.followUp },
                  },
              ]
            : []),
    ];
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    await utimes(path, options.mtime, options.mtime);
}

test('Session search folds the branches of a forked conversation into one expandable result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-search-forks-e2e-'));
    const userData = join(directory, 'profile');
    const root = join(directory, 'workspace');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: {} },
    });
    const claudeHome = agentMode.environment.CLAUDE_CONFIG_DIR!;
    const now = Date.now();
    await writeTranscript(claudeHome, root, ORIGINAL, { mtime: new Date(now - 3 * 3_600_000) });
    await writeTranscript(claudeHome, root, FORK_A, {
        followUp: 'Try rounding at the invoice level instead',
        forkedFrom: ORIGINAL,
        mtime: new Date(now - 2 * 3_600_000),
    });
    await writeTranscript(claudeHome, root, FORK_B, {
        followUp: 'Keep per-line rounding and add a tax cap',
        forkedFrom: ORIGINAL,
        mtime: new Date(now - 3_600_000),
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.keyboard.press('Meta+Shift+S');
        const dialog = page.getByRole('dialog', { name: 'Search Sessions', exact: true });
        const input = dialog.getByRole('combobox', { name: 'Search Sessions', exact: true });
        const results = dialog.getByRole('listbox', { name: 'Session search results' });
        await input.fill('invoice total drift');

        // One result for the original and both branches, standing for the most recently active one.
        const options = results.getByRole('option');
        await expect(options).toHaveCount(1);
        await expect(options.first()).toHaveAttribute(
            'data-session-search-key',
            `claude:${FORK_B}`,
        );
        await expect(options.first()).toContainText('2 other branches');
        await dialog.screenshot({
            path: test.info().outputPath('session-search-forks-collapsed.png'),
        });

        // ArrowRight lists every branch, the latest included.
        await input.press('ArrowRight');
        await expect(options).toHaveCount(4);
        await expect(results.locator('[data-session-search-branch]')).toHaveCount(3);
        await dialog.screenshot({
            path: test.info().outputPath('session-search-forks-expanded.png'),
        });

        // ArrowLeft on a branch row returns to the folded group.
        await input.press('ArrowDown');
        await input.press('ArrowLeft');
        await expect(options).toHaveCount(1);
        await expect(options.first()).toHaveAttribute('aria-selected', 'true');

        // Enter on a branch adds that branch, not the group's latest one.
        await input.press('ArrowRight');
        await input.press('ArrowDown');
        await input.press('ArrowDown');
        await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
        await expect(options.nth(2)).toHaveAttribute(
            'data-session-search-key',
            `claude:${FORK_B}#claude:${FORK_A}`,
        );
        await input.press('Enter');
        await expect(dialog).toHaveCount(0);
        await expect
            .poll(async () => {
                const state = await pageRequest<BootstrapState>(page, 'app.bootstrap');
                return state.terminals.some((entry) => entry.agentSessionId === FORK_A);
            })
            .toBe(true);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
