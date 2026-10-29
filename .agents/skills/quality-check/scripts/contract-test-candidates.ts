/**
 * Contract tests that scan source or config files at runtime instead of importing them, so import-based discovery in
 * `check.ts` cannot select them. Each selector maps a changed-path pattern to the contract it could break.
 *
 * Only whole-tree contracts belong here: ones that walk a directory's structure or react to deleted paths, plus
 * contracts over an aggregated resource whose sources reach the test only through ordinary imports that discovery
 * deliberately does not follow. A test that asserts on specific files' text imports them with `?raw` or
 * `import.meta.glob`, which import discovery already follows.
 */

import {
    DIRECTORY_DENSITY_TEST,
    isDirectoryDensityPath,
} from '../../../../scripts/directory-density-baseline';
import {
    CI_E2E_LOG_SAFETY_TEST,
    isCiE2ELogSafetyScanPath,
} from '../../../../scripts/reporters/ci-e2e-log-safety-scope';

/**
 * Every runtime-scanning contract test that the changed and removed paths could break.
 */
export function contractTestCandidates(
    files: readonly string[],
    removedFiles: readonly string[],
): string[] {
    return [
        ...rendererContractTestCandidates(files),
        ...serverDomainContractTestCandidates(files),
        ...pathReferenceContractTestCandidates(files, removedFiles),
        ...dependencyManifestContractTestCandidates(files),
        ...directoryDensityContractTestCandidates(files, removedFiles),
        ...localeContractTestCandidates(files, removedFiles),
        ...e2ePoolContractTestCandidates(files, removedFiles),
        ...ciLogSafetyContractTestCandidates(files, removedFiles),
    ];
}

/**
 * Renderer contracts scan source files at runtime, so import-based test discovery cannot find them.
 */
function rendererContractTestCandidates(files: readonly string[]): string[] {
    if (
        files.every((file) => !file.replaceAll('\\', '/').startsWith('apps/desktop/src/renderer/'))
    ) {
        return [];
    }
    return [
        'apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts',
        'apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts',
        ...reactCompilerContractTestCandidates(files),
        ...prototypeRuntimeContractTestCandidates(files),
    ];
}

const RENDERER_SOURCE_ROOT = 'apps/desktop/src/renderer/src/';

/**
 * The React Compiler coverage test compiles every Renderer source and compares the bailouts with its ledger, so the
 * import graph never selects it. A conditional inside a hook's `try` block once passed every local gate and failed
 * first in the `guards` job.
 */
function reactCompilerContractTestCandidates(files: readonly string[]): string[] {
    return files.some((file) => file.replaceAll('\\', '/').startsWith(RENDERER_SOURCE_ROOT))
        ? ['scripts/__tests__/react-compiler-coverage.test.ts']
        : [];
}

/**
 * The Runtime domain structure test scans the source tree instead of importing it, so the import graph never selects
 * it; a cross-domain import it rejects once passed every local gate and failed only CI's full suite.
 */
function serverDomainContractTestCandidates(files: readonly string[]): string[] {
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
function pathReferenceContractTestCandidates(
    files: readonly string[],
    removedFiles: readonly string[],
): string[] {
    return removedFiles.length > 0 || files.some((file) => PATH_REFERENCE_CONFIGS.has(file))
        ? ['scripts/__tests__/doctor-config-paths.test.ts']
        : [];
}

const DEPENDENCY_MANIFESTS = new Set(['package.json', 'pnpm-workspace.yaml']);

/**
 * A workspace manifest is read by the toolchain contract (every tracked `package.json`) and the workspace package
 * contract (each workspace's exact `scripts`), but not by the root-only dependency contract. Editing every workspace
 * `typecheck` script once passed the focused check and failed first in CI's sharded unit suite.
 */
const WORKSPACE_MANIFEST = /^(?:apps|packages|extensions)\/[^/]+\/package\.json$/u;

/**
 * The toolchain contract scans every tracked Dockerfile for a copy of the `mise.toml` Node.js or pnpm version, and no
 * test imports a Dockerfile. A Relay image that pinned pnpm passed the focused check and failed only the full suite.
 */
const DOCKERFILE = /(?:^|\/)Dockerfile$/u;

/**
 * Contracts that read only the root `package.json`: its exact scripts, `build` packaging settings, and Knip config.
 * Adding a step to the root `build` script once passed the focused check and failed first in CI's sharded unit suite on
 * `workspace-contract`'s pinned script.
 */
const ROOT_PACKAGE_CONTRACTS = [
    'scripts/__tests__/eslint-toolchain-contract.test.ts',
    'scripts/__tests__/extension-test-packaging.test.ts',
    'scripts/__tests__/oxlint-toolchain-contract.test.ts',
];

/**
 * The dependency and toolchain contracts read the root manifests at runtime. `patchedDependencies` keys carry exact
 * versions, so a dependency upgrade that edited only `pnpm-workspace.yaml` once passed every focused gate and failed
 * first in CI's full suite.
 */
function dependencyManifestContractTestCandidates(files: readonly string[]): string[] {
    const normalized = files.map((file) => file.replaceAll('\\', '/'));
    const rootManifestChanged = normalized.some((file) => DEPENDENCY_MANIFESTS.has(file));
    const rootPackageChanged = normalized.includes('package.json');
    const workspaceManifestChanged = normalized.some((file) => WORKSPACE_MANIFEST.test(file));
    const dockerfileChanged = normalized.some((file) => DOCKERFILE.test(file));
    return [
        ...(dockerfileChanged ? ['scripts/__tests__/toolchain-contract.test.ts'] : []),
        ...(rootManifestChanged || workspaceManifestChanged
            ? [
                  'scripts/__tests__/toolchain-contract.test.ts',
                  'scripts/__tests__/workspace-package-contract.test.ts',
              ]
            : []),
        ...(rootPackageChanged || workspaceManifestChanged
            ? ['scripts/__tests__/workspace-contract.test.ts']
            : []),
        ...(rootManifestChanged ? ['scripts/__tests__/workspace-dependency-contract.test.ts'] : []),
        ...(rootPackageChanged ? ROOT_PACKAGE_CONTRACTS : []),
    ];
}

/**
 * The directory density ratchet counts files on disk, so import discovery never links it to a module added to or
 * removed from a guarded directory. CI's affected scope already selects it this way; without the same rule here a new
 * hook passed every local gate and failed only the PR's hosted `checks`.
 */
function directoryDensityContractTestCandidates(
    files: readonly string[],
    removedFiles: readonly string[],
): string[] {
    return [...files, ...removedFiles].some((file) =>
        isDirectoryDensityPath(file.replaceAll('\\', '/')),
    )
        ? [DIRECTORY_DENSITY_TEST]
        : [];
}

/**
 * The E2E pool contract reads every top-level spec's source to require a `clipboard`, `gpu`, or `visible-window` entry
 * in `e2e/support/pools.ts`, so the import graph never links it to a spec. A spec switched to `clipboard: true` once
 * passed every local gate and failed first in the hosted unit shard.
 */
function e2ePoolContractTestCandidates(
    files: readonly string[],
    removedFiles: readonly string[],
): string[] {
    return [...files, ...removedFiles].some((file) =>
        /^e2e\/[^/]+\.e2e\.ts$/u.test(file.replaceAll('\\', '/')),
    )
        ? ['scripts/__tests__/e2e-pools.test.ts']
        : [];
}

/**
 * Every source that feeds the Renderer's locale resources: the locale catalogs themselves, the Desktop-shared command
 * and window copy, and the protocol's Agent Chat labels.
 */
const LOCALE_SOURCES = [
    'apps/desktop/src/renderer/src/i18n/locales/',
    'apps/desktop/src/shared/i18n/',
    'packages/protocol/src/agent/agent-chat-labels',
];

const LOCALE_CONTRACT_TESTS = [
    'apps/desktop/src/renderer/src/i18n/__tests__/i18n.test.ts',
    'apps/desktop/src/renderer/src/i18n/__tests__/zh-cn-terminology.test.ts',
    'apps/desktop/src/renderer/src/i18n/__tests__/english-counterpart-parity.test.ts',
];

/**
 * The i18n contracts import the aggregated `enResources`/`zhCNResources`, which each catalog reaches through object
 * literals rather than pure re-exports, so import discovery stops before the test. An untranslated "Session" in a zh-CN
 * Settings description once passed `check --test` and failed first in CI's sharded unit suite.
 */
function localeContractTestCandidates(
    files: readonly string[],
    removedFiles: readonly string[],
): string[] {
    return [...files, ...removedFiles].some((file) =>
        LOCALE_SOURCES.some((prefix) => file.replaceAll('\\', '/').startsWith(prefix)),
    )
        ? [...LOCALE_CONTRACT_TESTS]
        : [];
}

/**
 * The public CI log safety contract scans every executable source for Playwright launches and reporter overrides, so
 * import discovery never selects it. A promo capture script launching Playwright with its own config once passed `check
 * --test` and failed first in the PR's hosted unit suite (#2769). Selecting on the whole scan scope rather than on
 * reporter keywords also covers a deleted launcher and an edit that removes the last keyword.
 */
function ciLogSafetyContractTestCandidates(
    files: readonly string[],
    removedFiles: readonly string[],
): string[] {
    return [...files, ...removedFiles].some((file) =>
        isCiE2ELogSafetyScanPath(file.replaceAll('\\', '/')),
    )
        ? [CI_E2E_LOG_SAFETY_TEST]
        : [];
}
