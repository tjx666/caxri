import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const mobileChangesPaths = {
    added: 'notes/added-note.md',
    binary: 'assets/synthetic.bin',
    deleted: 'notes/removed-note.md',
    modified: 'a-synthetic-sample.ts',
    oversized: 'src/oversized.ts',
} as const;

export type MobileChangesFixtureKind = 'standard' | 'limits';

async function git(root: string, arguments_: string[]): Promise<void> {
    await execFileAsync('git', arguments_, { cwd: root });
}

/**
 * Seeds only invented text and bytes in the disposable Acceptance Project.
 */
export async function seedMobileChangesFixture(
    root: string,
    kind: MobileChangesFixtureKind,
): Promise<void> {
    await Promise.all([
        mkdir(join(root, 'src'), { recursive: true }),
        mkdir(join(root, 'notes'), { recursive: true }),
        ...(kind === 'limits' ? [mkdir(join(root, 'assets'), { recursive: true })] : []),
    ]);
    await git(root, ['init', '-q', '--initial-branch=main']);
    await Promise.all([
        writeFile(join(root, mobileChangesPaths.modified), 'export const sample = 1;\n'),
        writeFile(join(root, mobileChangesPaths.deleted), 'Synthetic note to remove.\n'),
        ...(kind === 'limits'
            ? [
                  writeFile(join(root, mobileChangesPaths.binary), Buffer.from([0, 1, 2, 3])),
                  writeFile(join(root, mobileChangesPaths.oversized), 'export const size = 1;\n'),
              ]
            : []),
    ]);
    await git(root, ['add', '--', '.']);
    await git(root, [
        '-c',
        'user.name=Synthetic Acceptance',
        '-c',
        'user.email=synthetic@example.invalid',
        'commit',
        '-q',
        '-m',
        'test: seed synthetic mobile changes',
    ]);
    await Promise.all([
        ...(kind === 'standard'
            ? [
                  writeFile(
                      join(root, mobileChangesPaths.modified),
                      `export const sample = '${'Synthetic horizontal diff content. '.repeat(32)}';\n`,
                  ),
                  writeFile(join(root, mobileChangesPaths.added), 'Synthetic added note.\n'),
                  rm(join(root, mobileChangesPaths.deleted)),
              ]
            : []),
        ...(kind === 'limits'
            ? [
                  writeFile(join(root, mobileChangesPaths.binary), Buffer.from([0, 4, 5, 6])),
                  writeFile(
                      join(root, mobileChangesPaths.oversized),
                      `export const syntheticLines = [\n${Array.from(
                          { length: 3_000 },
                          (_, index) => `  'Synthetic line ${String(index).padStart(4, '0')}',\n`,
                      ).join('')}] as const;\n`,
                  ),
              ]
            : []),
    ]);
}
