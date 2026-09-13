import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const rendererSourceRoot = join(root, 'apps/desktop/src/renderer/src');

/**
 * Pre-cutover Desktop paths React Doctor still evaluates against the candidate config so a directory move cannot look
 * like a newly introduced finding. They are not expected at HEAD.
 */
const PRE_CUTOVER_BASELINE_PREFIXES = ['src/renderer/', 'src/main/'] as const;

/**
 * Renamed Server composition roots kept beside their successors so changed-scope comparison stays equivalent. Retiring
 * them is a separate judgment; the contract only records that they may be absent.
 */
const RETAINED_MISSING_PATHS = new Set([
    'apps/server/src/domains/bootstrap-service-handlers.ts',
    'apps/server/src/domains/bootstrap.ts',
]);

interface DoctorIgnoreOverride {
    files?: string[];
    rules?: string[];
}

interface DoctorConfig {
    ignore?: {
        files?: string[];
        overrides?: DoctorIgnoreOverride[];
    };
}

interface ComponentsConfig {
    aliases?: Record<string, string>;
}

function isGlobPath(path: string): boolean {
    return path.includes('*');
}

function isDeclaredBaselinePath(path: string): boolean {
    return (
        PRE_CUTOVER_BASELINE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
        RETAINED_MISSING_PATHS.has(path)
    );
}

function doctorConfigPaths(config: DoctorConfig): string[] {
    return [
        ...(config.ignore?.files ?? []),
        ...(config.ignore?.overrides ?? []).flatMap((override) => override.files ?? []),
    ];
}

function missingLiveDoctorPaths(
    paths: readonly string[],
    isPresent: (path: string) => boolean,
): string[] {
    return paths.filter(
        (path) => !isGlobPath(path) && !isDeclaredBaselinePath(path) && !isPresent(path),
    );
}

function resolveAliasTarget(alias: string): string[] {
    const remainder = alias.replace(/^@\//u, '');
    const base = join(rendererSourceRoot, remainder);
    return [base, `${base}.ts`, `${base}.tsx`];
}

describe('doctor and shadcn path references', () => {
    it('keeps non-glob doctor paths at HEAD or on the declared baseline list', async () => {
        const config = parseJsonc(
            await readFile(join(root, 'doctor.config.jsonc'), 'utf8'),
        ) as DoctorConfig;
        const paths = doctorConfigPaths(config);

        expect(paths.some((path) => path.startsWith('src/renderer/'))).toBe(true);
        expect(paths).toEqual(expect.arrayContaining([...RETAINED_MISSING_PATHS]));
        expect(missingLiveDoctorPaths(paths, (path) => existsSync(join(root, path)))).toEqual([]);
    });

    it('fails when a live doctor path is missing and undeclared', () => {
        expect(
            missingLiveDoctorPaths(
                ['apps/server/src/does-not-exist.ts', 'src/renderer/src/lib/monaco.ts'],
                (path) => existsSync(join(root, path)),
            ),
        ).toEqual(['apps/server/src/does-not-exist.ts']);
    });

    it('resolves every shadcn alias to an existing Renderer file or directory', async () => {
        const components = JSON.parse(
            await readFile(join(root, 'components.json'), 'utf8'),
        ) as ComponentsConfig;

        expect(components.aliases?.utils).toBe('@/lib/utilities');
        const aliases = Object.values(components.aliases ?? {});
        for (const alias of aliases) {
            expect(alias.startsWith('@/')).toBe(true);
            expect(resolveAliasTarget(alias).some((candidate) => existsSync(candidate))).toBe(true);
        }
    });
});
