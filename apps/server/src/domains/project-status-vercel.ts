import type {
    ProjectStatusDeployment,
    ProjectStatusDeploymentCommit,
    ProjectStatusState,
} from '@caxri/protocol';

import type { VercelLink } from './project-status-external';
import { vercelInspectorUrl } from './project-status-external';

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
    if (['BUILDING', 'QUEUED', 'INITIALIZING'].includes(state)) return 'pending';
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
