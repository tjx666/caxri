import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    ACCEPTANCE_UPDATE_FIXTURE_ID,
    admitAcceptanceUpdateFixture,
    createAcceptanceUpdateFixture,
} from '../update';

const armed = {
    CAXRI_ACCEPTANCE: '1',
    CAXRI_ACCEPTANCE_UPDATE: `${ACCEPTANCE_UPDATE_FIXTURE_ID}:update-notification`,
    CAXRI_E2E: '1',
};
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

async function userDataDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-update-fixture-'));
    directories.push(directory);
    return directory;
}

describe('Acceptance update fixture admission', () => {
    it('admits only the launcher value inside an unpackaged Acceptance launch', () => {
        expect(admitAcceptanceUpdateFixture(armed, { isPackaged: false })).toEqual({
            admitted: true,
            caseId: 'update-notification',
            release: { fileName: 'Caxri-999.0.0-arm64.dmg', version: '999.0.0' },
        });
    });

    it.each([
        ['no declaration', { CAXRI_ACCEPTANCE: '1', CAXRI_E2E: '1' }, false, 'not-requested'],
        ['a packaged build', armed, true, 'packaged-build'],
        [
            'a normal launch',
            { CAXRI_ACCEPTANCE_UPDATE: armed.CAXRI_ACCEPTANCE_UPDATE },
            false,
            'outside-acceptance',
        ],
        ['plain E2E', { ...armed, CAXRI_ACCEPTANCE: undefined }, false, 'outside-acceptance'],
        ['Acceptance without E2E', { ...armed, CAXRI_E2E: undefined }, false, 'outside-acceptance'],
    ] as const)(
        'keeps the ordinary update behavior for %s',
        (_, environment, isPackaged, reason) => {
            expect(admitAcceptanceUpdateFixture(environment, { isPackaged })).toEqual({
                admitted: false,
                reason,
            });
            expect(
                createAcceptanceUpdateFixture({ environment, isPackaged, userDataPath: '/unused' }),
            ).toBeUndefined();
        },
    );

    it.each([
        ['an unknown fixture id', 'ready:update-notification', 'unknown-fixture'],
        ['a padded fixture id', ' available:update-notification', 'unknown-fixture'],
        ['a bare fixture id without its case', 'available', 'invalid-case-id'],
        ['an empty value', '', 'unknown-fixture'],
        ['a malformed case id', 'available:../update notification', 'invalid-case-id'],
        ['a repeated fixture', 'available:available:update-notification', 'invalid-case-id'],
    ])('visibly rejects %s inside Acceptance', async (_, value, reason) => {
        const environment = { ...armed, CAXRI_ACCEPTANCE_UPDATE: value };
        expect(admitAcceptanceUpdateFixture(environment, { isPackaged: false })).toEqual({
            admitted: false,
            reason,
            rejected: true,
        });
        const fixture = createAcceptanceUpdateFixture({
            environment,
            isPackaged: false,
            userDataPath: '/unused',
        });
        await expect(fixture?.discover()).rejects.toThrow(`was rejected (${reason})`);
    });

    it('serves the fixed release once per launch and records the case it served', async () => {
        const directory = await userDataDirectory();
        const fixture = createAcceptanceUpdateFixture({
            environment: armed,
            isPackaged: false,
            userDataPath: directory,
        })!;

        await expect(fixture.discover()).resolves.toEqual({
            fileName: 'Caxri-999.0.0-arm64.dmg',
            version: '999.0.0',
        });
        await expect(fixture.discover()).rejects.toThrow('already served in this launch');
        expect(await readFile(join(directory, 'acceptance-update-receipt.jsonl'), 'utf8')).toBe(
            `${JSON.stringify({ caseId: 'update-notification', fixture: 'available', version: '999.0.0' })}\n`,
        );
    });
});
