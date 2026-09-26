import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const mobileRoot = fileURLToPath(new URL('../../apps/mobile/src/', import.meta.url));
const scenarioPaths = [
    fileURLToPath(new URL('../mobile-dashboard-parity.e2e.ts', import.meta.url)),
    fileURLToPath(new URL('../mobile-acceptance-scenarios.e2e.ts', import.meta.url)),
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
    it.each(scenarioPaths)('references controls that still exist in the mobile UI: %s', (path) => {
        const source = readFileSync(path, 'utf8');
        const ids = [
            ...source.matchAll(/checkId\s*===\s*'([^']+)'/gu),
            ...source.matchAll(/tapMobileCheck\([^,]+,\s*'([^']+)'/gu),
        ].map((match) => match[1]);
        expect(ids.length).toBeGreaterThan(0);
        const stale = ids.filter(
            (id) =>
                !mobileSources.includes(`'${id}'`) &&
                !mobileSources.includes(`"${id}"`) &&
                templatePrefixes.every((prefix) => !id.startsWith(prefix)),
        );
        expect(stale).toEqual([]);
    });
});
