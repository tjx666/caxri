import { execFile } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const source = join(root, 'native', 'file-ops.c');
const outputDirectory = join(root, 'out', 'native');
const output = join(outputDirectory, 'caxri-file-ops');

await mkdir(outputDirectory, { recursive: true });

if (process.platform === 'darwin') {
    await run('clang', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-x',
        'objective-c',
        '-fobjc-arc',
        source,
        '-framework',
        'Foundation',
        '-o',
        output,
    ]);
} else if (process.platform === 'linux') {
    await run('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output]);
} else {
    throw new Error(`The native file operations helper does not support ${process.platform}`);
}

await chmod(output, 0o755);
