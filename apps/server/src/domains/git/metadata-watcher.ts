import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, readBoundedRegularFileText } from '@caxri/system';
import type parcelWatcher from '@parcel/watcher';

import { isOutsideRoot } from '../path-security';
import type { WatchHandle } from '../watch';
import { WatchHub } from '../watch';

/**
 * Watched repository groups are bounded to keep the Server file-descriptor gate intact; the least recently used group
 * is released when a newer repository enters active use.
 */
const MAX_WATCHED_REPOSITORIES = 16;
const POLL_FALLBACK_INTERVAL_MS = 5_000;
/**
 * A `gitdir` readback file is one worktree path plus a newline. Bound the read so a replaced regular file cannot pull
 * an arbitrary blob into the watcher; capacity and other read failures still resolve as an unreadable root.
 */
const MAX_GITDIR_FILE_BYTES = 4_096;
/**
 * A `HEAD` file is `ref: refs/heads/<branch>` or a 40/64-character sha, both far inside this bound. Bound the read for
 * the same reason as {@link MAX_GITDIR_FILE_BYTES}.
 */
const MAX_HEAD_FILE_BYTES = 4_096;
/**
 * Metadata files polled per worktree gitDir when the native backend is unavailable.
 */
const POLLED_METADATA_FILES = ['HEAD', 'index', 'packed-refs', 'MERGE_HEAD'];

/**
 * `.git` content the watcher must never react to: object/pack churn, lock files that flap on every optional-lock
 * command, and fsmonitor/watchman cookies. Reacting to these would turn a plain `git status` into a refresh storm.
 */
const IGNORED_SEGMENTS = new Set(['objects', 'lfs', 'sockets', 'hooks', 'logs', 'modules']);

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
    /**
     * `refName` is the full `refs/...` name of the single ref that moved; its absence means the change could have moved
     * any ref (`packed-refs`) and every worktree in the group has to re-read.
     */
    | { kind: 'status'; scope: 'shared'; refName?: string }
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
    if (name === 'packed-refs') return { kind: 'status', scope: 'shared' };
    // Ref names are always slash-separated on the wire, whatever the platform separator in the watched path is.
    if (segments[0] === 'refs')
        return { kind: 'status', scope: 'shared', refName: segments.join('/') };
    if (name === 'HEAD' || name === 'index' || name.endsWith('_HEAD'))
        return { kind: 'status', scope: 'worktree', gitDirName: undefined };
    return undefined;
}

/**
 * The branch a moved ref can change the status of, or `undefined` when that cannot be narrowed.
 *
 * A `refs/heads/<branch>` write only matters to a worktree that has `<branch>` checked out. A
 * `refs/remotes/<remote>/<branch>` write (a `git fetch`) matters to a worktree whose upstream it is, and the branch
 * name is the only part of that relationship visible from the file path, so same-named local branches are the match.
 * Anything else (tags, notes, stash, a bare `refs/foo`) keeps the whole group.
 */
function affectedBranch(referenceName: string): string | undefined {
    const segments = referenceName.split('/');
    if (segments[0] !== 'refs' || segments.length < 3) return undefined;
    if (segments[1] === 'heads') return segments.slice(2).join('/');
    if (segments[1] === 'remotes' && segments.length >= 4) return segments.slice(3).join('/');
    return undefined;
}

/**
 * What a gitDir's `HEAD` points at. `detached` holds a raw sha and so can never be the target of a branch ref write;
 * `unreadable` is the only state that must widen a refresh back to the whole group, because an unknown HEAD cannot rule
 * the worktree out.
 */
type HeadState = { kind: 'branch'; branch: string } | { kind: 'detached' } | { kind: 'unreadable' };

function parseHeadBranch(head: string): HeadState {
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim());
    return match ? { kind: 'branch', branch: match[1] } : { kind: 'detached' };
}

interface WatchedRepo {
    roots: readonly string[];
    /**
     * `worktrees/<name>` → canonical worktree root resolved from the `gitdir` readback file.
     */
    gitDirRoots: Map<string, string | undefined>;
    /**
     * GitDir name (`undefined` = the primary worktree) → what its `HEAD` points at. Populated lazily and dropped
     * whenever that worktree's metadata or the group's topology changes.
     */
    headStates: Map<string | undefined, HeadState>;
    /**
     * `worktrees/` listing, cached alongside the head states above and invalidated by the same topology events.
     */
    gitDirNames?: readonly string[];
    polledSignatures?: Map<string, string>;
    primaryRoot: string;
    handle?: WatchHandle;
}

export interface GitMetadataWatcherOptions {
    logger: StructuredLogger;
    /**
     * Live projections must not lose their watcher when a Project contains many child repositories.
     */
    referencedRepositoryKeys?: () => ReadonlySet<string>;
    /**
     * Advance topology generation for the repository group and schedule invalidation.
     */
    onTopologyChanged: (repoKey: string) => void;
    /**
     * Advance status generations. `roots` lists the affected canonical worktree roots. A ref write passes only the
     * worktrees that have that branch checked out; a change that cannot be attributed to one ref (`packed-refs`, a tag,
     * an unreadable `HEAD`) still passes every known root of the group.
     */
    onStatusChanged: (repoKey: string, roots: readonly string[]) => void;
    /**
     * Test seam forwarded into the private watch hub when no shared hub is provided.
     */
    subscribe?: typeof parcelWatcher.subscribe;
    /**
     * Shared Server watch registry. Production passes the Server-wide hub; tests may omit it, in which case the watcher
     * owns a private hub with equivalent behavior.
     */
    watchHub?: WatchHub;
}

/**
 * Narrow-scope watcher over each active repository's shared common Git directory. It observes only Git metadata
 * (`HEAD`, `index`, refs, `worktrees/`, `config`) so external `git switch`, `git commit`, or `git worktree add` refresh
 * Caxri without a working-tree write; the general Project watcher keeps excluding `.git` entirely. Raw `.git` paths
 * never leave this module: the callbacks receive repository keys and worktree roots only.
 */
export class GitMetadataWatcher {
    private closed = false;
    private readonly pendingWatches = new Set<Promise<void>>();
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
        let isWholeGroupStatus = false;
        const worktreeNames = new Set<string | undefined>();
        const referenceNames = new Set<string>();
        for (const event of events) {
            const relativePath = relative(repoKey, event.path);
            if (isOutsideRoot(relativePath)) continue;
            const change = classifyGitMetadataPath(relativePath);
            if (!change) continue;
            if (change.kind === 'topology') isTopologyChanged = true;
            else if (change.scope === 'shared') {
                if (change.refName === undefined) isWholeGroupStatus = true;
                else referenceNames.add(change.refName);
            } else worktreeNames.add(change.gitDirName);
        }
        if (isTopologyChanged) {
            entry.gitDirNames = undefined;
            entry.headStates.clear();
            this.options.onTopologyChanged(repoKey);
        }
        // A worktree's own metadata moving is the one event that can change which branch its HEAD names.
        for (const name of worktreeNames) entry.headStates.delete(name);
        if (isWholeGroupStatus) {
            this.options.onStatusChanged(repoKey, this.knownRoots(entry));
            return;
        }
        if (worktreeNames.size === 0 && referenceNames.size === 0) return;
        // Fire-and-forget: the watcher callback is synchronous, and resolving worktree roots
        // must never block draining the next batch of native events.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void this.resolveAffectedRoots(repoKey, entry, worktreeNames, referenceNames).then(
            (roots) => {
                if (roots.length > 0) this.options.onStatusChanged(repoKey, roots);
            },
        );
    }

    /**
     * Narrows a batch to the worktree roots it can actually change.
     *
     * Every `refs/**` write used to refresh every worktree in the group, so one agent committing in one of dozens of
     * worktrees sharing a commonDir re-ran `git status` in all of them. A ref write only reaches a worktree that has
     * that branch checked out (or tracks it, for a remote ref), which is a `HEAD` read per worktree: no Git spawn.
     * Anything that cannot be attributed still falls back to the whole group, so the cost of being wrong is the old
     * behavior rather than a missed refresh.
     */
    private async resolveAffectedRoots(
        repoKey: string,
        entry: WatchedRepo,
        names: ReadonlySet<string | undefined>,
        referenceNames: ReadonlySet<string>,
    ): Promise<string[]> {
        const roots = new Set(await this.resolveWorktreeRoots(repoKey, entry, names));
        if (referenceNames.size === 0) return [...roots];
        const branches = new Set<string>();
        for (const referenceName of referenceNames) {
            const branch = affectedBranch(referenceName);
            if (branch === undefined) return this.allRoots(repoKey, entry);
            branches.add(branch);
        }
        const worktreeNames = await this.gitDirNames(repoKey, entry);
        const heads = await Promise.all(
            worktreeNames.map(
                async (name) => [name, await this.headState(repoKey, entry, name)] as const,
            ),
        );
        if (heads.some(([, head]) => head.kind === 'unreadable'))
            return this.allRoots(repoKey, entry);
        const matched = new Set(
            heads.flatMap(([name, head]) =>
                head.kind === 'branch' && branches.has(head.branch) ? [name] : [],
            ),
        );
        const matchedRoots = await this.resolveWorktreeRoots(repoKey, entry, matched);
        for (const root of matchedRoots) roots.add(root);
        return [...roots];
    }

    /**
     * The fallback for a ref change that could not be narrowed. Unlike {@link knownRoots} (which the synchronous
     * whole-group path uses and which only sees roots already registered or resolved), this enumerates every linked
     * worktree, so widening really does reach all of them.
     */
    private async allRoots(repoKey: string, entry: WatchedRepo): Promise<string[]> {
        const names = new Set(await this.gitDirNames(repoKey, entry));
        return [
            ...new Set([
                ...this.knownRoots(entry),
                ...(await this.resolveWorktreeRoots(repoKey, entry, names)),
            ]),
        ];
    }

    /**
     * Every gitDir in the group: `undefined` for the primary worktree, whose gitDir is the commonDir itself, plus one
     * entry per `worktrees/<name>`. A plain directory listing, cached until the group's topology changes.
     */
    private async gitDirNames(
        repoKey: string,
        entry: WatchedRepo,
    ): Promise<ReadonlyArray<string | undefined>> {
        if (!entry.gitDirNames) {
            try {
                entry.gitDirNames = await readdir(resolve(repoKey, 'worktrees'));
            } catch {
                // A repository with no linked worktrees has no `worktrees` directory at all.
                entry.gitDirNames = [];
            }
        }
        return [undefined, ...entry.gitDirNames];
    }

    private async headState(
        repoKey: string,
        entry: WatchedRepo,
        name: string | undefined,
    ): Promise<HeadState> {
        const cached = entry.headStates.get(name);
        if (cached) return cached;
        const headFile =
            name === undefined
                ? resolve(repoKey, 'HEAD')
                : resolve(repoKey, 'worktrees', name, 'HEAD');
        let state: HeadState;
        try {
            state = parseHeadBranch(
                await readBoundedRegularFileText(headFile, MAX_HEAD_FILE_BYTES),
            );
        } catch {
            // Deliberately uncached: a read that failed once should be retried, not turned into a permanent fan-out.
            return { kind: 'unreadable' };
        }
        entry.headStates.set(name, state);
        return state;
    }

    private knownRoots(entry: WatchedRepo): string[] {
        const roots = new Set<string>([entry.primaryRoot, ...entry.roots]);
        for (const root of entry.gitDirRoots.values()) if (root) roots.add(root);
        return [...roots];
    }

    /**
     * Maps `worktrees/<name>` gitDirs to worktree roots through the `gitdir` readback file (a plain filesystem read,
     * deliberately not a Git spawn) and caches the result per group.
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
                    const target = (
                        await readBoundedRegularFileText(gitdirFile, MAX_GITDIR_FILE_BYTES)
                    ).trim();
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
    private async watchRepository(
        repoKey: string,
        primaryRoot: string,
        roots: readonly string[],
    ): Promise<void> {
        if (this.closed) return;
        const existing = this.repositories.get(repoKey);
        if (existing) {
            existing.primaryRoot = primaryRoot;
            existing.roots = [...roots];
            this.repositories.delete(repoKey);
            this.repositories.set(repoKey, existing);
            return;
        }
        const entry: WatchedRepo = {
            gitDirRoots: new Map(),
            headStates: new Map(),
            primaryRoot,
            roots: [...roots],
        };
        this.repositories.set(repoKey, entry);
        // `repositories` preserves insertion order, so the least recently used groups are the
        // leading keys; evict them concurrently instead of awaiting `unwatch` one at a time.
        const overflow = this.repositories.size - MAX_WATCHED_REPOSITORIES;
        if (overflow > 0) {
            const referenced = this.options.referencedRepositoryKeys?.();
            const oldestKeys = this.repositories
                .keys()
                .filter((key) => !referenced?.has(key))
                .take(overflow)
                .toArray();
            await Promise.allSettled(oldestKeys.map((key) => this.unwatch(key)));
        }
        const handle = await this.watchHub.register({
            label: 'git-metadata',
            root: repoKey,
            ignore: ['objects', 'lfs', 'sockets', 'hooks', 'logs', 'modules'],
            onEvents: (events) => {
                if (this.repositories.get(repoKey) === entry) this.handleEvents(repoKey, events);
            },
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
        if (this.closed || this.repositories.get(repoKey) !== entry) {
            await handle.dispose();
            return;
        }
        entry.handle = handle;
        if (handle.mode === 'native')
            this.options.logger.write('debug', logEventCatalog.git.metadataWatcherReady, {
                fields: { repositories: this.repositories.size, worktreeRoots: roots.length },
            });
    }

    async watch(repoKey: string, primaryRoot: string, roots: readonly string[]): Promise<void> {
        const pending = this.watchRepository(repoKey, primaryRoot, roots);
        this.pendingWatches.add(pending);
        try {
            await pending;
        } finally {
            this.pendingWatches.delete(pending);
        }
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
        await Promise.allSettled(this.pendingWatches);
        if (this.ownsWatchHub) await this.watchHub.close();
    }
}
