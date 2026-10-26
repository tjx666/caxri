import { relative, sep } from 'node:path';

import type { GitChangeTracker } from './change-tracker';
import type { GitCommandOptions } from './command';
import type { GitDirectoryRepo } from './repo';

type GitRunner = (
    cwd: string,
    arguments_: string[],
    options?: GitCommandOptions,
) => Promise<string>;

/**
 * A batch larger than this is not worth classifying path by path; it bumps its repository as before.
 */
const MAX_CLASSIFIED_PATHS = 512;
/**
 * Bound on remembered ignored directories per repository root.
 */
const MAX_IGNORED_DIRECTORIES = 256;
/**
 * A tracked file under an ignored directory is listed in a few hundred bytes; anything longer is treated as "has one".
 */
const TRACKED_PROBE_BYTES = 4096;

/**
 * Returns ignored direct children of a listed directory using one NUL-delimited Git batch.
 */
export async function readIgnoredEntries(
    git: GitRunner,
    repo: GitDirectoryRepo | undefined,
    names: readonly string[],
): Promise<{ ignoredNames: ReadonlySet<string>; rulePaths: readonly string[] }> {
    if (!repo) return { ignoredNames: new Set(), rulePaths: [] };
    if (names.length === 0) return { ignoredNames: new Set(), rulePaths: repo.ignoreRulePaths };
    const output = await git(repo.directoryPath, ['check-ignore', '--stdin', '-z'], {
        allowFailure: true,
        input: `${names.join('\0')}\0`,
    });
    return {
        ignoredNames: new Set(output.split('\0').filter(Boolean)),
        rulePaths: repo.ignoreRulePaths,
    };
}

/**
 * Root-relative, slash-separated ancestor directories of `path`, shallowest first and slash-terminated, which is the
 * form `git check-ignore` matches directory-only patterns such as `out/` against.
 */
function ancestorDirectories(path: string): string[] {
    const segments = path.split('/');
    return segments.slice(0, -1).map((_, index) => `${segments.slice(0, index + 1).join('/')}/`);
}

/**
 * Drops working-tree changes that Git ignores before they reach the status generations behind `git.changed`.
 *
 * A build in a checkout (`out/`, `dist/`, a mobile build tree) writes thousands of ignored files. Each watcher batch
 * used to re-run `git status`, untracked listing, diff stats, and the worktree list for that repository and every
 * Session on it, only to find nothing changed. One `check-ignore` per batch now answers that, and an ignored directory
 * with no tracked file is remembered, so the rest of the build costs no Git process at all.
 *
 * A tracked file is never dropped: `check-ignore` does not report tracked paths, and a directory holding one is never
 * remembered. Remembered directories are forgotten whenever the repository's rules, index, or topology change.
 */
export class IgnoredChangeFilter {
    private readonly ignoredDirectories = new Map<string, Set<string>>();

    constructor(
        private readonly tracker: Pick<GitChangeTracker, 'groupChangesByRoot'>,
        private readonly git: GitRunner,
    ) {}

    private async hasRelevantChange(
        root: string,
        absolutePaths: readonly string[],
    ): Promise<boolean> {
        const known = this.ignoredDirectories.get(root) ?? new Set<string>();
        const pending = absolutePaths
            .map((path) => relative(root, path).split(sep).join('/'))
            .filter((path) =>
                ancestorDirectories(path).every((directory) => !known.has(directory)),
            );
        if (pending.length === 0) return false;
        // The root itself, or a batch too large to classify, keeps the previous behavior.
        if (pending.includes('') || pending.length > MAX_CLASSIFIED_PATHS) return true;
        const candidates = new Set(pending.flatMap((path) => [path, ...ancestorDirectories(path)]));
        let ignored: ReadonlySet<string>;
        try {
            const output = await this.git(root, ['check-ignore', '--stdin', '-z'], {
                allowFailure: true,
                input: `${[...candidates].join('\0')}\0`,
            });
            ignored = new Set(output.split('\0').filter(Boolean));
        } catch {
            return true;
        }
        const isRelevant = pending.some((path) => !ignored.has(path));
        const directories = new Set(
            pending.flatMap((path) =>
                ignored.has(path)
                    ? ancestorDirectories(path)
                          .filter((directory) => ignored.has(directory))
                          .slice(0, 1)
                    : [],
            ),
        );
        await Promise.all(
            [...directories].map(async (directory) => {
                if (
                    known.size < MAX_IGNORED_DIRECTORIES &&
                    (await this.holdsNoTrackedFile(root, directory))
                )
                    known.add(directory);
            }),
        );
        if (known.size > 0) this.ignoredDirectories.set(root, known);
        return isRelevant;
    }

    private async holdsNoTrackedFile(root: string, directory: string): Promise<boolean> {
        try {
            const output = await this.git(root, ['ls-files', '-z', '--', directory], {
                maxBufferBytes: TRACKED_PROBE_BYTES,
            });
            return output.length === 0;
        } catch {
            return false;
        }
    }

    /**
     * The repository roots a watcher batch can change the status of. Never rejects: a path that could not be classified
     * keeps its root.
     */
    async relevantRoots(payload: {
        changes: ReadonlyArray<{ path: string }>;
        gitIgnoreRulesChanged?: boolean;
        overflow?: boolean;
        sessionId: string;
    }): Promise<string[]> {
        const groups = this.tracker.groupChangesByRoot(
            payload.sessionId,
            payload.changes.map((change) => change.path),
        );
        // Ignore rules can change outside every root in the batch (a global `core.excludesFile`), and an overflowed batch
        // names no paths at all, so either one invalidates every cached directory.
        if (payload.overflow || payload.gitIgnoreRulesChanged) {
            this.forgetAll();
            return groups.keys().toArray();
        }
        const relevant = await Promise.all(
            [...groups].map(async ([root, paths]) =>
                (await this.hasRelevantChange(root, paths)) ? [root] : [],
            ),
        );
        return relevant.flat();
    }

    forget(roots: Iterable<string>): void {
        for (const root of roots) this.ignoredDirectories.delete(root);
    }

    forgetAll(): void {
        this.ignoredDirectories.clear();
    }
}
