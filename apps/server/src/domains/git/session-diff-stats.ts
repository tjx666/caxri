import type {
    GitRepositorySummary,
    GitSummary,
    SessionDiffStat,
    SessionDiffStats,
} from '@caxri/protocol';
import { mapWithConcurrency } from '@caxri/system';

import { SingleFlight } from '../single-flight';
import { parseGitNumstat } from './numstat';
import { untrackedLineCount } from './working-file-reads';

/**
 * How long one repository's count is trusted before the next read measures it again. The sidebar polls on a longer
 * cadence, so this mainly lets every Session sharing a root, and a poll racing an invalidation, reuse one measurement.
 * A moved `HEAD` (commit, checkout) or a new status generation (a watched root's edit) skips the wait, so a root with a
 * watcher behind it stays as fresh as its Git badge; the TTL is what bounds every other root's staleness.
 */
export const SESSION_DIFF_STAT_TTL_MS = 15_000;

/**
 * Untracked files counted per repository. A generated tree that escaped `.gitignore` would otherwise read thousands of
 * files on every poll; past the cap the count is a floor, which a sidebar glance tolerates.
 */
const MAX_UNTRACKED_FILES_COUNTED = 500;

/**
 * Workbench Roots measured at once. Every Session's first read registers its root's Git projection, so a cold sidebar
 * with many Projects must not fan out one Git sweep per root in parallel.
 */
const MAX_CONCURRENT_ROOTS = 4;

/**
 * Largest untracked file whose lines are counted; a bigger one counts as zero rather than being read into memory.
 */
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;

type RunGit = (
    cwd: string,
    arguments_: string[],
    options?: { allowFailure?: boolean; maxBufferBytes?: number },
) => Promise<string>;

interface DiffStatSession {
    id: string;
    rootPath: string;
}

interface SessionDiffStatOptions {
    git: RunGit;
    countUntrackedLines?: (rootPath: string, path: string) => Promise<number>;
    now?: () => number;
}

interface CachedStat {
    generation: number;
    head: string | undefined;
    measuredAt: number;
    stat: SessionDiffStat;
}

const FULL_OID = /^[0-9a-f]{40}$/;

/**
 * Measures each repository's lines changed since its branch forked off the remote default branch (see
 * `sessionDiffStatSchema`), cached per repository root so Sessions sharing a root share one measurement.
 */
export class SessionDiffStatStore {
    private readonly cache = new Map<string, CachedStat>();
    private readonly flights = new SingleFlight<string, SessionDiffStat>();
    private readonly countUntrackedLines: (rootPath: string, path: string) => Promise<number>;
    private readonly now: () => number;

    constructor(private readonly options: SessionDiffStatOptions) {
        this.countUntrackedLines =
            options.countUntrackedLines ??
            ((rootPath, path) => untrackedLineCount(rootPath, path, MAX_UNTRACKED_FILE_BYTES));
        this.now = options.now ?? Date.now;
    }

    /**
     * Drops counts well past their TTL, so repositories whose Sessions were archived or deleted do not accumulate.
     */
    private evictExpired(): void {
        const cutoff = this.now() - 4 * SESSION_DIFF_STAT_TTL_MS;
        for (const [rootPath, cached] of this.cache)
            if (cached.measuredAt < cutoff) this.cache.delete(rootPath);
    }

    private forRepository(repo: GitRepositorySummary): Promise<SessionDiffStat> {
        const cached = this.cache.get(repo.rootPath);
        if (
            cached &&
            cached.head === repo.head &&
            cached.generation === repo.generation &&
            this.now() - cached.measuredAt < SESSION_DIFF_STAT_TTL_MS
        )
            return Promise.resolve(cached.stat);
        return this.flights.run(repo.rootPath, async () => {
            const stat = await this.measure(repo);
            this.cache.set(repo.rootPath, {
                generation: repo.generation,
                head: repo.head,
                measuredAt: this.now(),
                stat,
            });
            return stat;
        });
    }

    private async measure(repo: GitRepositorySummary): Promise<SessionDiffStat> {
        let additions = 0;
        let deletions = 0;
        if (repo.head) {
            const base = await this.base(repo);
            /**
             * No `allowFailure`: a failed or oversized diff would read as an empty one and show a clean `0/0`. Throwing
             * leaves the Session out of the snapshot, which hides its count instead.
             *
             * `--ignore-submodules=all` because a moved submodule pointer is not a line of anyone's work: Git reports
             * it as `1 1` (one `Subproject commit` line swapped), so every worktree whose submodule checkout differs
             * from the recorded commit showed a phantom `+1 −1`.
             */
            const numstat = await this.options.git(
                repo.rootPath,
                ['diff', '--numstat', '-z', '--no-renames', '--ignore-submodules=all', base, '--'],
                { maxBufferBytes: 4 * 1024 * 1024 },
            );
            for (const file of parseGitNumstat(numstat).values()) {
                additions += file.additions;
                deletions += file.deletions;
            }
        }
        const newFileLines = await this.newFileLineCounts(repo);
        for (const count of newFileLines) additions += count;
        return { additions, deletions };
    }

    /**
     * Lines in the files the diff above cannot see: untracked files, or every file of an unborn repository. Listed
     * fresh on each measurement rather than taken from the status snapshot, because a root nobody has selected has no
     * working-tree watcher to move that snapshot forward.
     */
    private async newFileLineCounts(repo: GitRepositorySummary): Promise<number[]> {
        const listing = await this.options.git(
            repo.rootPath,
            [
                'ls-files',
                '-z',
                '--others',
                '--exclude-standard',
                ...(repo.head ? [] : ['--cached']),
                '--',
            ],
            { maxBufferBytes: 4 * 1024 * 1024 },
        );
        const paths = listing
            .split('\0')
            .filter((path) => path.length > 0)
            .slice(0, MAX_UNTRACKED_FILES_COUNTED);
        return Promise.all(paths.map((path) => this.countUntrackedLines(repo.rootPath, path)));
    }

    /**
     * Where the branch forked off the remote default branch, or `HEAD` when the checkout is the default branch itself,
     * has no remote default, or shares no history with it.
     */
    private async base(repo: GitRepositorySummary): Promise<string> {
        const defaultReference = (
            await this.options.git(
                repo.rootPath,
                ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
                { allowFailure: true },
            )
        ).trim();
        if (!defaultReference) return 'HEAD';
        const defaultBranch = defaultReference.slice(defaultReference.indexOf('/') + 1);
        if (repo.branch === defaultBranch) return 'HEAD';
        const mergeBase = (
            await this.options.git(repo.rootPath, ['merge-base', 'HEAD', defaultReference], {
                allowFailure: true,
            })
        ).trim();
        return FULL_OID.test(mergeBase) ? mergeBase : 'HEAD';
    }

    /**
     * Every listed Session's diff stat, keyed by Session id. Each Workbench Root is summarized and measured once
     * however many Sessions share it; a root whose read fails leaves its Sessions out instead of failing the sidebar's
     * whole read.
     */
    async forSessions(
        sessions: readonly DiffStatSession[],
        summary: (sessionId: string) => Promise<GitSummary>,
    ): Promise<SessionDiffStats> {
        const representatives = new Map<string, string>();
        for (const session of sessions)
            if (!representatives.has(session.rootPath))
                representatives.set(session.rootPath, session.id);
        const measured = await mapWithConcurrency(
            [...representatives],
            MAX_CONCURRENT_ROOTS,
            async ([rootPath, sessionId]) => {
                try {
                    return [rootPath, await this.forSummary(await summary(sessionId))] as const;
                } catch {
                    return [rootPath, undefined] as const;
                }
            },
        );
        const byRoot = new Map(measured);
        this.evictExpired();
        const stats: Record<string, SessionDiffStat> = {};
        for (const session of sessions) {
            const stat = byRoot.get(session.rootPath);
            if (stat) stats[session.id] = stat;
        }
        return { stats };
    }

    /**
     * Sums the Session's repositories, or `undefined` when its root is not a repository or its summary failed.
     */
    async forSummary(summary: GitSummary): Promise<SessionDiffStat | undefined> {
        if (!summary.isRepository || summary.error !== undefined) return undefined;
        const stats = await Promise.all(
            summary.repositories.map((repo) => this.forRepository(repo)),
        );
        return stats.reduce(
            (total, stat) => ({
                additions: total.additions + stat.additions,
                deletions: total.deletions + stat.deletions,
            }),
            { additions: 0, deletions: 0 },
        );
    }
}
