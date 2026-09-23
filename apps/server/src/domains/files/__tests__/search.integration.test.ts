import { Buffer } from 'node:buffer';
import {
    access,
    chmod,
    link,
    mkdir,
    mkdtemp,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { ServerOperationParameters } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { binPathFor } from '@vscode/ripgrep-universal';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}
const ripgrepExecutable = binPathFor({ arch: process.arch, os: process.platform });
const searchWorkerPath = fileURLToPath(new URL('../project-search-worker.ts', import.meta.url));

afterEach(async () => {
    // The fixture owns the logger; service shutdown alone does not drain its queued filesystem writes.
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options?: ConstructorParameters<typeof FileService>[4]) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-search-'));
    temporaryDirectories.push(directory);
    const root = join(directory, 'project');
    await Promise.all([
        mkdir(join(root, 'src'), { recursive: true }),
        mkdir(join(root, 'docs'), { recursive: true }),
        mkdir(join(root, 'node_modules'), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(
            join(root, 'src', 'alpha.ts'),
            [
                'const MagicNeedle = true;',
                'const magicneedleOther = false;',
                'Token tokenized',
            ].join('\n'),
            'utf8',
        ),
        writeFile(join(root, 'src', 'alpha.test.ts'), 'MagicNeedle in test\n', 'utf8'),
        writeFile(join(root, 'docs', 'guide.md'), 'MagicNeedle in docs\n', 'utf8'),
        writeFile(join(root, 'node_modules', 'hidden.ts'), 'MagicNeedle hidden\n', 'utf8'),
        writeFile(join(root, 'binary.bin'), Buffer.from([77, 0, 78])),
        writeFile(join(root, 'oversized.txt'), 'MagicNeedle'.repeat(300), 'utf8'),
    ]);
    const outside = join(directory, 'outside.txt');
    await writeFile(outside, 'MagicNeedle outside\n', 'utf8');
    await Promise.all([
        symlink(outside, join(root, 'linked.txt')),
        link(outside, join(root, 'hardlinked.txt')),
    ]);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const session = database.createSession(database.createProject(root).id, 'shell').session;
    const service = new FileService(
        database,
        () => {},
        createLogger(join(directory, 'logs')),
        () => 1_024,
        {
            ...options,
            search: {
                executablePath: ripgrepExecutable,
                workerPath: searchWorkerPath,
                ...options?.search,
            },
        },
    );
    return { database, root, service, session };
}

async function fakeRipgrep(paths: string[], requiredArgument?: string) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-fake-rg-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'rg');
    const marker = join(directory, 'executed');
    await writeFile(
        executable,
        [
            `#!${process.execPath}`,
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes');`,
            ...(requiredArgument
                ? [
                      `if (!process.argv.includes(${JSON.stringify(requiredArgument)})) process.exit(3);`,
                  ]
                : []),
            `process.stdout.write(${JSON.stringify(`${paths.join('\0')}\0`)});`,
        ].join('\n'),
        { mode: 0o755 },
    );
    return { executable, marker };
}

function searchParameters(
    sessionId: string,
    overrides: Partial<ServerOperationParameters<'files.search'>> = {},
): ServerOperationParameters<'files.search'> {
    return {
        sessionId,
        consumer: 'project-search',
        mode: 'content',
        query: 'MagicNeedle',
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        include: '',
        exclude: '',
        useIgnoreFiles: true,
        ...overrides,
    };
}

describe('SearchService', () => {
    it('searches names and bounded text with case, word, regex, include, and exclude controls', async () => {
        const { database, service, session } = await fixture();
        try {
            const names = await service.search(
                searchParameters(session.id, { mode: 'name', query: 'alpha' }),
            );
            expect(names.matches.map((match) => match.relativePath)).toEqual([
                'src/alpha.test.ts',
                'src/alpha.ts',
            ]);
            expect(names.terminationReason).toBe('completed');

            const content = await service.search(
                searchParameters(session.id, { include: 'src/**', exclude: '*.test.ts' }),
            );
            expect(content.matches).toMatchObject([
                { relativePath: 'src/alpha.ts', line: 1, column: 7, previewMatchIndex: 6 },
                { relativePath: 'src/alpha.ts', line: 2, column: 7, previewMatchIndex: 6 },
            ]);
            expect(content.matches.every((match) => match.preview!.length <= 300)).toBe(true);

            const caseSensitive = await service.search(
                searchParameters(session.id, { caseSensitive: true }),
            );
            expect(
                caseSensitive.matches
                    .map((match) => match.relativePath)
                    .toSorted((a, b) => a.localeCompare(b)),
            ).toEqual(['docs/guide.md', 'src/alpha.test.ts', 'src/alpha.ts']);

            const wholeWord = await service.search(
                searchParameters(session.id, { query: 'Token', wholeWord: true }),
            );
            expect(wholeWord.matches).toHaveLength(1);
            expect(wholeWord.matches[0]).toMatchObject({ relativePath: 'src/alpha.ts', line: 3 });

            const regex = await service.search(
                searchParameters(session.id, { query: 'MagicN[a-z]+', regex: true }),
            );
            expect(regex.matches).toHaveLength(4);
            expect(regex.matches.some((match) => match.relativePath.includes('node_modules'))).toBe(
                false,
            );
            expect(regex.matches.some((match) => match.relativePath === 'linked.txt')).toBe(false);
            expect(regex.matches.some((match) => match.relativePath === 'hardlinked.txt')).toBe(
                false,
            );
            expect(regex.matches.some((match) => match.relativePath === 'binary.bin')).toBe(false);
            expect(regex.matches.some((match) => match.relativePath === 'oversized.txt')).toBe(
                false,
            );
        } finally {
            await service.close();
            database.close();
        }
    });

    it("lets the Project's own ignore files narrow the scan, and lets the user turn that off", async () => {
        const { database, root, service, session } = await fixture();
        try {
            await writeFile(join(root, '.gitignore'), 'docs/\n', 'utf8');

            const ignored = await service.search(searchParameters(session.id));
            expect(ignored.matches.some((match) => match.relativePath === 'docs/guide.md')).toBe(
                false,
            );

            // Off is the wider search: the fixed traversal exclusions still hold, so node_modules stays out either way.
            const everything = await service.search(
                searchParameters(session.id, { useIgnoreFiles: false }),
            );
            expect(everything.matches.some((match) => match.relativePath === 'docs/guide.md')).toBe(
                true,
            );
            expect(
                everything.matches.some((match) => match.relativePath.includes('node_modules')),
            ).toBe(false);
        } finally {
            await service.close();
            database.close();
        }
    });

    it('rejects invalid regex and never accepts an arbitrary root in place of a Session', async () => {
        const fake = await fakeRipgrep(['src/alpha.ts']);
        const { database, service, session } = await fixture({
            search: { executablePath: fake.executable },
        });
        try {
            await expect(
                service.search(searchParameters(session.id, { query: '[', regex: true })),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            await expect(access(fake.marker)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(service.search(searchParameters('missing-session'))).rejects.toMatchObject(
                {
                    code: 'NOT_FOUND',
                },
            );
        } finally {
            await service.close();
            database.close();
        }
    });

    it('does not let excluded paths consume the file limit', async () => {
        const fake = await fakeRipgrep(['src/alpha.ts'], '!generated/**');
        const bounded = await fixture({
            search: { executablePath: fake.executable, maxScannedFiles: 1 },
        });
        await mkdir(join(bounded.root, 'generated'));
        await Promise.all([
            writeFile(join(bounded.root, 'generated', 'one.ts'), 'MagicNeedle\n', 'utf8'),
            writeFile(join(bounded.root, 'generated', 'two.ts'), 'MagicNeedle\n', 'utf8'),
        ]);
        try {
            const result = await bounded.service.search(
                searchParameters(bounded.session.id, { exclude: 'generated/**' }),
            );
            expect(new Set(result.matches.map((match) => match.relativePath))).toEqual(
                new Set(['src/alpha.ts']),
            );
            expect(result).toMatchObject({ scannedFiles: 1, terminationReason: 'completed' });
        } finally {
            await bounded.service.close();
            bounded.database.close();
        }
    });

    it('preserves the existing one-or-more-directory semantics for recursive exclude globs', async () => {
        const { database, root, service, session } = await fixture();
        await Promise.all([
            writeFile(join(root, 'layered.ts'), 'LayerNeedle root\n', 'utf8'),
            writeFile(join(root, 'src', 'layered.ts'), 'LayerNeedle nested\n', 'utf8'),
            mkdir(join(root, 'scope', 'child'), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(join(root, 'scope', 'direct.ts'), 'DirectNeedle direct\n', 'utf8'),
            writeFile(join(root, 'scope', 'child', 'direct.ts'), 'DirectNeedle nested\n', 'utf8'),
        ]);
        try {
            const leadingRecursive = await service.search(
                searchParameters(session.id, {
                    exclude: '**/layered.ts',
                    query: 'LayerNeedle',
                }),
            );
            expect(leadingRecursive.matches.map((match) => match.relativePath)).toEqual([
                'layered.ts',
            ]);

            const middleRecursive = await service.search(
                searchParameters(session.id, {
                    exclude: 'scope/**/direct.ts',
                    query: 'DirectNeedle',
                }),
            );
            expect(middleRecursive.matches.map((match) => match.relativePath)).toEqual([
                'scope/direct.ts',
            ]);
        } finally {
            await service.close();
            database.close();
        }
    });

    it('keeps accessible results when ripgrep skips an unreadable directory', async () => {
        const { database, root, service, session } = await fixture();
        const unreadable = join(root, 'unreadable');
        await mkdir(unreadable);
        await writeFile(join(unreadable, 'hidden.txt'), 'MagicNeedle hidden\n', 'utf8');
        await chmod(unreadable, 0);
        try {
            const result = await service.search(searchParameters(session.id));
            expect(result.terminationReason).toBe('completed');
            expect(result.matches.some((match) => match.relativePath === 'src/alpha.ts')).toBe(
                true,
            );
            expect(result.matches.some((match) => match.relativePath.includes('unreadable'))).toBe(
                false,
            );
        } finally {
            await chmod(unreadable, 0o755);
            await service.close();
            database.close();
        }
    });

    it('keeps Search and path-browser consumers independent within one Session', async () => {
        const { database, service, session } = await fixture();
        try {
            const content = service.search({
                ...searchParameters(session.id),
                consumer: 'project-search',
            });
            const names = service.search({
                ...searchParameters(session.id, { mode: 'name', query: 'alpha' }),
                consumer: 'path-browser',
            });
            const [contentResult, nameResult] = await Promise.all([content, names]);
            expect(contentResult).toMatchObject({
                canceled: false,
                terminationReason: 'completed',
            });
            expect(nameResult).toMatchObject({ canceled: false, terminationReason: 'completed' });
            expect(contentResult.matches.length).toBeGreaterThan(0);
            expect(nameResult.matches.map((match) => match.relativePath)).toEqual([
                'src/alpha.test.ts',
                'src/alpha.ts',
            ]);
        } finally {
            await service.close();
            database.close();
        }
    });

    it.each(['project-search', 'path-browser'] as const)(
        'cancels superseded %s work and reports result and time bounds explicitly',
        async (consumer) => {
            const bounded = await fixture({ search: { maxResults: 1 } });
            try {
                const result = await bounded.service.search(searchParameters(bounded.session.id));
                expect(result.matches).toHaveLength(1);
                expect(result.truncated).toBe(true);
                expect(result.terminationReason).toBe('result-limit');

                const first = bounded.service.search(
                    searchParameters(bounded.session.id, { query: 'never-found', consumer }),
                );
                const second = bounded.service.search(
                    searchParameters(bounded.session.id, {
                        mode: 'name',
                        query: 'alpha',
                        consumer,
                    }),
                );
                await expect(first).resolves.toMatchObject({
                    canceled: true,
                    matches: [],
                    terminationReason: 'canceled',
                });
                await expect(second).resolves.toMatchObject({
                    canceled: false,
                    terminationReason: 'result-limit',
                });
            } finally {
                await bounded.service.close();
                bounded.database.close();
            }

            const timed = await fixture({ search: { timeoutMs: 0 } });
            try {
                await expect(
                    timed.service.search(searchParameters(timed.session.id)),
                ).resolves.toMatchObject({
                    truncated: true,
                    canceled: false,
                    terminationReason: 'timeout',
                });
            } finally {
                await timed.service.close();
                timed.database.close();
            }
        },
    );

    it('terminates pathological regular expressions without blocking Server Core', async () => {
        const timed = await fixture({ search: { timeoutMs: 150 } });
        try {
            await writeFile(join(timed.root, '000-pathological.txt'), `${'a'.repeat(48)}!`, 'utf8');
            const search = timed.service.search(
                searchParameters(timed.session.id, { query: '^(a|aa)+$', regex: true }),
            );
            await expect(
                new Promise((resolve) => setTimeout(() => resolve('responsive'), 20)),
            ).resolves.toBe('responsive');
            await expect(search).resolves.toMatchObject({
                canceled: false,
                terminationReason: 'timeout',
                truncated: true,
            });
        } finally {
            await timed.service.close();
            timed.database.close();
        }
    });

    it('terminates active search workers when the Files domain closes', async () => {
        const active = await fixture({ search: { timeoutMs: 5_000 } });
        await writeFile(join(active.root, '000-pathological.txt'), `${'a'.repeat(48)}!`, 'utf8');
        const search = active.service.search(
            searchParameters(active.session.id, { query: '^(a|aa)+$', regex: true }),
        );

        await active.service.close();
        await expect(search).resolves.toMatchObject({
            canceled: true,
            matches: [],
            terminationReason: 'canceled',
        });
        active.database.close();
    });

    it('locates Project directories by path suffix while excluding dependency trees and symlinks', async () => {
        const { database, root, service, session } = await fixture();
        try {
            await Promise.all([
                mkdir(join(root, 'sub', 'packages', 'bank', 'src'), { recursive: true }),
                mkdir(join(root, 'apps', 'web', 'packages', 'bank'), { recursive: true }),
                mkdir(join(root, 'node_modules', 'packages', 'bank'), { recursive: true }),
            ]);
            await symlink(join(root, 'sub', 'packages'), join(root, 'docs', 'packages'));

            const canonicalRoot = await realpath(root);
            const located = await service.locateDirectory({
                sessionId: session.id,
                suffix: 'Packages/Bank',
            });
            expect(located).toEqual({
                path: join(canonicalRoot, 'sub', 'packages', 'bank'),
                truncated: false,
            });

            await expect(
                service.locateDirectory({ sessionId: session.id, suffix: 'src/alpha.ts' }),
            ).resolves.toEqual({ path: null, truncated: false });
            await expect(
                service.locateDirectory({ sessionId: session.id, suffix: '../packages' }),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
        } finally {
            await service.close();
            database.close();
        }
    });

    it('reports the file limit separately from a complete empty search', async () => {
        const bounded = await fixture({ search: { maxScannedFiles: 1 } });
        try {
            const result = await bounded.service.search(
                searchParameters(bounded.session.id, { query: 'not-present' }),
            );
            expect(result).toMatchObject({
                canceled: false,
                terminationReason: 'file-limit',
                truncated: true,
            });
            expect(result.scannedFiles).toBeLessThanOrEqual(1);
        } finally {
            await bounded.service.close();
            bounded.database.close();
        }
    });
});
