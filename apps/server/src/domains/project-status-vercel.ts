import type { ProjectStatusDeployment, ProjectStatusState } from '@caxri/protocol';

import type { VercelLink } from './project-status-external';
import { vercelInspectorUrl } from './project-status-external';

interface VercelDeployment {
    created?: number;
    readyState?: string;
    state?: string;
    target?: 'production' | 'preview' | null;
    url?: string;
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
    environment: ProjectStatusDeployment['environment'] = deployment.target === 'production'
        ? 'production'
        : 'preview',
    link?: VercelLink,
): ProjectStatusDeployment | undefined {
    if (!deployment.url) return undefined;
    const hostname = deployment.url.replace(/^https?:\/\//, '');
    const state = deploymentState(deployment);
    return {
        environment,
        hostname,
        state,
        url: `https://${hostname}`,
        inspectorUrl: link ? vercelInspectorUrl(link.team, link.project, hostname) : undefined,
        createdAt: deployment.created,
    };
}
