import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { readBoundedTextFile } from '../text-file';

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    const paths = [...directories];
    directories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

async function scratch(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-text-file-'));
    directories.push(directory);
    return directory;
}

/**
 * Rejects instead of hanging the suite when the read blocks.
 */
async function settle(read: Promise<string>): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('read blocked')), 2_000);
    });
    try {
        return await Promise.race([read, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

describe('readBoundedTextFile', () => {
    it('reads a regular file within the limit', async () => {
        const path = join(await scratch(), 'task.txt');
        await writeFile(path, 'hello');
        await expect(readBoundedTextFile(path, 1_024, 'task')).resolves.toBe('hello');
    });

    it('rejects an oversized file', async () => {
        const path = join(await scratch(), 'task.txt');
        await writeFile(path, 'x'.repeat(2_048));
        await expect(readBoundedTextFile(path, 1_024, 'task')).rejects.toThrow(
            'task must be a regular file of at most 1 KiB',
        );
    });

    it('rejects a final symlink', async () => {
        const directory = await scratch();
        await writeFile(join(directory, 'real.txt'), 'x');
        await symlink(join(directory, 'real.txt'), join(directory, 'link.txt'));
        await expect(
            readBoundedTextFile(join(directory, 'link.txt'), 1_024, 'task'),
        ).rejects.toThrow();
    });

    it.skipIf(process.platform === 'win32')(
        'rejects a FIFO promptly instead of blocking on open',
        async () => {
            const path = join(await scratch(), 'task.fifo');
            await run('mkfifo', [path]);
            await expect(settle(readBoundedTextFile(path, 1_024, 'task'))).rejects.toThrow(
                'task must be a regular file of at most 1 KiB',
            );
        },
    );
});
