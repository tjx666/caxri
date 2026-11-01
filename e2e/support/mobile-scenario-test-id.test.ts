import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const mobileRoot = fileURLToPath(new URL('../../apps/mobile/src/', import.meta.url));
const caseHandlersRoot = join(import.meta.dirname, 'mobile-android-case-handlers');
/**
 * Each scenario source by name. The Android case handler modules are read as one source: a runner-driven group such as
 * `adapter.ts` has no handler, and so no test ID, of its own.
 */
const scenarioSources: Array<[name: string, source: string]> = [
    ...[
        fileURLToPath(new URL('../mobile-dashboard-parity.e2e.ts', import.meta.url)),
        ...readdirSync(import.meta.dirname)
            .filter((name) => /^mobile-.*-scenarios\.ts$/u.test(name))
            .map((name) => join(import.meta.dirname, name)),
    ].map((path): [string, string] => [path, readFileSync(path, 'utf8')]),
    [
        caseHandlersRoot,
        readdirSync(caseHandlersRoot)
            .filter((name) => name.endsWith('.ts'))
            .map((name) => readFileSync(join(caseHandlersRoot, name), 'utf8'))
            .join('\n'),
    ],
];

const mobileSources = readdirSync(mobileRoot, { recursive: true, withFileTypes: true })
    .filter(
        (entry) =>
            entry.isFile() &&
            /\.tsx?$/u.test(entry.name) &&
            !entry.name.endsWith('.test.ts') &&
            !entry.name.endsWith('.generated.ts'),
    )
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');

const templatePrefixes = mobileSources
    .matchAll(/`([^$`]+)\$\{/gu)
    .map((match) => match[1])
    .toArray();

describe('mobile Acceptance scenario test IDs', () => {
    it.each(scenarioSources)(
        'references controls that still exist in the mobile UI: %s',
        (_, source) => {
            const ids = [
                ...source.matchAll(/checkId\s*===\s*'([^']+)'/gu),
                ...source.matchAll(
                    /(?:tapMobileCheck(?:ByBounds)?|hasCheck|observeMobileNode|waitForCheck|waitForNoCheck)\([^,]+,\s*'([^']+)'/gu,
                ),
            ].map((match) => match[1]);
            expect(ids.length).toBeGreaterThan(0);
            const stale = ids.filter(
                (id) =>
                    !mobileSources.includes(`'${id}'`) &&
                    !mobileSources.includes(`"${id}"`) &&
                    templatePrefixes.every((prefix) => !id.startsWith(prefix)),
            );
            expect(stale).toEqual([]);
        },
    );
});
