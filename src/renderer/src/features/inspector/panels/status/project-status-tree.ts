import type { ProjectStatusRepository, ProjectStatusState } from '@shared/types';

export type ProjectStatusTreeNode =
    | {
          id: string;
          kind: 'branch' | 'linear' | 'deployment' | 'check' | 'error' | 'hidden';
          label: string;
          description?: string;
          state?: ProjectStatusState;
          url?: string;
      }
    | {
          id: string;
          kind: 'deployments' | 'pullRequest';
          label: string;
          description?: string;
          state?: ProjectStatusState;
          url?: string;
          children: ProjectStatusTreeNode[];
      };

function durationLabel(durationMs: number | undefined): string | undefined {
    if (durationMs === undefined) return undefined;
    const seconds = Math.round(durationMs / 1_000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

/** Keeps the screenshot-defined node order independent from React expansion state. */
export function buildProjectStatusNodes(
    repository: ProjectStatusRepository,
): ProjectStatusTreeNode[] {
    const nodes: ProjectStatusTreeNode[] = [
        {
            id: `${repository.id}:branch`,
            kind: 'branch',
            label: repository.branch,
            description: repository.defaultBranch === repository.branch ? 'default' : undefined,
            url: repository.branchUrl,
        },
    ];
    for (const issue of repository.linearIssues) {
        nodes.push({
            id: `${repository.id}:linear:${issue.identifier}`,
            kind: 'linear',
            label: issue.title ? `${issue.identifier} ${issue.title}` : issue.identifier,
            description: issue.state,
            state:
                issue.stateType === 'completed'
                    ? 'success'
                    : issue.stateType === 'canceled' || issue.stateType === 'duplicate'
                      ? 'neutral'
                      : issue.stateType === 'started'
                        ? 'pending'
                        : 'unknown',
            url: issue.url,
        });
    }
    if (repository.deployments) {
        nodes.push({
            id: `${repository.id}:deployments`,
            kind: 'deployments',
            label: 'Deployments',
            description: `${repository.deployments.branchDeployments.length} on ${repository.branch}`,
            url: repository.deployments.url,
            children: repository.deployments.branchDeployments.map((deployment, index) => ({
                id: `${repository.id}:branch-deployment:${index}`,
                kind: 'deployment',
                label: deployment.hostname,
                description: `${deployment.environment} · ${deployment.state}`,
                state: deployment.state,
                url: deployment.url,
            })),
        });
        for (const [label, deployment] of [
            ['Production', repository.deployments.production],
            ['Preview', repository.deployments.preview],
        ] as const) {
            if (!deployment) continue;
            nodes.push({
                id: `${repository.id}:${deployment.environment}`,
                kind: 'deployment',
                label,
                description: `${deployment.state} · ${deployment.hostname}`,
                state: deployment.state,
                url: deployment.url,
            });
        }
    }
    if (repository.pullRequest) {
        const pullRequest = repository.pullRequest;
        const children: ProjectStatusTreeNode[] = pullRequest.checks.map((check, index) => ({
            id: `${repository.id}:check:${index}`,
            kind: 'check',
            label: check.name,
            description: durationLabel(check.durationMs),
            state: check.state,
            url: check.url,
        }));
        if (pullRequest.hiddenCheckCount > 0) {
            children.push({
                id: `${repository.id}:hidden-checks`,
                kind: 'hidden',
                label: `${pullRequest.hiddenCheckCount} ignored check${pullRequest.hiddenCheckCount === 1 ? '' : 's'} hidden`,
            });
        }
        nodes.push({
            id: `${repository.id}:pr`,
            kind: 'pullRequest',
            label: `#${pullRequest.number} ${pullRequest.title}`,
            state: pullRequest.state,
            url: pullRequest.url,
            children,
        });
    }
    for (const error of repository.errors) {
        nodes.push({
            id: `${repository.id}:error:${error.source}`,
            kind: 'error',
            label: error.message,
            description: error.hint,
            state: 'failure',
        });
    }
    return nodes;
}
