import type { GitRepositorySummary, ProjectStatusRepository } from '@caxri/protocol';
import { parseGitHubRemote } from '@caxri/utils';
import { z } from 'zod';

import type { ExternalStatusRunner } from './external-status';
import { ExternalStatusCliError } from './external-status/command';
import { projectStatusCliError } from './project-status-external';
import { parseExternalJson } from './project-status-parse';

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
 * Query through the existing quota-governed GitHub runner, never network Git or fetch. A tracking ref can be stale
 * after a push in another clone or a deleted remote branch, so it is only a cache invalidation input in the caller.
 */
export async function loadBranchPublication(
    context: BranchPublicationContext,
    runner: ExternalStatusRunner,
    cwd: string,
    now: () => number,
): Promise<Publication> {
    const initial = initialBranchPublication(context);
    if (initial.state !== 'checking') return initial;
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
    const base = { remoteBranch: initial.remoteBranch, checkedAt: now() };
    const remoteHead = response.data.repository.ref?.target.oid;
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

/**
 * Reads local identity immediately; remote publication is checked later by the background refresh.
 */
export async function prepareStatusRepo(
    repo: GitRepositorySummary,
    git: (cwd: string, arguments_: readonly string[]) => Promise<string>,
): Promise<{ context: BranchPublicationContext; repository: ProjectStatusRepository }> {
    const [remote, defaultBranch, head, symbolicHead, trackingHead] = await Promise.all([
        git(repo.rootPath, ['remote', 'get-url', 'origin']),
        git(repo.rootPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
        git(repo.rootPath, ['rev-parse', 'HEAD']),
        git(repo.rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        git(repo.rootPath, [
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
        head: head || undefined,
        owner: github?.owner,
        repo: github?.repo,
        hasOrigin: Boolean(remote),
        detached: Boolean(head) && !symbolicHead,
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
): Promise<{
    publication: Publication;
    branchUrl?: string;
    error?: ProjectStatusRepository['errors'][number];
}> {
    try {
        const publication = await loadBranchPublication(context, runner, cwd, now);
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
            ),
        };
    }
}
