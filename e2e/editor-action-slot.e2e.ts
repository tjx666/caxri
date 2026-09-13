import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('Editor file actions keep their slot while history loads and hide without history', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-action-slot-e2e-'));
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    const marker = join(testDirectory, 'history-started');
    const release = join(testDirectory, 'history-released');
    await execFileAsync('mkdir', ['-p', root, bin]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'committed\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'untracked.txt'), 'not committed\n');

    const gitExecutable = (await execFileAsync('which', ['git'])).stdout.trim();
    const gitWrapper = join(bin, 'git');
    await writeFile(
        gitWrapper,
        [
            '#!/bin/sh',
            '# 用途：仅阻塞文件历史查询，给编辑器动作区提供可观察的加载阶段。',
            'if [ "$1" = "log" ] && [ "${2:-}" = "-z" ]; then',
            `  touch ${marker}`,
            `  while [ ! -e ${release} ]; do sleep 0.05; done`,
            'fi',
            `exec ${gitExecutable} "$@"`,
            '',
        ].join('\n'),
    );
    await chmod(gitWrapper, 0o755);

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'tracked.txt', exact: true }).click();
        await expect
            .poll(async () => {
                try {
                    await access(marker);
                    return true;
                } catch {
                    return false;
                }
            })
            .toBe(true);
        const actions = running.page.locator('.tab-actions');
        const pendingBounds = await actions.boundingBox();
        if (!pendingBounds) throw new Error('Pending editor actions have no bounds');
        const pendingTabBounds = await running.page
            .locator('.work-tabs .work-tab')
            .first()
            .boundingBox();
        await running.page.screenshot({
            path: test.info().outputPath('history-pending.png'),
            clip: {
                x: pendingBounds.x - 200,
                y: pendingBounds.y,
                width: 200 + pendingBounds.width,
                height: pendingBounds.height,
            },
        });

        await writeFile(release, '');
        await expect(
            running.page.getByRole('button', { name: 'Open Last Commit Changes' }),
        ).toBeVisible();
        await expect(
            running.page.getByRole('button', { name: 'Open Pull Request Changes' }),
        ).toBeVisible();
        const readyBounds = await actions.boundingBox();
        const readyTabBounds = await running.page
            .locator('.work-tabs .work-tab')
            .first()
            .boundingBox();
        expect(readyBounds?.x).toBe(pendingBounds.x);
        expect(readyBounds?.width).toBe(pendingBounds.width);
        expect(readyTabBounds?.width).toBe(pendingTabBounds?.width);
        await running.page.screenshot({
            path: test.info().outputPath('history-ready.png'),
            clip: {
                x: pendingBounds.x - 200,
                y: pendingBounds.y,
                width: 200 + pendingBounds.width,
                height: pendingBounds.height,
            },
        });

        await running.page.getByRole('treeitem', { name: 'untracked.txt', exact: true }).click();
        await expect(
            running.page.getByRole('button', { name: 'Open Last Commit Changes' }),
        ).toHaveCount(0);
        await expect(
            running.page.getByRole('button', { name: 'Open Pull Request Changes' }),
        ).toHaveCount(0);
        await running.page.screenshot({
            path: test.info().outputPath('no-history.png'),
            clip: {
                x: pendingBounds.x - 200,
                y: pendingBounds.y,
                width: 200 + pendingBounds.width,
                height: pendingBounds.height,
            },
        });
    } finally {
        await writeFile(release, '');
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
