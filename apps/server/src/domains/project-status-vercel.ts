import type { ProjectStatusDeployment, ProjectStatusState } from '@caxri/protocol';

import type { VercelLink } from './project-status-external';
import { vercelInspectorUrl } from './project-status-external';

interface VercelDeployment {
    uid?: string;
    created?: number;
    inspectorUrl?: string | null;
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
    return {
        environment: resolvedEnvironment,
        hostname,
        state,
        url: `https://${hostname}`,
        inspectorUrl,
        createdAt: deployment.created,
    };
}
