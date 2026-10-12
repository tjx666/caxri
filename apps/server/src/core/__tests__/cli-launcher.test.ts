import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeCliLauncher } from '../cli-launcher';

const execFileAsync = promisify(execFile);

describe('writeCliLauncher', () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'caxri-cli-launcher-'));
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    it('runs the CLI bundle with the given runtime when no node is on PATH', async () => {
        // A quote and a space in the path prove the launcher passes it to `exec` as one argument.
        const bundleDirectory = join(root, "it's a bundle");
        await mkdir(bundleDirectory);
        const cliPath = join(bundleDirectory, 'caxri.cjs');
        await writeFile(
            cliPath,
            'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE }));',
        );

        const launcher = await writeCliLauncher({
            cliPath,
            executable: process.execPath,
            userDataPath: join(root, 'profile'),
        });

        expect(launcher).toBe(join(root, 'profile', 'bin', 'caxri'));
        expect((await stat(launcher)).mode & 0o777).toBe(0o755);
        const { stdout } = await execFileAsync(launcher, ['commander', 'board', "it's"], {
            env: { PATH: '/usr/bin:/bin' },
        });
        expect(JSON.parse(stdout)).toEqual({
            args: ['commander', 'board', "it's"],
            runAsNode: '1',
        });
    });

    it('replaces the launcher of a previous Server build', async () => {
        const userDataPath = join(root, 'profile');
        await writeCliLauncher({
            cliPath: '/old/caxri.cjs',
            executable: '/old/node',
            userDataPath,
        });
        const launcher = await writeCliLauncher({
            cliPath: '/new/caxri.cjs',
            executable: '/new/node',
            userDataPath,
        });
        const script = await readFile(launcher, 'utf8');
        expect(script).toContain(`'/new/node' '/new/caxri.cjs'`);
        expect(script).not.toContain('/old/');
    });
});
