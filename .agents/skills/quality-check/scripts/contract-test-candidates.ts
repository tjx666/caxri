/**
 * Contract tests that scan source or config files at runtime instead of importing them, so import-based discovery in
 * `check.ts` cannot select them. Each selector maps a changed-path pattern to the contract it could break.
 *
 * Only whole-tree contracts belong here: ones that walk a directory's structure or react to deleted paths. A test that
 * asserts on specific files' text imports them with `?raw` or `import.meta.glob`, which import discovery already
 * follows.
 */

/**
 * Renderer contracts scan source files at runtime, so import-based test discovery cannot find them.
 */
export function rendererContractTestCandidates(files: string[]): string[] {
    if (
        files.every((file) => !file.replaceAll('\\', '/').startsWith('apps/desktop/src/renderer/'))
    ) {
        return [];
    }
    return [
        'apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts',
        'apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts',
        ...prototypeRuntimeContractTestCandidates(files),
    ];
}

/**
 * The Runtime domain structure test scans the source tree instead of importing it, so the import graph never selects
 * it; a cross-domain import it rejects once passed every local gate and failed only CI's full suite.
 */
export function serverDomainContractTestCandidates(files: string[]): string[] {
    return files.some((file) => file.replaceAll('\\', '/').startsWith('apps/server/src/domains/'))
        ? ['apps/server/src/domains/__tests__/structure.test.ts']
        : [];
}

const PROTOTYPE_RUNTIME_SOURCES = [
    'apps/desktop/src/renderer/src/components/ui/',
    'apps/desktop/src/renderer/src/hooks/',
];

/**
 * The design-prototype runtime test lists the Renderer `components/ui` and `hooks` directories and requires each module
 * in `assets/entry.mjs`. A hook added under `hooks/` once merged with a green focused check and then turned `main`'s
 * full suite red, because nothing imports the test's subject from the new file.
 */
function prototypeRuntimeContractTestCandidates(files: readonly string[]): string[] {
    return files.some((file) =>
        PROTOTYPE_RUNTIME_SOURCES.some((prefix) => file.replaceAll('\\', '/').startsWith(prefix)),
    )
        ? ['.agents/skills/design-prototype/scripts/build-runtime.test.ts']
        : [];
}

const PATH_REFERENCE_CONFIGS = new Set(['components.json', 'doctor.config.jsonc']);

/**
 * `doctor.config.jsonc` and `components.json` name source paths as plain strings that import-based discovery cannot
 * see. Removing or renaming a source file can leave either config stale without touching it, so any removed path, or an
 * edit to either config, selects the path contract CI's full suite would otherwise be the first to run.
 */
export function pathReferenceContractTestCandidates(
    files: readonly string[],
    removedFiles: readonly string[],
): string[] {
    return removedFiles.length > 0 || files.some((file) => PATH_REFERENCE_CONFIGS.has(file))
        ? ['scripts/__tests__/doctor-config-paths.test.ts']
        : [];
}
