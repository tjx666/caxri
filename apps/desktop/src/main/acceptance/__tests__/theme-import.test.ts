import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { admitAcceptanceThemeImport, createAcceptanceThemeImportFixture } from '../theme-import';

const caseId = 'issue-826-surface-seam';
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

const armed = {
    CAXRI_ACCEPTANCE: '1',
    CAXRI_E2E: '1',
    CAXRI_ACCEPTANCE_THEME_IMPORT: caseId,
    CAXRI_TEST_ROOT_PATH: '/unused',
};

describe('Acceptance theme import admission', () => {
    it('leaves the real panel in charge outside Acceptance, even with a stray fixture variable', () => {
        expect(admitAcceptanceThemeImport({})).toEqual({ kind: 'native' });
        expect(admitAcceptanceThemeImport({ ...armed, CAXRI_ACCEPTANCE: undefined })).toEqual({
            kind: 'native',
        });
    });

    it('admits any well-formed case the launcher armed from its frozen plan', () => {
        expect(admitAcceptanceThemeImport(armed)).toEqual({ kind: 'fixture', caseId });
        expect(
            admitAcceptanceThemeImport({ ...armed, CAXRI_ACCEPTANCE_THEME_IMPORT: 'new-case-1' }),
        ).toEqual({ kind: 'fixture', caseId: 'new-case-1' });
    });

    it.each([
        [
            'an undeclared case',
            { CAXRI_ACCEPTANCE: '1', CAXRI_E2E: '1', CAXRI_TEST_ROOT_PATH: '/unused' },
            'undeclared-case',
        ],
        [
            'the raw native-dialog marker alone',
            {
                CAXRI_ACCEPTANCE: '1',
                CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION: 'explicit-user-request',
                CAXRI_E2E: '1',
            },
            'undeclared-case',
        ],
        [
            'a forged native capability',
            { CAXRI_ACCEPTANCE: '1', CAXRI_ACCEPTANCE_NATIVE_THEME_IMPORT: 'true', CAXRI_E2E: '1' },
            'undeclared-case',
        ],
        [
            'a malformed case id',
            { ...armed, CAXRI_ACCEPTANCE_THEME_IMPORT: '../other case' },
            'invalid-case-id',
        ],
        ['an empty case id', { ...armed, CAXRI_ACCEPTANCE_THEME_IMPORT: '' }, 'invalid-case-id'],
        ['a missing E2E gate', { ...armed, CAXRI_E2E: undefined }, 'missing-gate'],
        ['a missing test root', { ...armed, CAXRI_TEST_ROOT_PATH: undefined }, 'missing-gate'],
    ])('rejects %s inside Acceptance', (_, environment, reason) => {
        expect(admitAcceptanceThemeImport(environment)).toEqual({ kind: 'rejected', reason });
    });

    it('keeps the native handoff the launcher derived for an explicitly authorized, declared case', () => {
        expect(
            admitAcceptanceThemeImport({
                CAXRI_ACCEPTANCE: '1',
                CAXRI_ACCEPTANCE_NATIVE_THEME_IMPORT: '1',
                CAXRI_E2E: '1',
            }),
        ).toEqual({ kind: 'native' });
    });
});

describe('Acceptance theme import fixture', () => {
    it('stays out of the way outside Acceptance', () => {
        expect(
            createAcceptanceThemeImportFixture({
                environment: { CAXRI_E2E: '1', CAXRI_ACCEPTANCE_THEME_IMPORT: caseId },
                userDataPath: '/unused',
            }),
        ).toBeUndefined();
    });

    it('fails an undeclared Acceptance import instead of opening the native panel', async () => {
        const fixture = createAcceptanceThemeImportFixture({
            environment: { CAXRI_ACCEPTANCE: '1', CAXRI_E2E: '1', CAXRI_TEST_ROOT_PATH: '/unused' },
            userDataPath: '/unused',
        });
        await expect(fixture?.choose()).rejects.toThrow('did not declare themeImportFixture');
    });

    it('selects only a regular file inside the test root and records each selection once', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-fixture-'));
        directories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        await writeFile(join(root, 'theme.json'), '{}');
        const commandPath = join(directory, 'acceptance-theme-import-command.json');
        const fixture = createAcceptanceThemeImportFixture({
            environment: {
                CAXRI_ACCEPTANCE: '1',
                CAXRI_E2E: '1',
                CAXRI_ACCEPTANCE_THEME_IMPORT: caseId,
                CAXRI_TEST_ROOT_PATH: root,
            },
            userDataPath: directory,
        })!;
        const command = (relativePath: string, sequence: number, requestedCaseId = caseId) =>
            writeFile(
                commandPath,
                JSON.stringify({ caseId: requestedCaseId, relativePath, sequence }),
            );

        await command('theme.json', 1);
        await expect(fixture.choose()).resolves.toBe(await realpath(join(root, 'theme.json')));
        await expect(fixture.choose()).rejects.toThrow('does not match');
        await command('../outside.json', 2);
        await expect(fixture.choose()).rejects.toThrow('escapes');
        await command('theme.json', 2, 'issue-825-include-zero-hit-vsix');
        await expect(fixture.choose()).rejects.toThrow('does not match');
        await symlink(join(root, 'theme.json'), join(root, 'linked.json'));
        await command('linked.json', 2);
        await expect(fixture.choose()).rejects.toThrow('not a file');
        await command('theme.json', 2);
        await expect(fixture.choose()).resolves.toBe(await realpath(join(root, 'theme.json')));
        expect(
            await readFile(join(directory, 'acceptance-theme-import-receipt.jsonl'), 'utf8'),
        ).toBe(
            `${[1, 2]
                .map((sequence) => JSON.stringify({ caseId, relativePath: 'theme.json', sequence }))
                .join('\n')}\n`,
        );
    });
});
