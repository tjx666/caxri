import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeMethodParams as RuntimeMethodParameters } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
    await symlink(outside, join(root, 'linked.txt'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const session = database.createSession(database.createProject(root).id, 'shell').session;
    const service = new FileService(
        database,
        () => {},
        new StructuredLogger(join(directory, 'logs')),
        () => 1_024,
        options,
    );
    return { database, root, service, session };
}

function searchParameters(
    sessionId: string,
    overrides: Partial<RuntimeMethodParameters<'files.search'>> = {},
): RuntimeMethodParameters<'files.search'> {
    return {
        sessionId,
        mode: 'content',
        query: 'MagicNeedle',
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        include: '',
        exclude: '',
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
            expect(regex.matches.some((match) => match.relativePath === 'binary.bin')).toBe(false);
            expect(regex.matches.some((match) => match.relativePath === 'oversized.txt')).toBe(
                false,
            );
        } finally {
            await service.close();
            database.close();
        }
    });

    it('rejects invalid regex and never accepts an arbitrary root in place of a Session', async () => {
        const { database, service, session } = await fixture();
        try {
            await expect(
                service.search(searchParameters(session.id, { query: '[', regex: true })),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
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

    it('cancels superseded work and reports result and time bounds explicitly', async () => {
        const bounded = await fixture({ search: { maxResults: 1 } });
        try {
            const result = await bounded.service.search(searchParameters(bounded.session.id));
            expect(result.matches).toHaveLength(1);
            expect(result.truncated).toBe(true);

            const first = bounded.service.search(
                searchParameters(bounded.session.id, { query: 'never-found' }),
            );
            const second = bounded.service.search(
                searchParameters(bounded.session.id, { mode: 'name', query: 'alpha' }),
            );
            await expect(first).resolves.toMatchObject({ canceled: true, matches: [] });
            await expect(second).resolves.toMatchObject({ canceled: false });
        } finally {
            await bounded.service.close();
            bounded.database.close();
        }

        const timed = await fixture({ search: { timeoutMs: 0 } });
        try {
            await expect(
                timed.service.search(searchParameters(timed.session.id)),
            ).resolves.toMatchObject({ truncated: true, canceled: false });
        } finally {
            await timed.service.close();
            timed.database.close();
        }
    });
});
