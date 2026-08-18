import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

import type parcelWatcher from '@parcel/watcher';

import type { StructuredLogger } from '../../shared/node/logger';
import type { WatchHandle } from '../watch-hub';
import { WatchHub } from '../watch-hub';

/**
 * Watched repository groups are bounded to keep the Runtime file-descriptor gate intact; the least recently used group
 * is released when a newer repository enters active use.
 */
const MAX_WATCHED_REPOSITORIES = 16;
const POLL_FALLBACK_INTERVAL_MS = 5_000;
/**
 * Metadata files polled per worktree gitDir when the native backend is unavailable.
 */
const POLLED_METADATA_FILES = ['HEAD', 'index', 'packed-refs', 'MERGE_HEAD'];

/**
 * `.git` content the watcher must never react to: object/pack churn, lock files that flap on every optional-lock
 * command, and fsmonitor/watchman cookies. Reacting to these would turn a plain `git status` into a refresh storm.
 */
const IGNORED_SEGMENTS = new Set(['objects', 'lfs', 'sockets', 'hooks', 'logs']);

function isIgnoredMetadataPath(relativePath: string, name: string): boolean {
    const [head] = relativePath.split(sep);
    if (IGNORED_SEGMENTS.has(head)) return true;
    if (name === 'locked' || name.endsWith('.lock')) return true;
    if (name.startsWith('.watchman-cookie')) return true;
    if (name.startsWith('fsmonitor')) return true;
    return false;
}

export type GitMetadataChange =
    | { kind: 'status'; scope: 'worktree'; gitDirName: string | undefined }
    | { kind: 'status'; scope: 'shared' }
    | { kind: 'topology' };

/**
 * Classifies one path change inside a repository's common Git directory. `gitDirName` is the `worktrees/<name>` entry a
 * worktree-local change belongs to; `undefined` targets the primary worktree whose gitDir is the commonDir itself.
 */
export function classifyGitMetadataPath(relativePath: string): GitMetadataChange | undefined {
    const segments = relativePath.split(sep);
    const name = segments.at(-1) ?? '';
    if (!relativePath || isIgnoredMetadataPath(relativePath, name)) return undefined;
    if (segments[0] === 'worktrees') {
        if (segments.length <= 2) return { kind: 'topology' };
        const rest = segments.slice(2).join(sep);
        if (isIgnoredMetadataPath(rest, name)) return undefined;
        if (rest === 'gitdir') return { kind: 'topology' };
        return { kind: 'status', scope: 'worktree', gitDirName: segments[1] };
    }
    if (name === 'config' || relativePath === `info${sep}exclude`) return { kind: 'topology' };
    if (name === 'packed-refs' || segments[0] === 'refs')
        return { kind: 'status', scope: 'shared' };
    if (name === 'HEAD' || name === 'index' || name.endsWith('_HEAD'))
        return { kind: 'status', scope: 'worktree', gitDirName: undefined };
    return undefined;
}

interface WatchedRepo {
    /**
     * `worktrees/<name>` → canonical worktree root resolved from the `gitdir` readback file.
     */
    gitDirRoots: Map<string, string | undefined>;
    polledSignatures?: Map<string, string>;
    primaryRoot: string;
    handle?: WatchHandle;
}

export interface GitMetadataWatcherOptions {
    logger: StructuredLogger;
    /**
     * Advance topology generation for the repository group and schedule invalidation.
     */
    onTopologyChanged: (repoKey: string) => void;
    /**
     * Advance status generations. `roots` lists the affected canonical worktree roots; a shared change (refs,
     * packed-refs) passes every known root of the group.
     */
    onStatusChanged: (repoKey: string, roots: readonly string[]) => void;
    /**
     * Test seam forwarded into the private watch hub when no shared hub is provided.
     */
    subscribe?: typeof parcelWatcher.subscribe;
    /**
     * Shared Runtime watch registry. Production passes the Runtime-wide hub; tests may omit it, in which case the
     * watcher owns a private hub with equivalent behavior.
     */
    watchHub?: WatchHub;
}

/**
 * Narrow-scope watcher over each active repository's shared common Git directory. It observes only Git metadata
 * (`HEAD`, `index`, refs, `worktrees/`, `config`) so external `git switch`, `git commit`, or `git worktree add` refresh
 * Caxri without a working-tree write; the general Project watcher keeps excluding `.git` entirely. Raw `.git` paths
 * never leave this module — the callbacks receive repository keys and worktree roots only.
 */
export class GitMetadataWatcher {
    private closed = false;
    private readonly repositories = new Map<string, WatchedRepo>();
    private readonly watchHub: WatchHub;
    private readonly ownsWatchHub: boolean;

    constructor(private readonly options: GitMetadataWatcherOptions) {
        this.ownsWatchHub = !options.watchHub;
        this.watchHub =
            options.watchHub ??
            new WatchHub({ logger: options.logger, subscribe: options.subscribe });
    }

    private handleEvents(repoKey: string, events: readonly parcelWatcher.Event[]): void {
        const entry = this.repositories.get(repoKey);
        if (!entry) return;
        let isTopologyChanged = false;
        let isSharedStatus = false;
        const worktreeNames = new Set<string | undefined>();
        for (const event of events) {
            const relativePath = relative(repoKey, event.path);
            if (relativePath.startsWith('..')) continue;
            const change = classifyGitMetadataPath(relativePath);
            if (!change) continue;
            if (change.kind === 'topology') isTopologyChanged = true;
            else if (change.scope === 'shared') isSharedStatus = true;
            else worktreeNames.add(change.gitDirName);
        }
        if (isTopologyChanged) this.options.onTopologyChanged(repoKey);
        if (isSharedStatus) {
            this.options.onStatusChanged(repoKey, this.knownRoots(entry));
            return;
        }
        if (worktreeNames.size === 0) return;
        // Fire-and-forget: the watcher callback is synchronous, and resolving worktree roots
        // must never block draining the next batch of native events.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void this.resolveWorktreeRoots(repoKey, entry, worktreeNames).then((roots) => {
            if (roots.length > 0) this.options.onStatusChanged(repoKey, roots);
        });
    }

    private knownRoots(entry: WatchedRepo): string[] {
        const roots = new Set<string>([entry.primaryRoot]);
        for (const root of entry.gitDirRoots.values()) if (root) roots.add(root);
        return [...roots];
    }

    /**
     * Maps `worktrees/<name>` gitDirs to worktree roots through the `gitdir` readback file — a plain filesystem read,
     * deliberately not a Git spawn — and caches the result per group.
     */
    private async resolveWorktreeRoots(
        repoKey: string,
        entry: WatchedRepo,
        names: ReadonlySet<string | undefined>,
    ): Promise<string[]> {
        const roots = await Promise.all(
            [...names].map(async (name) => {
                if (name === undefined) return entry.primaryRoot;
                if (entry.gitDirRoots.has(name)) return entry.gitDirRoots.get(name);
                let root: string | undefined;
                try {
                    const gitdirFile = resolve(repoKey, 'worktrees', name, 'gitdir');
                    const target = (await readFile(gitdirFile, 'utf8')).trim();
                    // `gitdir` stores the path of the worktree's `.git` file; its parent is the root.
                    if (basename(target) === '.git') root = dirname(target);
                } catch {
                    root = undefined;
                }
                entry.gitDirRoots.set(name, root);
                return root;
            }),
        );
        return roots.filter((root): root is string => Boolean(root));
    }

    private async pollOnce(repoKey: string, entry: WatchedRepo): Promise<void> {
        if (this.closed || !entry.polledSignatures) return;
        const targets = [
            ...POLLED_METADATA_FILES.map((name) => resolve(repoKey, name)),
            resolve(repoKey, 'worktrees'),
        ];
        const changedPaths: string[] = [];
        await Promise.all(
            targets.map(async (path) => {
                let signature = 'missing';
                try {
                    const stats = await stat(path);
                    signature = `${stats.mtimeMs}:${stats.size}`;
                } catch {
                    // Missing metadata files participate with the sentinel signature.
                }
                const previous = entry.polledSignatures?.get(path);
                if (previous !== undefined && previous !== signature) changedPaths.push(path);
                entry.polledSignatures?.set(path, signature);
            }),
        );
        if (changedPaths.length === 0) return;
        if (changedPaths.some((path) => basename(path) === 'worktrees'))
            this.options.onTopologyChanged(repoKey);
        this.options.onStatusChanged(repoKey, this.knownRoots(entry));
    }

    /**
     * Ensures the repository group identified by `repositoryKey` (canonical commonDir) is watched. Roots are the
     * currently known worktree roots for shared-scope attribution; re-registering an already watched group only
     * refreshes recency and the known roots.
     */
    async watch(repoKey: string, primaryRoot: string, roots: readonly string[]): Promise<void> {
        if (this.closed) return;
        const existing = this.repositories.get(repoKey);
        if (existing) {
            existing.primaryRoot = primaryRoot;
            this.repositories.delete(repoKey);
            this.repositories.set(repoKey, existing);
            return;
        }
        const entry: WatchedRepo = { gitDirRoots: new Map(), primaryRoot };
        this.repositories.set(repoKey, entry);
        // `repositories` preserves insertion order, so the least recently used groups are the
        // leading keys; evict them concurrently instead of awaiting `unwatch` one at a time.
        const overflow = this.repositories.size - MAX_WATCHED_REPOSITORIES;
        if (overflow > 0) {
            const oldestKeys = this.repositories.keys().toArray().slice(0, overflow);
            await Promise.allSettled(oldestKeys.map((key) => this.unwatch(key)));
        }
        const handle = await this.watchHub.register({
            label: 'git-metadata',
            root: repoKey,
            ignore: ['objects', 'lfs', 'sockets', 'hooks', 'logs'],
            onEvents: (events) => this.handleEvents(repoKey, events),
            /**
             * Native-backend fallback: poll signature files of the commonDir and every registered worktree gitDir so
             * external branch/index changes still surface, degraded but bounded.
             */
            fallback: {
                intervalMs: POLL_FALLBACK_INTERVAL_MS,
                activate: () => {
                    entry.polledSignatures = new Map();
                },
                pollOnce: () => this.pollOnce(repoKey, entry),
            },
        });
        // close()/unwatch() may have run while the native subscription was in flight (both remove
        // the group from `repositories`); release the fresh registration quietly so no leaked
        // watcher or post-shutdown ready-logging races state-directory cleanup (observed as
        // ENOENT/ENOTEMPTY in integration teardown).
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- `closed` can flip while the registration is awaited (concurrent close()); tsgolint keeps the stale pre-await narrowing
        if (this.closed || !this.repositories.has(repoKey)) {
            await handle.dispose();
            return;
        }
        entry.handle = handle;
        if (handle.mode === 'native')
            this.options.logger.write('debug', 'git.metadata_watcher_ready', {
                fields: { repositories: this.repositories.size, worktreeRoots: roots.length },
            });
    }

    async unwatch(repoKey: string): Promise<void> {
        const entry = this.repositories.get(repoKey);
        if (!entry) return;
        this.repositories.delete(repoKey);
        await entry.handle?.dispose();
    }

    /**
     * Releases watchers for repository groups no live Session references anymore.
     */
    async retainOnly(repoKeys: ReadonlySet<string>): Promise<void> {
        const stale = this.repositories
            .keys()
            .filter((key) => !repoKeys.has(key))
            .toArray();
        await Promise.allSettled(stale.map((key) => this.unwatch(key)));
    }

    async close(): Promise<void> {
        this.closed = true;
        const keys = this.repositories.keys().toArray();
        await Promise.allSettled(keys.map((key) => this.unwatch(key)));
        if (this.ownsWatchHub) await this.watchHub.close();
    }
}
