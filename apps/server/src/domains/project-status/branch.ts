import type { GitRepositorySummary, ProjectStatusRepository } from '@caxri/protocol';
import { parseGitHubRemote } from '@caxri/utils';
import { z } from 'zod';

import type { ExternalStatusRunner } from '../external-status';
import { ExternalStatusCliError } from '../external-status';
import { projectStatusCliError } from './external';
import { parseExternalJson } from './parse';

type Publication = NonNullable<ProjectStatusRepository['publication']>;

export interface BranchPublicationContext {
    branch: string;
    head?: string;
    owner?: string;
    repo?: string;
    hasOrigin: boolean;
    detached: boolean;
    defaultBranch?: string;
    trackingHead?: string;
}

/**
 * A null ref proves absence only inside an accessible repository and an error-free response.
 */
const oidSchema = z.string().regex(/^[\da-f]{40}$/);
const referenceSchema = z.object({ target: z.object({ oid: oidSchema }) });
const repoSchema = z.object({ ref: referenceSchema.nullable() });
const responseSchema = z.object({
    data: z.object({ repository: repoSchema }),
    errors: z.array(z.unknown()).max(0).optional(),
});

/**
 * https://docs.github.com/en/graphql/reference/objects#repository
 */
const branchQuery =
    'query BranchPublication($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{oid}}}}';

function initialBranchPublication(context: BranchPublicationContext): Publication {
    if (context.detached) return { state: 'detached' };
    if (!context.head) return { state: 'unborn' };
    if (!context.hasOrigin) return { state: 'no-origin' };
    const remoteBranch = `origin/${context.branch}`;
    return { state: context.owner && context.repo ? 'checking' : 'unsupported', remoteBranch };
}

/**
 * How long a remote branch's commit is reused while the local tracking ref stays put.
 */
const REMOTE_HEAD_TTL_MS = 5 * 60_000;
const REMOTE_HEAD_CACHE_LIMIT = 256;

/**
 * Remembers which commit each GitHub branch points at, so the delivery watch stops re-asking GitHub on every round.
 *
 * Every Project Status refresh used to query the remote branch again, and a Session whose pull request has running
 * checks refreshes every 20 seconds. That query was the largest single consumer of the account-wide GitHub GraphQL
 * budget Caxri shares with the user's shell and Agents: ~900 of the ~1,100 `gh` calls Caxri made per hour. The remote
 * branch moves far less often than that, and when this machine moves it — a push or a fetch — the local tracking ref
 * moves too, which misses the cache immediately. Only a push from another clone or a branch deleted on GitHub waits out
 * the TTL; a forced refresh always asks GitHub again.
 */
interface RemoteHeadEntry {
    expiresAt: number;
    /**
     * When this entry's probe actually reached GitHub, so a cache hit can report the real check time instead of now.
     */
    fetchedAt: number;
    trackingHead?: string;
    value?: Promise<string | undefined>;
}

/**
 * A remote branch lookup's result plus when that probe actually ran, so a cache hit can report the moment GitHub was
 * really asked instead of the moment the hit happened.
 */
export interface RemoteHeadResult {
    fetchedAt: number;
    head: string | undefined;
}

export class RemoteHeadCache {
    private readonly entries = new Map<string, RemoteHeadEntry>();

    constructor(private readonly now: () => number = Date.now) {}

    private async lookup(
        key: string,
        entry: RemoteHeadEntry,
        query: () => Promise<string | undefined>,
    ): Promise<string | undefined> {
        try {
            return await query();
        } catch (error) {
            // A failed lookup must not be served from the cache; the next round asks again.
            if (this.entries.get(key) === entry) this.entries.delete(key);
            throw error;
        }
    }

    async read(
        context: BranchPublicationContext,
        query: () => Promise<string | undefined>,
        isForced = false,
    ): Promise<RemoteHeadResult> {
        const key = JSON.stringify([context.owner, context.repo, context.branch]);
        const cached = this.entries.get(key);
        if (
            !isForced &&
            cached?.value &&
            cached.expiresAt > this.now() &&
            cached.trackingHead === context.trackingHead
        ) {
            const { fetchedAt } = cached;
            return { fetchedAt, head: await cached.value };
        }
        const fetchedAt = this.now();
        const entry: RemoteHeadEntry = {
            expiresAt: fetchedAt + REMOTE_HEAD_TTL_MS,
            fetchedAt,
            trackingHead: context.trackingHead,
        };
        this.entries.delete(key);
        this.entries.set(key, entry);
        while (this.entries.size > REMOTE_HEAD_CACHE_LIMIT) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        entry.value = this.lookup(key, entry, query);
        return { fetchedAt, head: await entry.value };
    }
}

async function queryRemoteHead(
    context: BranchPublicationContext,
    runner: ExternalStatusRunner,
    cwd: string,
): Promise<string | undefined> {
    const response = parseExternalJson(
        await runner(
            'gh',
            [
                'api',
                'graphql',
                '--hostname',
                'github.com',
                '--raw-field',
                `query=${branchQuery}`,
                '--raw-field',
                `owner=${context.owner}`,
                '--raw-field',
                `name=${context.repo}`,
                '--raw-field',
                `ref=refs/heads/${context.branch}`,
            ],
            cwd,
        ),
        responseSchema,
        'branch publication',
    );
    return response.data.repository.ref?.target.oid;
}

/**
 * Query through the existing quota-governed GitHub runner, never network Git or fetch. A tracking ref can be stale
 * after a push in another clone or a deleted remote branch, so it is only a cache invalidation input in the caller.
 */
export async function loadBranchPublication(
    context: BranchPublicationContext,
    runner: ExternalStatusRunner,
    cwd: string,
    now: () => number,
    remoteHeads?: { cache: RemoteHeadCache; isForced: boolean },
): Promise<Publication> {
    const initial = initialBranchPublication(context);
    if (initial.state !== 'checking') return initial;
    const query = () => queryRemoteHead(context, runner, cwd);
    // A cache hit reports the earlier probe's own time, not this call's `now()`, so `checkedAt` states when GitHub was
    // actually asked rather than when the TTL happened to be reused.
    const { fetchedAt: checkedAt, head: remoteHead } = remoteHeads
        ? await remoteHeads.cache.read(context, query, remoteHeads.isForced)
        : { fetchedAt: now(), head: await query() };
    const base = { remoteBranch: initial.remoteBranch, checkedAt };
    if (!remoteHead) return { ...base, state: 'unpublished' };
    if (remoteHead === context.head) return { ...base, state: 'synced' };
    try {
        // Comparing captured OIDs avoids a concurrent checkout changing the meaning of HEAD midway through refresh.
        if (!context.head || !/^[\da-f]{40}$/.test(context.head))
            return { ...base, state: 'published' };
        const shallow = await runner('git', ['rev-parse', '--is-shallow-repository'], cwd);
        if (shallow.trim() !== 'false') return { ...base, state: 'published' };
        // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- Git's commit peel syntax is literal.
        await runner('git', ['cat-file', '-e', `${remoteHead}^{commit}`], cwd);
        const counts = await runner(
            'git',
            ['rev-list', '--left-right', '--count', `${context.head}...${remoteHead}`, '--'],
            cwd,
        );
        const match = /^(\d+)\s+(\d+)$/.exec(counts.trim());
        if (match) {
            const ahead = Number(match[1]);
            const behind = Number(match[2]);
            if (Number.isSafeInteger(ahead) && Number.isSafeInteger(behind) && (ahead || behind)) {
                return {
                    ...base,
                    state: ahead ? (behind ? 'diverged' : 'ahead') : 'behind',
                    ahead,
                    behind,
                };
            }
        }
    } catch {
        // Missing local history does not negate the independently confirmed remote branch.
    }
    return { ...base, state: 'published' };
}

type OptionalGit = (cwd: string, arguments_: readonly string[]) => Promise<string>;

/**
 * `git status --porcelain=v2 --branch` reports a detached HEAD as this branch name; `git.summary` passes it through.
 */
const DETACHED_BRANCH = '(detached)';
/**
 * How long `origin`'s URL and default branch are reused for one repository root.
 */
const REPO_REMOTE_TTL_MS = 5 * 60_000;

interface RepoRemote {
    defaultBranch: string;
    remote: string;
}

/**
 * `origin`'s URL and default branch change only when the user edits remotes, yet every overview and every
 * delivery-watch round spawned two `git` processes per repository to read them again. Production (#1184): with ~35
 * watched Sessions, `remote.get-url` and `default-branch.get` together ran ~22,000 times in one log window. A forced
 * refresh reads them again, so a newly added remote shows up as soon as the user asks for it.
 */
export class RepoRemoteCache {
    private readonly entries = new Map<string, { expiresAt: number; value: Promise<RepoRemote> }>();

    constructor(private readonly now: () => number = Date.now) {}

    read(rootPath: string, git: OptionalGit, isForced = false): Promise<RepoRemote> {
        const now = this.now();
        const cached = this.entries.get(rootPath);
        if (!isForced && cached && cached.expiresAt > now) return cached.value;
        const value = (async () => {
            const [remote, defaultBranch] = await Promise.all([
                git(rootPath, ['remote', 'get-url', 'origin']),
                git(rootPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
            ]);
            return { remote, defaultBranch };
        })();
        this.entries.set(rootPath, { expiresAt: now + REPO_REMOTE_TTL_MS, value });
        return value;
    }
}

/**
 * Reads local identity immediately; remote publication is checked later by the background refresh.
 *
 * HEAD and the branch come from the same `git.summary` snapshot the caller already holds, instead of two more `git`
 * processes per repository; only the tracking ref, which moves on every push or fetch, is read each time.
 */
export async function prepareStatusRepo(
    repo: GitRepositorySummary,
    git: OptionalGit,
    remotes: RepoRemoteCache = new RepoRemoteCache(),
    isForced = false,
): Promise<{ context: BranchPublicationContext; repository: ProjectStatusRepository }> {
    const isDetached = repo.branch === DETACHED_BRANCH;
    const [{ remote, defaultBranch }, trackingHead] = await Promise.all([
        remotes.read(repo.rootPath, git, isForced),
        isDetached
            ? Promise.resolve('')
            : git(repo.rootPath, [
                  'rev-parse',
                  '--verify',
                  '--quiet',
                  `refs/remotes/origin/${repo.branch}`,
              ]),
    ]);
    const github = parseGitHubRemote(remote);
    const context: BranchPublicationContext = {
        branch: repo.branch,
        defaultBranch: defaultBranch.replace(/^origin\//, '') || undefined,
        head: repo.head,
        owner: github?.owner,
        repo: github?.repo,
        hasOrigin: Boolean(remote),
        detached: Boolean(repo.head) && isDetached,
        trackingHead: trackingHead || undefined,
    };
    const githubUrl = github ? `https://github.com/${github.owner}/${github.repo}` : undefined;
    return {
        context,
        repository: {
            id: repo.id,
            kind: repo.kind,
            name: github?.repo ?? repo.name,
            rootPath: repo.rootPath,
            branch: repo.branch,
            defaultBranch: context.defaultBranch,
            githubUrl,
            publication: initialBranchPublication(context),
            acceptances: [],
            linearIssues: [],
            errors: [],
        },
    };
}

/**
 * Keeps publication failure independent of PR success while using the same GitHub error presentation.
 */
export async function readBranchPublication(
    context: BranchPublicationContext,
    runner: ExternalStatusRunner,
    cwd: string,
    now: () => number,
    githubUrl?: string,
    remoteHeads?: { cache: RemoteHeadCache; isForced: boolean },
): Promise<{
    publication: Publication;
    branchUrl?: string;
    error?: ProjectStatusRepository['errors'][number];
}> {
    try {
        const publication = await loadBranchPublication(context, runner, cwd, now, remoteHeads);
        const isExists = ['published', 'synced', 'ahead', 'behind', 'diverged'].includes(
            publication.state,
        );
        return {
            publication,
            branchUrl:
                isExists && githubUrl
                    ? `${githubUrl}/tree/${encodeURIComponent(context.branch)}`
                    : undefined,
        };
    } catch (error) {
        return {
            publication: {
                state: 'unknown',
                remoteBranch: `origin/${context.branch}`,
                checkedAt: now(),
            },
            error: projectStatusCliError(
                'gh',
                error instanceof ExternalStatusCliError ? error.kind : 'other',
                {
                    retryAt: error instanceof ExternalStatusCliError ? error.retryAt : undefined,
                },
            ),
        };
    }
}
