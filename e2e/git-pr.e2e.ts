import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('Git Pull Request mode shows committed PR changes instead of the working tree', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-pr-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const nested = join(root, 'nested');
    const bin = join(testDirectory, 'bin');
    await execFileAsync('mkdir', ['-p', root, bin]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    /**
     * The Server-wide GitHub projection keys records by `owner/repo`, so a pull-request read resolves `origin` before
     * it consults the shared store. A repository with no GitHub remote never reaches `gh` at all.
     */
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/project.git'],
        { cwd: root },
    );
    await writeFile(join(root, 'tracked.txt'), 'before\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    const baseOid = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();
    await execFileAsync('git', ['switch', '-c', 'feature/pull-request'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'after\n', 'utf8');
    await writeFile(join(root, 'pr-only.txt'), 'pull request\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt', 'pr-only.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'pull request changes'], { cwd: root });
    const headOid = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();
    await writeFile(join(root, 'working-only.txt'), 'working tree\n', 'utf8');
    await execFileAsync('mkdir', ['-p', nested]);
    await execFileAsync('git', ['init', '-b', 'nested-main'], { cwd: nested });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: nested });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: nested });
    // A distinct slug so the nested repository gets its own record instead of joining the root repository's.
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/nested.git'],
        { cwd: nested },
    );
    await writeFile(join(nested, 'nested.txt'), 'nested\n', 'utf8');
    await execFileAsync('git', ['add', 'nested.txt'], { cwd: nested });
    await execFileAsync('git', ['commit', '-m', 'nested initial'], { cwd: nested });

    const gh = join(bin, 'gh');
    await writeFile(
        gh,
        `#!/bin/sh\nprintf '%s' '${JSON.stringify({
            baseRefName: 'main',
            baseRefOid: baseOid,
            headRefName: 'feature/pull-request',
            headRefOid: headOid,
            number: 42,
            title: 'Committed pull request range',
            url: 'https://github.com/tjx666/project/pull/42',
        })}'\n`,
        'utf8',
    );
    await chmod(gh, 0o755);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        /**
         * The deterministic gh fixture intentionally reports the root PR for every repository. Runtime rejects the root
         * OIDs in the unrelated nested repository; Git owns that raw-domain failure and projects it into inline
         * provider state, so the successful outer Source Control snapshot must not surface a second Main-process
         * error.
         */
        allowE2EErrors([
            { source: 'server-core', event: 'ipc.request_failed', code: 'GIT', count: 1 },
        ]);
        await createProjectSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const files = running.page.locator('.git-files');
        await expect(files.locator('.git-row[title="working-only.txt"]')).toBeVisible();

        await running.page.getByRole('button', { name: 'Pull Request Changes' }).click();
        await expect(running.page.getByText('PR #42 Changes', { exact: true })).toBeVisible();
        await expect(files.locator('.git-row[title="pr-only.txt"]')).toBeVisible();
        await expect(files.locator('.git-row[title="tracked.txt"]')).toBeVisible();
        await expect(files.locator('.git-row[title="working-only.txt"]')).toHaveCount(0);
        await expect(
            running.page.getByText('Unable to load pull request changes.', { exact: true }),
        ).toBeVisible();
        await expect(running.page.locator('.toast')).toHaveCount(0);

        await files.locator('.git-row[title="tracked.txt"]').click();
        await expect(running.page.locator('.git-file-diff .monaco-diff-editor')).toBeVisible();
        await expect(running.page.locator('.git-file-diff')).toContainText('before');
        await expect(running.page.locator('.git-file-diff')).toContainText('after');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
