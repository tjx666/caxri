import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectAndroidCases } from '../../scripts/mobile-android-case-collector';
import { cases as adapterCases } from '../../scripts/mobile-android-case-definitions/adapter';
import {
    collectMobileAndroidCaseHandlers,
    executeMobileAndroidCase,
    mobileAndroidCaseGroups,
} from './mobile-android-case-registry';

const definitionsDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../scripts/mobile-android-case-definitions',
);

describe('mobile Android case registry', () => {
    it('pairs every definition group with a handler group of the same name', () => {
        const definitionGroups = readdirSync(definitionsDirectory)
            .filter((file) => file.endsWith('.ts'))
            .map((file) => file.slice(0, -'.ts'.length))
            .toSorted((a, b) => a.localeCompare(b));
        expect(mobileAndroidCaseGroups()).toEqual(definitionGroups);
    });

    it('registers exactly one handler for every case the runner hands to Playwright', async () => {
        const definitions = await collectAndroidCases();
        // The runner drives the adapter group itself and never starts Playwright for it.
        for (const caseId of Object.keys(adapterCases)) delete definitions[caseId];
        const handlers = await collectMobileAndroidCaseHandlers();
        expect(
            handlers
                .keys()
                .toArray()
                .toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(Object.keys(definitions).toSorted((a, b) => a.localeCompare(b)));
    });

    it('rejects a case id two handler groups register', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'android-case-handlers-'));
        try {
            const group = "export const handlers = { 'MOB-X-01': async () => {} };";
            writeFileSync(join(directory, 'a.ts'), group);
            writeFileSync(join(directory, 'b.ts'), group);
            await expect(collectMobileAndroidCaseHandlers(directory)).rejects.toThrow(
                'Duplicate Android case handler: MOB-X-01',
            );
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it('rejects a case id no handler group registers', async () => {
        await expect(
            executeMobileAndroidCase(
                {
                    artifactManifestPath: 'manifest.json',
                    assetsDirectory: 'assets',
                    caseId: 'MOB-UNKNOWN-01',
                    scenarioReceiptPath: 'receipt.txt',
                    serial: 'emulator-5554',
                },
                [],
            ),
        ).rejects.toThrow('Unsupported Playwright mobile Acceptance case: MOB-UNKNOWN-01');
    });
});
