import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..');

/**
 * Files that may publish through a temporary path and `rename` without `writeJsonAtomic` / `writeTextAtomic`, each with
 * the reason the shared helper cannot own it. A new entry needs the same kind of justification.
 */
const ALLOWED_INLINE_RENAMES = new Map<string, string>([
    [
        '.agents/skills/switch-worktree/scripts/repo.ts',
        'didWriteJsonExclusive publishes through link(2) so it can fail on an existing target, which rename cannot',
    ],
]);

async function sourceFiles(directory: string): Promise<string[]> {
    let entries: Dirent[] = [];
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        // A skill without a scripts directory has nothing to scan.
    }
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                return entry.name === 'node_modules' || entry.name === '__tests__'
                    ? []
                    : sourceFiles(path);
            }
            return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
        }),
    );
    return nested.flat();
}

async function toolingFiles(): Promise<string[]> {
    const skills = await readdir(join(repoRoot, '.agents', 'skills'), {
        withFileTypes: true,
    });
    const roots = [
        join(repoRoot, 'scripts'),
        ...skills
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(repoRoot, '.agents', 'skills', entry.name, 'scripts')),
    ];
    return (await Promise.all(roots.map(sourceFiles))).flat();
}

/**
 * Returns the identifiers that are written to (`writeFile`, `writeFileSync`, or an exclusive `open`) and later renamed
 * in the same file (by `rename` or `link`): the inline temp-file-then-publish pair this repository replaced with the
 * shared helper.
 */
function inlineAtomicPairs(source: string): string[] {
    const renamed = source
        .matchAll(/\b(?:rename|renameSync|link|linkSync)\(\s*([A-Za-z_]\w*)\s*,/g)
        .map((match) => match[1])
        .toArray();
    return renamed.filter((identifier) =>
        new RegExp(String.raw`\b(?:writeFile|writeFileSync|open)\(\s*${identifier}\b`).test(source),
    );
}

describe('atomic write contract', () => {
    it('detects an inline write-then-rename pair', () => {
        expect(
            inlineAtomicPairs('await writeFile(temporary, data);\nawait rename(temporary, path);'),
        ).toEqual(['temporary']);
        expect(inlineAtomicPairs('await rename(source, destination);')).toEqual([]);
    });

    it('publishes tooling state only through the shared atomic writers', async () => {
        const offenders: string[] = [];
        const staleAllowlist = new Set(ALLOWED_INLINE_RENAMES.keys());
        const files = await toolingFiles();
        for (const file of files) {
            const path = relative(repoRoot, file).split(sep).join('/');
            if (path === 'scripts/atomic-json.ts') continue;
            // eslint-disable-next-line no-await-in-loop -- a few dozen small files; sequential keeps failures ordered
            if (inlineAtomicPairs(await readFile(file, 'utf8')).length === 0) continue;
            if (ALLOWED_INLINE_RENAMES.has(path)) staleAllowlist.delete(path);
            else offenders.push(path);
        }
        expect([...staleAllowlist], 'Remove allowlist entries that no longer match').toEqual([]);
        expect(
            offenders,
            'Use writeJsonAtomic or writeTextAtomic from scripts/atomic-json.ts instead of an inline temp-file rename',
        ).toEqual([]);
    });
});
