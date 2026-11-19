import type {
    ProjectStatusDeployment,
    ProjectStatusRepository,
    ProjectStatusState,
} from '@caxri/protocol';
import { z } from 'zod';

import { parseExternalJson } from '../../external-status';

/**
 * Runs one `gh api` REST call and returns its stdout. REST draws on a budget separate from the GraphQL one the rest of
 * the Status panel spends, so this fallback never competes with pull request lookups.
 */
export type GitHubApiRunner = (arguments_: readonly string[]) => Promise<string>;

/**
 * The account Vercel's GitHub integration records deployments as. Other integrations (GitHub Pages, Netlify, a
 * workflow's own `environment:`) write to the same Deployments API, and only Vercel's belong in this tree.
 */
const VERCEL_BOT_LOGIN = 'vercel[bot]';

/**
 * Vercel names the environment `Production` or `Preview`, suffixed with ` – <project>` when one repository feeds
 * several Vercel projects.
 */
const ENVIRONMENT_PATTERN = /^(?<environment>production|preview)\b/i;

const COMMIT_SHA = /^[\da-f]{7,64}$/i;

const deploymentCreatorSchema = z.object({ login: z.string() });

const deploymentListSchema = z.array(
    z.object({
        id: z.number().int().positive(),
        sha: z.string(),
        environment: z.string(),
        created_at: z.string(),
        creator: deploymentCreatorSchema.nullish(),
    }),
);

const deploymentStatusListSchema = z.array(
    z.object({
        state: z.string(),
        environment_url: z.string().nullish(),
        target_url: z.string().nullish(),
        log_url: z.string().nullish(),
    }),
);

type GitHubDeployment = z.infer<typeof deploymentListSchema>[number];
type GitHubDeploymentStatus = z.infer<typeof deploymentStatusListSchema>[number];

/**
 * GitHub's deployment status states.
 *
 * @see https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status
 */
function deploymentState(state: string): ProjectStatusState {
    switch (state) {
        // `inactive` is a successful build a newer one in the same environment superseded. It still serves its own URL,
        // which is what Vercel's `READY` reports for the same deployment, so the two sources agree on the row.
        case 'success':
        case 'inactive': {
            return 'success';
        }
        case 'failure':
        case 'error': {
            return 'failure';
        }
        case 'queued': {
            return 'queued';
        }
        case 'pending':
        case 'in_progress': {
            return 'pending';
        }
        default: {
            return 'unknown';
        }
    }
}

function httpsUrl(value: string | null | undefined): URL | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url : undefined;
    } catch {
        return undefined;
    }
}

function environmentOf(
    deployment: GitHubDeployment,
): ProjectStatusDeployment['environment'] | undefined {
    const environment = ENVIRONMENT_PATTERN.exec(deployment.environment)?.groups?.environment;
    return environment
        ? (environment.toLowerCase() as ProjectStatusDeployment['environment'])
        : undefined;
}

function isVercelDeployment(deployment: GitHubDeployment): boolean {
    return (
        deployment.creator?.login === VERCEL_BOT_LOGIN && environmentOf(deployment) !== undefined
    );
}

async function listDeployments(
    run: GitHubApiRunner,
    owner: string,
    repo: string,
    query: string,
): Promise<GitHubDeployment[]> {
    const output = await run([
        'api',
        '--hostname',
        'github.com',
        `repos/${owner}/${repo}/deployments?${query}`,
    ]);
    return parseExternalJson(output, deploymentListSchema, 'GitHub deployment list').filter(
        isVercelDeployment,
    );
}

async function latestStatus(
    run: GitHubApiRunner,
    owner: string,
    repo: string,
    deployment: GitHubDeployment,
): Promise<GitHubDeploymentStatus | undefined> {
    const output = await run([
        'api',
        '--hostname',
        'github.com',
        `repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=1`,
    ]);
    return parseExternalJson(
        output,
        deploymentStatusListSchema,
        'GitHub deployment status list',
    )[0];
}

function mapDeployment(
    owner: string,
    repo: string,
    deployment: GitHubDeployment,
    status: GitHubDeploymentStatus | undefined,
): ProjectStatusDeployment | undefined {
    const environment = environmentOf(deployment);
    if (!environment) return undefined;
    /**
     * Vercel posts the deployment's own URL as `environment_url` once the build is ready. A build still running or one
     * that failed carries only `target_url`, which then points at Vercel's build page instead.
     */
    const site = httpsUrl(status?.environment_url) ?? httpsUrl(status?.target_url);
    if (!site) return undefined;
    const inspector = httpsUrl(status?.target_url) ?? httpsUrl(status?.log_url) ?? site;
    const createdAt = Date.parse(deployment.created_at);
    return {
        environment,
        hostname: site.host,
        state: status ? deploymentState(status.state) : 'unknown',
        url: site.href,
        inspectorUrl: inspector.href,
        ...(Number.isFinite(createdAt) && { createdAt }),
        ...(COMMIT_SHA.test(deployment.sha) && {
            commit: {
                sha: deployment.sha,
                url: `https://github.com/${owner}/${repo}/commit/${deployment.sha}`,
            },
        }),
    };
}

async function newestDeployment(
    run: GitHubApiRunner,
    owner: string,
    repo: string,
    sha: string,
    environment: ProjectStatusDeployment['environment'],
): Promise<ProjectStatusDeployment | undefined> {
    // GitHub lists newest first, so the first match is the latest build of this commit.
    const deployment = (
        await listDeployments(run, owner, repo, `sha=${encodeURIComponent(sha)}&per_page=20`)
    ).find((candidate) => environmentOf(candidate) === environment);
    if (!deployment) return undefined;
    return mapDeployment(owner, repo, deployment, await latestStatus(run, owner, repo, deployment));
}

export interface GitHubDeploymentTarget {
    owner: string;
    repo: string;
    /**
     * The checked-out commit, whose preview build the panel reports.
     */
    head?: string;
    /**
     * The merged pull request's merge commit, whose production build the panel reports.
     */
    mergeCommit?: string;
}

/**
 * The Status panel's deployment tree rebuilt from the deployments Vercel's GitHub integration records on the
 * repository, for a user whose `vc` cannot read the Vercel project but whose `gh` can read the repository: a
 * contributor to an open-source project deployed from a team they are not a member of.
 *
 * Vercel records each deployment against a commit SHA, never a branch name, so the branch history `vc` lists has no
 * equivalent here. The tree shows the head commit's preview as the branch's only build instead. Returns `undefined`
 * when GitHub has no Vercel deployment for either commit, so the caller keeps reporting the original `vc` failure.
 */
export async function loadGitHubDeployments(
    run: GitHubApiRunner,
    target: GitHubDeploymentTarget,
): Promise<ProjectStatusRepository['deployments']> {
    const { owner, repo, head, mergeCommit } = target;
    const [preview, production] = await Promise.all([
        head ? newestDeployment(run, owner, repo, head, 'preview') : undefined,
        mergeCommit ? newestDeployment(run, owner, repo, mergeCommit, 'production') : undefined,
    ]);
    if (!preview && !production) return undefined;
    return {
        source: 'github',
        url: `https://github.com/${owner}/${repo}/deployments`,
        branchDeployments: preview ? [preview] : [],
        ...(production && { production }),
        ...(preview && { preview }),
    };
}

/**
 * Whether Vercel recorded any of the repository's last 30 deployments, which separates a repository that is simply not
 * on Vercel from one whose current commit has not been built yet.
 */
export async function hasRecentVercelDeployment(
    run: GitHubApiRunner,
    owner: string,
    repo: string,
): Promise<boolean> {
    return (await listDeployments(run, owner, repo, 'per_page=30')).length > 0;
}

/**
 * The newest production deployment Vercel recorded on the repository, which is the one production is serving. Only an
 * environment named exactly `Production` is queried: the API filters by exact name, and a repository feeding several
 * Vercel projects (`Production – web`) gets no Session badge from this fallback rather than one guessed from the wrong
 * project.
 */
export async function loadGitHubProduction(
    run: GitHubApiRunner,
    owner: string,
    repo: string,
): Promise<{ commitSha: string; state: ProjectStatusState } | undefined> {
    const deployment = (
        await listDeployments(run, owner, repo, 'environment=Production&per_page=5')
    ).at(0);
    if (!deployment || !COMMIT_SHA.test(deployment.sha)) return undefined;
    const status = await latestStatus(run, owner, repo, deployment);
    return { commitSha: deployment.sha, state: status ? deploymentState(status.state) : 'unknown' };
}
