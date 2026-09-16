import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring for its fixture argument.
test('revealing a hidden worktree Session does not shift existing Project rows', async ({}, testInfo) => {
    const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-slot-e2e-'));
    const directory = await realpath(createdDirectory);
    const root = join(directory, 'project');
    const worktree = join(directory, 'worktree');
    await mkdir(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'README.md'), '# Project\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await execFileAsync('git', ['worktree', 'add', '-b', 'feature/sidebar', worktree], {
        cwd: root,
    });

    const running = await launchCaxri({
        agentMode: { mode: 'blocked' },
        userDataDir: join(directory, 'user-data'),
        testRootPath: root,
    });
    try {
        await running.page.setViewportSize({ height: 800, width: 1_200 });
        const worktreeSessionId = await createProjectSession(running.page);
        const bootstrap = await pageRequest<{ projects: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        const projectId = bootstrap.projects[0]?.id;
        if (!projectId) throw new Error('Project fixture was not created');
        const roots = await pageRequest<Array<{ rootPath: string; worktreeId: string }>>(
            running.page,
            'session.workbenchRoots',
            { sessionId: worktreeSessionId },
        );
        const option = roots.find((candidate) => candidate.rootPath === worktree);
        if (!option) throw new Error('Linked worktree was not discovered');
        await pageRequest(running.page, 'session.authorizeWorkbenchRoot', {
            sessionId: worktreeSessionId,
            worktreeId: option.worktreeId,
        });
        for (let index = 0; index < 6; index += 1)
            // eslint-disable-next-line no-await-in-loop -- Creation order places the worktree Session seventh.
            await pageRequest(running.page, 'session.create', { projectId, defaultAgent: null });

        const group = running.page.locator('.project-group');
        const rows = group.locator('.session-card');
        const reveal = group.getByRole('treeitem', { name: /^Show 2 more Sessions in / });
        await expect(rows).toHaveCount(5);
        await expect(reveal).toBeVisible();
        await expect(rows.locator('.session-worktree')).toHaveCount(5);
        await expect(rows.locator('[data-session-worktree]')).toHaveCount(0);
        const before = await rows
            .locator('.session-title')
            .evaluateAll((titles) => titles.map((title) => title.getBoundingClientRect().x));
        const beforePath = testInfo.outputPath('before-reveal.png');
        await running.page.screenshot({ path: beforePath });
        await testInfo.attach('before-reveal', { path: beforePath, contentType: 'image/png' });

        await reveal.click();
        await expect(rows).toHaveCount(7);
        await expect(
            group.locator(
                `.session-card[data-session-id="${worktreeSessionId}"] [data-session-worktree]`,
            ),
        ).toBeVisible();
        const after = await rows
            .locator('.session-title')
            .evaluateAll((titles) =>
                titles.slice(0, 5).map((title) => title.getBoundingClientRect().x),
            );
        expect(after).toEqual(before);
        const afterPath = testInfo.outputPath('after-reveal.png');
        await running.page.screenshot({ path: afterPath });
        await testInfo.attach('after-reveal', { path: afterPath, contentType: 'image/png' });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
