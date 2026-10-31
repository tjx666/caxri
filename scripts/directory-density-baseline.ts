/**
 * Shrink-only inventory of high-density source directories.
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
    { cap: 20, directory: 'apps/desktop/src/main/ssh' },
    { cap: 81, directory: 'packages/protocol/src/domain' },
    { cap: 56, directory: 'packages/protocol/src/agent' },
    { cap: 15, directory: 'packages/protocol/src/domain/logging' },
    { cap: 47, directory: 'apps/desktop/src/renderer/src/features/agent-chat/hooks' },
    { cap: 20, directory: 'apps/desktop/src/renderer/src/features/agent-chat/transcript' },
    { cap: 22, directory: 'apps/desktop/src/renderer/src/features/agent-chat/loading/glyphs' },
    { cap: 19, directory: 'apps/desktop/src/renderer/src/features/agent-chat/composer' },
    { cap: 11, directory: 'apps/desktop/src/renderer/src/features/agent-chat/composer-input' },
    { cap: 17, directory: 'apps/desktop/src/renderer/src/features/agent-chat/context' },
    { cap: 17, directory: 'apps/desktop/src/renderer/src/features/agent-chat/turns' },
    { cap: 14, directory: 'apps/desktop/src/renderer/src/features/agent-chat/loading' },
    { cap: 13, directory: 'apps/desktop/src/renderer/src/features/agent-chat/messages' },
    { cap: 13, directory: 'apps/desktop/src/renderer/src/features/agent-chat/tools' },
    { cap: 11, directory: 'apps/desktop/src/renderer/src/features/agent-chat/attachments' },
    { cap: 12, directory: 'apps/desktop/src/renderer/src/features/agent-chat/tasks' },
    { cap: 12, directory: 'apps/desktop/src/renderer/src/features/agent-chat/activity' },
];

/**
 * A subdirectory below a guarded owner with at least this many direct production modules must have its own owner entry.
 * Without it, splitting a dense root into subdirectories only moves the unguarded growth one level down.
 */
export const DIRECTORY_DENSITY_NESTED_THRESHOLD = 12;

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
