import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

/**
 * Mirrors `scripts/__tests__/workspace-contract.test.ts`'s CLI-scoped `looseTestFiles` walker for the Desktop source
 * trees that are not the Renderer: `.agents/skills/source-layout/SKILL.md` "Place tests" requires Desktop Main, Server,
 * and system package tests to live in a domain-local `__tests__/` directory. The Renderer is deliberately excluded:
 * colocated `foo.test.ts` beside `foo.ts` is the documented, allowed placement there.
 */
function looseTestFiles(directory: string): string[] {
    const found: string[] = [];
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (['dist', 'node_modules', '__tests__'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...looseTestFiles(path));
        else if (/\.test\.ts$/u.test(entry.name)) found.push(path);
    }
    return found;
}

/**
 * `.agents/skills/source-layout/SKILL.md` "Place tests": React components are never unit-tested as `.tsx`; logic is
 * extracted into a plain module instead. This walks the whole tree (not just Desktop source) because the rule has no
 * legitimate exception anywhere in the repository, unlike the `__tests__`-vs-colocated placement rule above.
 */
function testTsxFiles(directory: string): string[] {
    const found: string[] = [];
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (
            [
                '.git',
                '.records',
                'competitors',
                'node_modules',
                'out',
                'release',
                'release.noindex',
            ].includes(entry.name)
        )
            continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...testTsxFiles(path));
        else if (entry.name.endsWith('.test.tsx')) found.push(path);
    }
    return found;
}

describe('test placement contract', () => {
    it('keeps Desktop Main, Server, and system tests inside __tests__/ (Renderer stays colocated)', () => {
        for (const domain of [
            'apps/desktop/src/main',
            'apps/desktop/src/shared',
            'apps/server/src/core',
            'apps/server/src/domains',
            'packages/system/src',
        ]) {
            expect(looseTestFiles(join(root, domain)), `${domain} loose *.test.ts files`).toEqual(
                [],
            );
        }
    });

    it('never unit-tests a .tsx component directly', () => {
        expect(testTsxFiles(root), 'components are not unit-tested; logic gets extracted').toEqual(
            [],
        );
    });
});
