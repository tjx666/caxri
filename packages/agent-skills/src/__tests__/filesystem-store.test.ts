import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
    assertDirectory,
    identityOf,
    isErrno,
    isSameIdentity,
    LAYOUT_FILE,
    MARKER_FILE,
    ownedRecord,
    RELEASE_OWNER_FILE,
    RELEASES_DIRECTORY,
    releaseTarget,
    storeName,
    storePath,
    validateRelease,
    validateStore,
} from '../filesystem-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

async function isolatedDirectory(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), `caxri-filesystem-store-${name}-`));
    temporaryDirectories.push(directory);
    return directory;
}

/**
 * Builds a well-formed managed release directory: a marker file listing `files`, a valid `.caxri-release.json`
 * ownership record, and the file contents themselves (creating any nested parent directories the file paths imply).
 */
async function writeRelease(
    path: string,
    skillName: string,
    files: Record<string, string>,
): Promise<void> {
    await mkdir(path, { recursive: true });
    await Promise.all(
        Object.entries(files).map(async ([name, content]) => {
            const filePath = join(path, ...name.split('/'));
            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, content, 'utf8');
        }),
    );
    await writeFile(join(path, MARKER_FILE), JSON.stringify({ files: Object.keys(files) }), 'utf8');
    await writeFile(join(path, RELEASE_OWNER_FILE), ownedRecord(skillName), 'utf8');
}

describe('isErrno', () => {
    it('matches an error-like object carrying the expected code', () => {
        expect(isErrno({ code: 'ENOENT' }, 'ENOENT')).toBe(true);
    });

    it('rejects a mismatched code', () => {
        expect(isErrno({ code: 'EACCES' }, 'ENOENT')).toBe(false);
    });

    it('rejects non-object and null values', () => {
        expect(isErrno(null, 'ENOENT')).toBe(false);
        expect(isErrno(undefined, 'ENOENT')).toBe(false);
        expect(isErrno('ENOENT', 'ENOENT')).toBe(false);
        expect(isErrno(42, 'ENOENT')).toBe(false);
    });
});

describe('identityOf and isSameIdentity', () => {
    it('projects only dev and ino from a larger metadata object', () => {
        const identity = identityOf({ dev: 1n, ino: 2n, size: 3n } as unknown as {
            dev: bigint;
            ino: bigint;
        });
        expect(identity).toEqual({ dev: 1n, ino: 2n });
        expect(Object.keys(identity)).toHaveLength(2);
    });

    it('treats identical dev/ino pairs as the same identity', () => {
        expect(isSameIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 2n })).toBe(true);
    });

    it('treats a differing dev or ino as a different identity', () => {
        expect(isSameIdentity({ dev: 1n, ino: 2n }, { dev: 9n, ino: 2n })).toBe(false);
        expect(isSameIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 9n })).toBe(false);
    });
});

describe('storeName and storePath', () => {
    it('prefixes the skill name with the managed store marker', () => {
        expect(storeName('caxri-cli')).toBe('.caxri-caxri-cli');
    });

    it('places the store directory next to the target, not inside it', () => {
        expect(storePath('/a/b/caxri-cli', 'caxri-cli')).toBe('/a/b/.caxri-caxri-cli');
    });
});

describe('releaseTarget', () => {
    const uuid = '00000000-0000-4000-8000-000000000000';

    it('accepts a well-formed release path under the skill store', () => {
        const source = `.caxri-caxri-cli/releases/release-${uuid}`;
        expect(releaseTarget('caxri-cli', source)).toBe(source);
    });

    it('rejects a path outside the skill releases prefix', () => {
        expect(releaseTarget('caxri-cli', `.caxri-other/releases/release-${uuid}`)).toBeUndefined();
        expect(releaseTarget('caxri-cli', `.caxri-caxri-cli/release-${uuid}`)).toBeUndefined();
    });

    it('rejects a release suffix that does not match the uuid shape', () => {
        expect(
            releaseTarget('caxri-cli', '.caxri-caxri-cli/releases/release-short'),
        ).toBeUndefined();
    });
});

describe('ownedRecord', () => {
    it('produces a parseable, newline-terminated ownership record for the given name', () => {
        const record = ownedRecord('caxri-cli');
        expect(record.endsWith('\n')).toBe(true);
        expect(JSON.parse(record)).toMatchObject({ managedBy: 'caxri', name: 'caxri-cli' });
    });
});

describe('assertDirectory', () => {
    it('returns the identity of a real directory', async () => {
        const root = await isolatedDirectory('assert-directory');
        const identity = await assertDirectory(root);
        expect(typeof identity.dev).toBe('bigint');
        expect(typeof identity.ino).toBe('bigint');
    });

    it('rejects a symbolic link even when it points at a real directory', async () => {
        const root = await isolatedDirectory('assert-directory-symlink');
        const real = join(root, 'real');
        const link = join(root, 'link');
        await mkdir(real);
        await symlink(real, link, 'dir');
        await expect(assertDirectory(link)).rejects.toThrow(
            'Managed skill directory is not a real directory',
        );
    });

    it('rejects a regular file', async () => {
        const root = await isolatedDirectory('assert-directory-file');
        const file = join(root, 'file.txt');
        await writeFile(file, 'content', 'utf8');
        await expect(assertDirectory(file)).rejects.toThrow(
            'Managed skill directory is not a real directory',
        );
    });

    it('rejects a missing path with the underlying filesystem error', async () => {
        const root = await isolatedDirectory('assert-directory-missing');
        await expect(assertDirectory(join(root, 'missing'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });
});

describe('validateRelease', () => {
    it.skipIf(process.platform === 'win32')(
        'rejects a FIFO planted as the marker instead of blocking on open',
        async () => {
            const root = await isolatedDirectory('validate-release-fifo');
            const releasePath = join(root, 'release-1');
            await mkdir(releasePath, { recursive: true });
            await promisify(execFile)('mkfifo', [join(releasePath, MARKER_FILE)]);
            await writeFile(
                join(releasePath, RELEASE_OWNER_FILE),
                ownedRecord('caxri-cli'),
                'utf8',
            );

            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('marker read blocked')), 2_000);
            });
            try {
                await expect(
                    Promise.race([
                        validateRelease(releasePath, 'relative/release-1', 'caxri-cli'),
                        timeout,
                    ]),
                ).rejects.toThrow('Managed skill file is missing or exceeds its size limit');
            } finally {
                clearTimeout(timer);
            }
        },
    );

    it('reads back file contents, identity, and marker source for a well-formed release', async () => {
        const root = await isolatedDirectory('validate-release-ok');
        const releasePath = join(root, 'release-1');
        await writeRelease(releasePath, 'caxri-cli', {
            'SKILL.md': 'skill body\n',
            'nested/agents/openai.yaml': 'metadata\n',
        });

        const result = await validateRelease(releasePath, 'relative/release-1', 'caxri-cli');
        expect(result.path).toBe(releasePath);
        expect(result.relativePath).toBe('relative/release-1');
        expect(result.files).toEqual({
            'SKILL.md': 'skill body\n',
            'nested/agents/openai.yaml': 'metadata\n',
        });
        expect(typeof result.identity.dev).toBe('bigint');
    });

    it('rejects a marker that is not valid JSON', async () => {
        const root = await isolatedDirectory('validate-release-bad-json');
        const releasePath = join(root, 'release-1');
        await mkdir(releasePath, { recursive: true });
        await writeFile(join(releasePath, MARKER_FILE), 'not json', 'utf8');
        await writeFile(join(releasePath, RELEASE_OWNER_FILE), ownedRecord('caxri-cli'), 'utf8');

        await expect(
            validateRelease(releasePath, 'relative/release-1', 'caxri-cli'),
        ).rejects.toThrow('Managed skill release marker has an invalid file list');
    });

    it('rejects a marker with an empty file list', async () => {
        const root = await isolatedDirectory('validate-release-empty-list');
        const releasePath = join(root, 'release-1');
        await mkdir(releasePath, { recursive: true });
        await writeFile(join(releasePath, MARKER_FILE), JSON.stringify({ files: [] }), 'utf8');
        await writeFile(join(releasePath, RELEASE_OWNER_FILE), ownedRecord('caxri-cli'), 'utf8');

        await expect(
            validateRelease(releasePath, 'relative/release-1', 'caxri-cli'),
        ).rejects.toThrow('Managed skill release marker has an invalid file list');
    });

    it('rejects a marker listing an unsafe path', async () => {
        const root = await isolatedDirectory('validate-release-unsafe-path');
        const releasePath = join(root, 'release-1');
        await mkdir(releasePath, { recursive: true });
        await writeFile(
            join(releasePath, MARKER_FILE),
            JSON.stringify({ files: ['../escape.txt'] }),
            'utf8',
        );
        await writeFile(join(releasePath, RELEASE_OWNER_FILE), ownedRecord('caxri-cli'), 'utf8');

        await expect(
            validateRelease(releasePath, 'relative/release-1', 'caxri-cli'),
        ).rejects.toThrow('Managed skill release marker has an invalid file list');
    });

    it('rejects a marker listing duplicate file names', async () => {
        const root = await isolatedDirectory('validate-release-duplicate');
        const releasePath = join(root, 'release-1');
        await mkdir(releasePath, { recursive: true });
        await writeFile(
            join(releasePath, MARKER_FILE),
            JSON.stringify({ files: ['SKILL.md', 'SKILL.md'] }),
            'utf8',
        );
        await writeFile(join(releasePath, RELEASE_OWNER_FILE), ownedRecord('caxri-cli'), 'utf8');

        await expect(
            validateRelease(releasePath, 'relative/release-1', 'caxri-cli'),
        ).rejects.toThrow('Managed skill release marker has an invalid file list');
    });

    it('rejects a release directory containing a foreign top-level entry', async () => {
        const root = await isolatedDirectory('validate-release-foreign-top');
        const releasePath = join(root, 'release-1');
        await writeRelease(releasePath, 'caxri-cli', { 'SKILL.md': 'skill body\n' });
        await writeFile(join(releasePath, 'intruder.txt'), 'unexpected\n', 'utf8');

        await expect(
            validateRelease(releasePath, 'relative/release-1', 'caxri-cli'),
        ).rejects.toThrow('Managed skill release contains foreign entries');
    });

    it('rejects a release directory containing a foreign entry inside a managed subdirectory', async () => {
        const root = await isolatedDirectory('validate-release-foreign-nested');
        const releasePath = join(root, 'release-1');
        await writeRelease(releasePath, 'caxri-cli', { 'nested/SKILL.md': 'skill body\n' });
        await writeFile(join(releasePath, 'nested', 'intruder.txt'), 'unexpected\n', 'utf8');

        await expect(
            validateRelease(releasePath, 'relative/release-1', 'caxri-cli'),
        ).rejects.toThrow('Managed skill release contains foreign entries');
    });

    it('rejects a release whose ownership record names a different skill', async () => {
        const root = await isolatedDirectory('validate-release-ownership-mismatch');
        const releasePath = join(root, 'release-1');
        await writeRelease(releasePath, 'a-different-skill', { 'SKILL.md': 'skill body\n' });

        await expect(
            validateRelease(releasePath, 'relative/release-1', 'caxri-cli'),
        ).rejects.toThrow('Managed skill release ownership is invalid');
    });

    it('rejects a release whose marker lists a file missing from disk as a mismatched entry', async () => {
        const root = await isolatedDirectory('validate-release-missing-file');
        const releasePath = join(root, 'release-1');
        await mkdir(releasePath, { recursive: true });
        await writeFile(
            join(releasePath, MARKER_FILE),
            JSON.stringify({ files: ['SKILL.md'] }),
            'utf8',
        );
        await writeFile(join(releasePath, RELEASE_OWNER_FILE), ownedRecord('caxri-cli'), 'utf8');

        await expect(
            validateRelease(releasePath, 'relative/release-1', 'caxri-cli'),
        ).rejects.toThrow('Managed skill release contains foreign entries');
    });
});

describe('validateStore', () => {
    async function writeStore(path: string, skillName: string): Promise<void> {
        await mkdir(join(path, RELEASES_DIRECTORY), { recursive: true });
        await writeFile(join(path, LAYOUT_FILE), ownedRecord(skillName), 'utf8');
    }

    it('validates an empty store and returns no releases', async () => {
        const root = await isolatedDirectory('validate-store-empty');
        const storePathValue = join(root, storeName('caxri-cli'));
        await writeStore(storePathValue, 'caxri-cli');

        const result = await validateStore(storePathValue, 'caxri-cli');
        expect(result.releases.size).toBe(0);
        expect(typeof result.identity.dev).toBe('bigint');
    });

    it('rejects a store directory containing a foreign top-level entry', async () => {
        const root = await isolatedDirectory('validate-store-foreign');
        const storePathValue = join(root, storeName('caxri-cli'));
        await writeStore(storePathValue, 'caxri-cli');
        await writeFile(join(storePathValue, 'intruder.txt'), 'unexpected\n', 'utf8');

        await expect(validateStore(storePathValue, 'caxri-cli')).rejects.toThrow(
            'Managed skill store contains foreign entries',
        );
    });

    it('rejects a store whose ownership record names a different skill', async () => {
        const root = await isolatedDirectory('validate-store-ownership-mismatch');
        const storePathValue = join(root, storeName('caxri-cli'));
        await writeStore(storePathValue, 'a-different-skill');

        await expect(validateStore(storePathValue, 'caxri-cli')).rejects.toThrow(
            'Managed skill store ownership is invalid',
        );
    });

    it('rejects a releases directory containing an unrecognized entry name', async () => {
        const root = await isolatedDirectory('validate-store-unknown-release');
        const storePathValue = join(root, storeName('caxri-cli'));
        await writeStore(storePathValue, 'caxri-cli');
        await mkdir(join(storePathValue, RELEASES_DIRECTORY, 'not-a-release'), {
            recursive: true,
        });

        await expect(validateStore(storePathValue, 'caxri-cli')).rejects.toThrow(
            'Managed skill store contains an unknown release entry',
        );
    });

    it('accepts a staged directory entry without listing it as a release', async () => {
        const root = await isolatedDirectory('validate-store-staged');
        const storePathValue = join(root, storeName('caxri-cli'));
        await writeStore(storePathValue, 'caxri-cli');
        await mkdir(join(storePathValue, RELEASES_DIRECTORY, '.stage-abc123'), {
            recursive: true,
        });

        const result = await validateStore(storePathValue, 'caxri-cli');
        expect(result.releases.size).toBe(0);
    });

    it('rejects a staged entry that is not a directory', async () => {
        const root = await isolatedDirectory('validate-store-staged-file');
        const storePathValue = join(root, storeName('caxri-cli'));
        await writeStore(storePathValue, 'caxri-cli');
        await writeFile(join(storePathValue, RELEASES_DIRECTORY, '.stage-abc123'), 'x', 'utf8');

        await expect(validateStore(storePathValue, 'caxri-cli')).rejects.toThrow(
            'Managed skill directory is not a real directory',
        );
    });

    it('validates a well-formed release entry and keys it by its relative path', async () => {
        const root = await isolatedDirectory('validate-store-with-release');
        const storePathValue = join(root, storeName('caxri-cli'));
        await writeStore(storePathValue, 'caxri-cli');
        const uuid = '00000000-0000-4000-8000-000000000000';
        const releaseName = `release-${uuid}`;
        await writeRelease(join(storePathValue, RELEASES_DIRECTORY, releaseName), 'caxri-cli', {
            'SKILL.md': 'skill body\n',
        });

        const result = await validateStore(storePathValue, 'caxri-cli');
        const relativePath = `${storeName('caxri-cli')}/${RELEASES_DIRECTORY}/${releaseName}`;
        expect(result.releases.size).toBe(1);
        expect(result.releases.get(relativePath)?.files).toEqual({ 'SKILL.md': 'skill body\n' });
    });

    it('propagates a corrupted release entry validation failure', async () => {
        const root = await isolatedDirectory('validate-store-corrupted-release');
        const storePathValue = join(root, storeName('caxri-cli'));
        await writeStore(storePathValue, 'caxri-cli');
        const uuid = '00000000-0000-4000-8000-000000000001';
        const releaseName = `release-${uuid}`;
        await writeRelease(
            join(storePathValue, RELEASES_DIRECTORY, releaseName),
            'a-different-skill',
            { 'SKILL.md': 'skill body\n' },
        );

        await expect(validateStore(storePathValue, 'caxri-cli')).rejects.toThrow(
            'Managed skill release ownership is invalid',
        );
    });
});
