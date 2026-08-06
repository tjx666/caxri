import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { createProjectSession, launchCaxri } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('Status Bar links Project, primary branch, pull request, and changes', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-statusbar-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'status-project');
    const bin = join(testDirectory, 'bin');
    const gh = join(bin, 'gh');
    const ghCalls = join(testDirectory, 'gh-calls');
    await execFileAsync('mkdir', ['-p', root, bin]);
    await writeFile(
        gh,
        `#!/bin/sh\nprintf 'call\\n' >> '${ghCalls}'\nprintf '%s' '{"number":11,"title":"Linked Status Bar","url":"https://github.com/tjx666/status-project/pull/11"}'\n`,
        'utf8',
    );
    await chmod(gh, 0o755);
    await execFileAsync('git', ['init', '-b', 'feature/status-bar'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/status-project.git'],
        { cwd: root },
    );
    await writeFile(join(root, 'tracked.txt'), 'before\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'after\n', 'utf8');

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        await createProjectSession(running.page);
        const project = running.page.getByRole('button', {
            name: 'Open project files: status-project',
        });
        const branch = running.page.getByRole('link', {
            name: 'Open branch feature/status-bar',
        });
        const pullRequest = running.page.getByRole('link', {
            name: 'Open pull request #11',
        });
        const changes = running.page.getByRole('button', { name: 'Open 1 changes' });
        await expect(project).toBeVisible();
        await expect(branch).toHaveAttribute(
            'href',
            'https://github.com/tjx666/status-project/tree/feature%2Fstatus-bar',
        );
        await expect(pullRequest).toHaveAttribute(
            'href',
            'https://github.com/tjx666/status-project/pull/11',
        );
        await expect(changes).toBeVisible();
        const [projectColor, branchColor, changesColor] = await Promise.all(
            [project, branch, changes].map((item) =>
                item.evaluate((element) => getComputedStyle(element).color),
            ),
        );
        expect([projectColor, branchColor, changesColor]).toEqual([
            branchColor,
            branchColor,
            branchColor,
        ]);

        await running.page.getByRole('button', { name: 'Hide Inspector' }).click();
        await project.click();
        await expect(running.page.locator('.inspector')).toBeVisible();
        await expect(running.page.getByRole('button', { name: 'Collapse Folders' })).toBeVisible();
        await changes.click();
        await expect(running.page.getByText('Source Control', { exact: true })).toBeVisible();

        await writeFile(join(root, 'untracked.txt'), 'new\n', 'utf8');
        await expect(running.page.getByRole('button', { name: 'Open 2 changes' })).toBeVisible();
        expect((await readFile(ghCalls, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
