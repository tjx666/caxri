/**
 * Shrink-only inventory of high-density source directories. Every directory in the tree with 12 or more direct
 * production modules must be listed; the ratchet test discovers them tree-wide.
 *
 * `source-layout` says a cohesive cluster of three or more modules belongs in its own directory, but the Renderer
 * feature lint rule and the Server domain-root structure test only cover their own roots. These owners kept growing
 * flat because nothing counted them. The caps below record the current number of direct production modules (`*.ts` /
 * `*.tsx`, excluding tests) so adding a file fails, and removing one demands tightening the cap in the same change
 * (`scripts/__tests__/directory-density-ratchet.test.ts`).
 *
 * To lower a cap after moving files into a subdirectory, edit the number here. Never raise one: place the new module in
 * a cohesive subdirectory instead.
 */

export interface DirectoryDensityOwner {
    /**
     * Maximum (and current) direct production module count.
     */
    cap: number;
    /**
     * Repository-relative directory.
     */
    directory: string;
}

export interface DirectoryDensityFamily extends DirectoryDensityOwner {
    /**
     * Filename prefix (including the trailing hyphen) that identifies the flat family.
     */
    prefix: string;
}

export const DIRECTORY_DENSITY_OWNERS: readonly DirectoryDensityOwner[] = [
    { cap: 66, directory: 'apps/desktop/src/main' },
    { cap: 52, directory: 'apps/desktop/src/renderer/src/features/editor' },
    { cap: 27, directory: 'apps/desktop/src/renderer/src/features/editor/git' },
    { cap: 21, directory: 'apps/desktop/src/renderer/src/features/view-containers' },
    { cap: 16, directory: 'apps/desktop/src/renderer/src/features/view-containers/extension-tree' },
    {
        cap: 24,
        directory: 'apps/desktop/src/renderer/src/features/view-containers/resource-explorer',
    },
    { cap: 24, directory: 'apps/desktop/src/renderer/src/features/view-containers/source-control' },
    { cap: 32, directory: 'apps/server/src/domains/agent-chat' },
    { cap: 25, directory: 'apps/server/src/domains/agent-chat/providers/claude' },
    { cap: 15, directory: 'apps/server/src/domains/agent-chat/providers/codex' },
    { cap: 9, directory: 'apps/desktop/src/renderer/src/features/agent-chat' },
    { cap: 18, directory: 'apps/desktop/src/main/ssh' },
    { cap: 12, directory: 'apps/desktop/src/main/updates' },
    { cap: 74, directory: 'packages/protocol/src/domain' },
    { cap: 56, directory: 'packages/protocol/src/agent' },
    { cap: 15, directory: 'packages/protocol/src/domain/logging' },
    { cap: 47, directory: 'apps/desktop/src/renderer/src/features/agent-chat/hooks' },
    { cap: 18, directory: 'apps/desktop/src/renderer/src/features/agent-chat/transcript' },
    { cap: 22, directory: 'apps/desktop/src/renderer/src/features/agent-chat/loading/glyphs' },
    { cap: 18, directory: 'apps/desktop/src/renderer/src/features/agent-chat/composer' },
    { cap: 11, directory: 'apps/desktop/src/renderer/src/features/agent-chat/composer-input' },
    { cap: 17, directory: 'apps/desktop/src/renderer/src/features/agent-chat/context' },
    { cap: 17, directory: 'apps/desktop/src/renderer/src/features/agent-chat/turns' },
    { cap: 14, directory: 'apps/desktop/src/renderer/src/features/agent-chat/loading' },
    { cap: 12, directory: 'apps/desktop/src/renderer/src/features/agent-chat/messages' },
    { cap: 13, directory: 'apps/desktop/src/renderer/src/features/agent-chat/tools' },
    { cap: 11, directory: 'apps/desktop/src/renderer/src/features/agent-chat/attachments' },
    { cap: 10, directory: 'apps/desktop/src/renderer/src/features/agent-chat/tasks' },
    { cap: 12, directory: 'apps/desktop/src/renderer/src/features/agent-chat/activity' },

    // Desktop Renderer
    { cap: 12, directory: 'apps/desktop/src/renderer/src/features/agent-activity' },
    { cap: 21, directory: 'apps/desktop/src/renderer/src/features/benchmark' },
    { cap: 15, directory: 'apps/desktop/src/renderer/src/features/bug-report' },
    { cap: 39, directory: 'apps/desktop/src/renderer/src/features/caxri-bot' },
    { cap: 17, directory: 'apps/desktop/src/renderer/src/features/delegation' },
    { cap: 15, directory: 'apps/desktop/src/renderer/src/features/performance-monitor' },
    { cap: 38, directory: 'apps/desktop/src/renderer/src/features/preview' },
    { cap: 74, directory: 'apps/desktop/src/renderer/src/features/primary-sidebar' },
    { cap: 24, directory: 'apps/desktop/src/renderer/src/features/primary-sidebar/hooks' },
    { cap: 13, directory: 'apps/desktop/src/renderer/src/features/process-explorer' },
    { cap: 46, directory: 'apps/desktop/src/renderer/src/features/session' },
    { cap: 81, directory: 'apps/desktop/src/renderer/src/features/settings' },
    { cap: 23, directory: 'apps/desktop/src/renderer/src/features/ssh-host' },
    { cap: 46, directory: 'apps/desktop/src/renderer/src/features/status-bar' },
    { cap: 72, directory: 'apps/desktop/src/renderer/src/features/terminal' },
    { cap: 21, directory: 'apps/desktop/src/renderer/src/features/usage' },
    { cap: 34, directory: 'apps/desktop/src/renderer/src/features/workbench' },
    { cap: 27, directory: 'apps/desktop/src/renderer/src/components' },
    { cap: 24, directory: 'apps/desktop/src/renderer/src/components/markdown' },
    { cap: 25, directory: 'apps/desktop/src/renderer/src/components/ui' },
    { cap: 25, directory: 'apps/desktop/src/renderer/src/hooks' },
    { cap: 54, directory: 'apps/desktop/src/renderer/src/lib' },
    { cap: 34, directory: 'apps/desktop/src/renderer/src/stores' },

    // Mobile
    { cap: 20, directory: 'apps/mobile/scripts' },
    { cap: 34, directory: 'apps/mobile/src/components' },
    { cap: 158, directory: 'apps/mobile/src/features/agent-chat' },
    { cap: 12, directory: 'apps/mobile/src/features/changes' },
    { cap: 39, directory: 'apps/mobile/src/features/connection' },
    { cap: 39, directory: 'apps/mobile/src/features/conversation' },
    { cap: 23, directory: 'apps/mobile/src/features/panels' },
    { cap: 36, directory: 'apps/mobile/src/features/sessions' },
    { cap: 53, directory: 'apps/mobile/src/features/sessions/components' },
    { cap: 28, directory: 'apps/mobile/src/features/sessions/hooks' },
    { cap: 22, directory: 'apps/mobile/src/features/terminal' },

    // Server
    { cap: 54, directory: 'apps/server/src/core' },
    { cap: 23, directory: 'apps/server/src/core/extensions' },
    { cap: 42, directory: 'apps/server/src/core/mobile' },
    { cap: 32, directory: 'apps/server/src/core/mobile/gateway' },
    { cap: 17, directory: 'apps/server/src/core/terminal-host' },
    { cap: 46, directory: 'apps/server/src/domains' },
    { cap: 37, directory: 'apps/server/src/domains/agent-delegation' },
    { cap: 12, directory: 'apps/server/src/domains/agent-dispatch' },
    { cap: 63, directory: 'apps/server/src/domains/agents' },
    { cap: 23, directory: 'apps/server/src/domains/agents/hooks' },
    { cap: 16, directory: 'apps/server/src/domains/agents/providers/claude' },
    { cap: 19, directory: 'apps/server/src/domains/agents/providers/codex' },
    { cap: 24, directory: 'apps/server/src/domains/bot' },
    { cap: 27, directory: 'apps/server/src/domains/db' },
    { cap: 38, directory: 'apps/server/src/domains/db/models' },
    { cap: 14, directory: 'apps/server/src/domains/db/schema' },
    { cap: 13, directory: 'apps/server/src/domains/external-status' },
    { cap: 23, directory: 'apps/server/src/domains/files' },
    { cap: 35, directory: 'apps/server/src/domains/git' },
    { cap: 34, directory: 'apps/server/src/domains/project-status' },
    { cap: 26, directory: 'apps/server/src/domains/session' },
    { cap: 45, directory: 'apps/server/src/domains/terminal' },
    { cap: 26, directory: 'apps/server/src/domains/usage' },
    { cap: 19, directory: 'apps/server/src/domains/workbench' },
    { cap: 17, directory: 'apps/server/src/extension-host' },
    { cap: 12, directory: 'apps/server/src/terminal-host' },
    { cap: 19, directory: 'apps/server/src/terminal-host/engine' },

    // CLI, extensions, and packages
    { cap: 17, directory: 'apps/cli/src/commands' },
    { cap: 18, directory: 'extensions/git/src' },
    { cap: 13, directory: 'extensions/status/src' },
    { cap: 12, directory: 'packages/client/src/supervise' },
    { cap: 16, directory: 'packages/markdown/src' },
    { cap: 29, directory: 'packages/protocol/src/configuration' },
    { cap: 28, directory: 'packages/protocol/src/desktop' },
    { cap: 38, directory: 'packages/protocol/src/mobile' },
    { cap: 19, directory: 'packages/protocol/src/transport' },
    { cap: 14, directory: 'packages/system/src/process' },
    { cap: 20, directory: 'packages/utils/src' },

    // Repository tooling
    { cap: 126, directory: 'scripts' },
    { cap: 16, directory: 'scripts/eslint-rules' },
    { cap: 46, directory: 'scripts/mobile-android-case-definitions' },
    { cap: 15, directory: 'tools/oxlint/anti-slop/rules' },
    { cap: 40, directory: '.agents/skills/acceptance/scripts' },
    { cap: 14, directory: '.agents/skills/debug/scripts' },
    { cap: 12, directory: '.agents/skills/promo-images/scripts' },
    { cap: 14, directory: '.agents/skills/quality-check/scripts' },
    { cap: 17, directory: '.agents/skills/switch-worktree/scripts' },
];

/**
 * Any directory with at least this many direct production modules must have its own owner entry, wherever it sits in
 * the tree. Discovery is tree-wide (`findUnlistedDenseDirectories`), so a dense directory nobody remembered to list
 * fails the ratchet instead of growing unguarded, and splitting a dense root only moves the guarded count one level
 * down.
 */
const DIRECTORY_DENSITY_NESTED_THRESHOLD = 12;

/**
 * Path segments whose contents are not production source for density purposes: tests, fixtures, generated output,
 * dependencies, locale data (one flat file per namespace by design), and the `e2e/` test-support root. `scripts/` and
 * skill script directories are counted: repository tooling grows flat like any other source.
 */
const NON_PRODUCTION_SEGMENT =
    /(?:^|\/)(?:__tests__|fixtures|generated|node_modules|e2e|locales)(?:\/|$)/u;

/**
 * True when a repository-relative path is a production module counted toward its directory's density: a `*.ts` /
 * `*.tsx` file that is not a test, declaration, or generated file, and not under a non-production segment.
 */
function isDirectoryDensityModule(path: string): boolean {
    return (
        /\.tsx?$/u.test(path) &&
        !/\.test\.tsx?$/u.test(path) &&
        !path.endsWith('.d.ts') &&
        !path.endsWith('.generated.ts') &&
        !NON_PRODUCTION_SEGMENT.test(path)
    );
}

/**
 * Directories (with their direct production module counts) that reach `threshold` but have no owner entry. Takes the
 * file list as a parameter so tests can inject a synthetic tree.
 */
export function findUnlistedDenseDirectories(
    paths: readonly string[],
    owners: readonly DirectoryDensityOwner[] = DIRECTORY_DENSITY_OWNERS,
    threshold: number = DIRECTORY_DENSITY_NESTED_THRESHOLD,
): Array<{ count: number; directory: string }> {
    const listed = new Set(owners.map(({ directory }) => directory));
    const counts = new Map<string, number>();
    for (const path of paths) {
        const slash = path.lastIndexOf('/');
        if (slash === -1 || !isDirectoryDensityModule(path)) continue;
        const directory = path.slice(0, slash);
        counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
    return [...counts]
        .filter(([directory, count]) => count >= threshold && !listed.has(directory))
        .map(([directory, count]) => ({ count, directory }))
        .toSorted((a, b) => a.directory.localeCompare(b.directory));
}

export const DIRECTORY_DENSITY_FAMILIES: readonly DirectoryDensityFamily[] = [
    { cap: 23, directory: 'apps/server/src/domains/agent-chat', prefix: 'chat-' },
    { cap: 5, directory: 'apps/desktop/src/main', prefix: 'desktop-' },
];

/**
 * True when a changed path can alter a guarded directory's count. Used by CI routing: the ratchet reads the filesystem,
 * so `vitest related` never links it to the files it counts.
 */
export function isDirectoryDensityPath(path: string): boolean {
    return [...DIRECTORY_DENSITY_OWNERS, ...DIRECTORY_DENSITY_FAMILIES].some(({ directory }) =>
        path.startsWith(`${directory}/`),
    );
}

export const DIRECTORY_DENSITY_TEST = 'scripts/__tests__/directory-density-ratchet.test.ts';
