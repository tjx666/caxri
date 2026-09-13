import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAcceptanceThemeImportFixture } from '../acceptance-theme-import';

const caseId = 'issue-826-surface-seam';
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

describe('Acceptance theme import fixture', () => {
    it('is disabled outside the fixed isolated case', () => {
        expect(
            createAcceptanceThemeImportFixture({
                environment: { CAXRI_ACCEPTANCE: '1', CAXRI_E2E: '1' },
                userDataPath: '/unused',
            }),
        ).toBeUndefined();
        expect(
            createAcceptanceThemeImportFixture({
                environment: {
                    CAXRI_ACCEPTANCE: '1',
                    CAXRI_E2E: '1',
                    CAXRI_ACCEPTANCE_THEME_IMPORT: 'other-case',
                    CAXRI_TEST_ROOT_PATH: '/unused',
                },
                userDataPath: '/unused',
            }),
        ).toBeUndefined();
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
