import { homedir } from 'node:os';

import type {
    ProjectStatusDeployment,
    ProjectStatusDeploymentCommit,
    ProjectStatusError,
    ProjectStatusRepository,
    ProjectStatusState,
} from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';

import { ExternalStatusCliError, parseExternalJson } from '../external-status';
import type { BranchPublicationContext } from './branch';
import type { VercelLink } from './external';
import {
    hasLocalVercelLink,
    projectStatusCliError,
    projectStatusNoDeploymentsError,
    vcListArguments,
    vercelInspectorUrl,
} from './external';
import { parseVercelList, vercelTeamListSchema } from './parse';

/**
 * Caps the process-lifetime project-link cache so long-running sessions can't grow it unbounded.
 */
const VERCEL_LINK_CACHE_LIMIT = 256;

/**
 * How many branch deployments one repository reports. Vercel keeps every build a branch ever produced; the panel lists
 * the recent ones, and the rest is history nobody scrolls a status tree for.
 */
const MAX_BRANCH_DEPLOYMENTS = 10;

/**
 * A repository Vercel has never heard of answers the same way every time, and proving it costs a team list plus one
 * deployment query per team. Production (0.0.138) spawned 1,000 to 1,200 `vc` processes an hour, about a second each,
 * because only a found link was remembered and the Status panel re-proved every unlinked repository each minute.
 */
export const UNLINKED_TTL_MS = 30 * 60_000;
/**
 * Teams change when the user joins or leaves one, which a half-hour delay does not hide: an unlinked repository is
 * re-checked on the same schedule.
 */
const TEAMS_TTL_MS = 30 * 60_000;

export interface VercelLinkCacheOptions {
    now?: () => number;
    teamsTtlMs?: number;
    unlinkedTtlMs?: number;
}

/**
 * `owner/repo` → the Vercel project it is linked to, or the remembered absence of one. Owned by the caller because the
 * answer holds across refreshes: a found link for the life of the process, an absence and the team list for
 * {@link UNLINKED_TTL_MS}. Concurrent discoveries of one repository share a single run, so a sweep over many Sessions on
 * the same repository spawns one team list, not one per Session.
 */
export class VercelLinkCache {
    private readonly links = new Map<string, VercelLink>();
    private readonly unlinked = new Map<string, number>();
    private readonly discovering = new Map<string, Promise<VercelLink | undefined>>();
    private teamList?: { fetchedAt: number; value: Promise<string[]> };

    constructor(private readonly options: VercelLinkCacheOptions = {}) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async forgetTeamsOnFailure(entry: {
        fetchedAt: number;
        value: Promise<string[]>;
    }): Promise<string[]> {
        try {
            return await entry.value;
        } catch (error) {
            if (this.teamList === entry) this.teamList = undefined;
            throw error;
        }
    }

    /**
     * Seeds a known link, as a caller that already resolved one (or a test) would.
     */
    set(key: string, link: VercelLink): void {
        this.unlinked.delete(key);
        rememberBounded(this.links, key, link, VERCEL_LINK_CACHE_LIMIT);
    }

    /**
     * The account's team slugs, shared by every discovery inside the TTL. A failed list is not remembered, so the next
     * discovery asks again.
     */
    teams(load: () => Promise<string[]>): Promise<string[]> {
        const cached = this.teamList;
        if (cached && this.now() - cached.fetchedAt < (this.options.teamsTtlMs ?? TEAMS_TTL_MS))
            return cached.value;
        const value = load();
        const entry = { fetchedAt: this.now(), value };
        this.teamList = entry;
        return this.forgetTeamsOnFailure(entry);
    }

    clear(): void {
        this.links.clear();
        this.unlinked.clear();
        this.discovering.clear();
        this.teamList = undefined;
    }

    resolve(
        key: string,
        discover: () => Promise<VercelLink | undefined>,
    ): Promise<VercelLink | undefined> {
        const cached = this.links.get(key);
        if (cached) {
            rememberBounded(this.links, key, cached, VERCEL_LINK_CACHE_LIMIT);
            return Promise.resolve(cached);
        }
        const unlinkedAt = this.unlinked.get(key);
        if (
            unlinkedAt !== undefined &&
            this.now() - unlinkedAt < (this.options.unlinkedTtlMs ?? UNLINKED_TTL_MS)
        )
            return Promise.resolve(undefined);
        const running = this.discovering.get(key);
        if (running) return running;
        const discovery = (async () => {
            try {
                const link = await discover();
                if (link) this.set(key, link);
                else rememberBounded(this.unlinked, key, this.now(), VERCEL_LINK_CACHE_LIMIT);
                return link;
            } finally {
                this.discovering.delete(key);
            }
        })();
        this.discovering.set(key, discovery);
        return discovery;
    }
}

export interface VercelDependencies {
    /**
     * Shared across refreshes; see {@link VercelLinkCache}.
     */
    links: VercelLinkCache;
    onParseFailure: (error: unknown) => void;
    run: (arguments_: readonly string[], cwd: string) => Promise<string>;
}

interface VercelDeploymentMeta {
    githubCommitAuthorLogin?: string;
    githubCommitMessage?: string;
    githubCommitOrg?: string;
    githubCommitRepo?: string;
    githubCommitSha?: string;
}

interface VercelDeployment {
    uid?: string;
    created?: number;
    inspectorUrl?: string | null;
    meta?: VercelDeploymentMeta;
    readyState?: string;
    state?: string;
    target?: 'production' | 'preview' | 'staging' | null;
    url?: string | null;
}

function deploymentState(deployment: VercelDeployment): ProjectStatusState {
    const state = (deployment.readyState ?? deployment.state ?? '').toUpperCase();
    if (state === 'READY') return 'success';
    if (state === 'ERROR') return 'failure';
    // `QUEUED` is waiting for a build slot and has produced nothing yet, so it gets the queued glyph rather than the
    // running one. `INITIALIZING` already owns a build and is reported as running, like GitHub does for its checks.
    if (state === 'QUEUED') return 'queued';
    if (['BUILDING', 'INITIALIZING'].includes(state)) return 'pending';
    return state === 'CANCELED' ? 'neutral' : 'unknown';
}

/**
 * A GitHub owner or repository segment, so a malformed provider value cannot escape the path it is interpolated into.
 */
const GITHUB_SEGMENT = /^[\w.-]+$/;
const COMMIT_SHA = /^[\da-f]{7,64}$/i;

/**
 * Vercel stores the entire commit message, body included, under a single `meta` key. Only the subject belongs on a
 * one-line tree row, and a body would otherwise stretch the hover card past the deployment it describes.
 */
function commitSubject(message: string | undefined): string | undefined {
    const subject = message?.split('\n', 1)[0]?.trim();
    if (!subject) return undefined;
    return subject;
}

function mapDeploymentCommit(
    meta: VercelDeploymentMeta | undefined,
): ProjectStatusDeploymentCommit | undefined {
    const sha = meta?.githubCommitSha;
    if (!meta || !sha || !COMMIT_SHA.test(sha)) return undefined;
    const org = meta.githubCommitOrg;
    const repo = meta.githubCommitRepo;
    const linkable = org && repo && GITHUB_SEGMENT.test(org) && GITHUB_SEGMENT.test(repo);
    const message = commitSubject(meta.githubCommitMessage);
    return {
        sha,
        ...(message && { message }),
        ...(meta.githubCommitAuthorLogin && { authorLogin: meta.githubCommitAuthorLogin }),
        ...(linkable && { url: `https://github.com/${org}/${repo}/commit/${sha}` }),
    };
}

/**
 * Which Vercel project serves this GitHub repository. Vercel has no reverse lookup, so the answer is assembled by
 * listing the account's teams and asking each one for a deployment carrying this repository's metadata: expensive
 * enough that both answers are cached (see {@link VercelLinkCache}).
 */
export function findVercelLink(
    dependencies: VercelDependencies,
    owner: string,
    repo: string,
): Promise<VercelLink | undefined> {
    return dependencies.links.resolve(`${owner}/${repo}`, async () => {
        const teams = await dependencies.links.teams(async () => {
            const teamsJson = await dependencies.run(
                ['teams', 'ls', '--format', 'json'],
                homedir(),
            );
            const parsed = parseExternalJson(teamsJson, vercelTeamListSchema, 'Vercel team list');
            return (Array.isArray(parsed) ? parsed : (parsed.teams ?? [])).flatMap((team) =>
                team.slug ? [team.slug] : [],
            );
        });
        const links = await Promise.all(
            teams.map(async (team): Promise<VercelLink | undefined> => {
                const output = await dependencies.run(
                    vcListArguments(team, { githubOrg: owner, githubRepo: repo }),
                    homedir(),
                );
                const project = parseVercelList(output)[0]?.name;
                return project ? { team, project } : undefined;
            }),
        );
        return links.find((candidate): candidate is VercelLink => Boolean(candidate));
    });
}

/**
 * This repository's branch builds and head preview, plus production associated with its branch or merged PR commit. A
 * repository with no GitHub remote has nothing to match on and never spawns `vc`.
 */
export async function loadVercelDeployments(
    dependencies: VercelDependencies,
    context: BranchPublicationContext,
    rootPath: string,
    mergeCommit?: string,
): Promise<Pick<ProjectStatusRepository, 'deployments'> & { errors: ProjectStatusError[] }> {
    if (!context.owner || !context.repo) return { errors: [] };
    try {
        const link = await findVercelLink(dependencies, context.owner, context.repo);
        if (!link)
            return {
                errors: [
                    // A missing project is ambiguous on its own: the repository may be linked but not deployed yet.
                    // The local link file is what separates "nothing shipped" from "never linked".
                    (await hasLocalVercelLink(rootPath))
                        ? projectStatusNoDeploymentsError()
                        : projectStatusCliError('vc', 'not-linked'),
                ],
            };
        const baseMeta = { githubOrg: context.owner, githubRepo: context.repo };
        const [branchListOutput, productionListOutput] = await Promise.all([
            dependencies.run(
                vcListArguments(link.team, { ...baseMeta, githubCommitRef: context.branch }),
                homedir(),
            ),
            /**
             * A merged feature branch ships under its target branch's ref. Match its exact merge commit so the panel
             * reports that delivery without attributing an unrelated default-branch build to an unmerged PR.
             */
            dependencies.run(
                vcListArguments(
                    link.team,
                    {
                        ...baseMeta,
                        ...(mergeCommit
                            ? { githubCommitSha: mergeCommit }
                            : { githubCommitRef: context.branch }),
                    },
                    'production',
                ),
                homedir(),
            ),
        ]);
        const branchList = parseVercelList(branchListOutput);
        /**
         * HEAD's preview is almost always the newest build of its own branch, which the branch list already carries.
         * Only a head that list does not cover pays for a third `vc` call (#1184: three per repository per round).
         */
        const headPreview = context.head
            ? (branchList.find(
                  (deployment) =>
                      deployment.target !== 'production' &&
                      deployment.target !== 'staging' &&
                      deployment.meta?.githubCommitSha === context.head,
              ) ??
              parseVercelList(
                  await dependencies.run(
                      vcListArguments(link.team, { githubCommitSha: context.head }, 'preview'),
                      homedir(),
                  ),
              )[0])
            : undefined;
        const branchDeployments = branchList
            .slice(0, MAX_BRANCH_DEPLOYMENTS)
            .flatMap((deployment) => {
                const mapped = mapProjectStatusDeployment(deployment, undefined, link);
                return mapped ? [mapped] : [];
            });
        return {
            deployments: {
                url: `https://vercel.com/${link.team}/${link.project}/deployments?filterBranch=${encodeURIComponent(context.branch)}`,
                branchDeployments,
                production: mapProjectStatusDeployment(
                    parseVercelList(productionListOutput)[0] ?? {},
                    'production',
                    link,
                ),
                preview: mapProjectStatusDeployment(headPreview ?? {}, 'preview', link),
            },
            errors: [],
        };
    } catch (error) {
        dependencies.onParseFailure(error);
        const failure =
            error instanceof ExternalStatusCliError
                ? error
                : new ExternalStatusCliError('vc', 'other', String(error));
        return {
            errors: [projectStatusCliError('vc', failure.kind, { retryAt: failure.retryAt })],
        };
    }
}

export function mapProjectStatusDeployment(
    deployment: VercelDeployment,
    environment?: ProjectStatusDeployment['environment'],
    link?: VercelLink,
): ProjectStatusDeployment | undefined {
    if (deployment.target === 'staging') return undefined;
    const resolvedEnvironment =
        environment ?? (deployment.target === 'production' ? 'production' : 'preview');
    const inspectorUrl = link
        ? vercelInspectorUrl(link.team, link.project, deployment.uid, deployment.inspectorUrl)
        : undefined;
    if (!deployment.url) return undefined;
    const hostname = deployment.url.replace(/^https?:\/\//, '');
    const state = deploymentState(deployment);
    const commit = mapDeploymentCommit(deployment.meta);
    return {
        environment: resolvedEnvironment,
        hostname,
        state,
        url: `https://${hostname}`,
        inspectorUrl,
        createdAt: deployment.created,
        ...(commit && { commit }),
    };
}
