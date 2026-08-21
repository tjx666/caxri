import type { ProjectStatusRepository, ProjectStatusState } from '@shared/types';
import { uniq } from 'es-toolkit';

export type ProjectStatusTreeNode =
    | {
          id: string;
          kind: 'branch' | 'linear' | 'deployment' | 'check' | 'hidden';
          label: string;
          description?: string;
          state?: ProjectStatusState;
          url?: string;
      }
    | {
          id: string;
          kind: 'error';
          label: string;
          description?: string;
          state?: ProjectStatusState;
          detailsView?: 'logs';
          url?: never;
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

/**
 * Keeps the screenshot-defined node order independent from React expansion state.
 */
export function buildProjectStatusNodes(repo: ProjectStatusRepository): ProjectStatusTreeNode[] {
    const nodes: ProjectStatusTreeNode[] = [
        {
            id: `${repo.id}:branch`,
            kind: 'branch',
            label: repo.branch,
            description: repo.defaultBranch === repo.branch ? 'default' : undefined,
            url: repo.branchUrl,
        },
    ];
    for (const issue of repo.linearIssues) {
        nodes.push({
            id: `${repo.id}:linear:${issue.identifier}`,
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
    if (repo.deployments) {
        const { branchDeployments } = repo.deployments;
        const environments = uniq(branchDeployments.map((entry) => entry.environment));
        // The rows below already carry the state via their icon and the branch is printed two
        // rows above, so descriptions avoid repeating either: the header counts per environment
        // when the list is uniform, and rows only name their environment when the list mixes
        // them. No dashboard `url` on the header — the per-deployment links cover navigation.
        nodes.push({
            id: `${repo.id}:deployments`,
            kind: 'deployments',
            label: 'Deployments',
            description:
                environments.length === 1
                    ? `${branchDeployments.length} on ${environments[0]}`
                    : `${branchDeployments.length} on ${repo.branch}`,
            children: branchDeployments.map((deployment, index) => ({
                id: `${repo.id}:branch-deployment:${index}`,
                kind: 'deployment',
                label: deployment.hostname,
                description: environments.length === 1 ? undefined : deployment.environment,
                state: deployment.state,
                url: deployment.url,
            })),
        });
        for (const [label, deployment] of [
            ['Production', repo.deployments.production],
            ['Preview', repo.deployments.preview],
        ] as const) {
            if (!deployment) continue;
            nodes.push({
                id: `${repo.id}:${deployment.environment}`,
                kind: 'deployment',
                label,
                description: deployment.hostname,
                state: deployment.state,
                url: deployment.url,
            });
        }
    }
    if (repo.pullRequest) {
        const pullRequest = repo.pullRequest;
        const children: ProjectStatusTreeNode[] = pullRequest.checks.map((check, index) => ({
            id: `${repo.id}:check:${index}`,
            kind: 'check',
            label: check.name,
            description: durationLabel(check.durationMs),
            state: check.state,
            url: check.url,
        }));
        if (pullRequest.hiddenCheckCount > 0) {
            children.push({
                id: `${repo.id}:hidden-checks`,
                kind: 'hidden',
                label: `${pullRequest.hiddenCheckCount} ignored check${pullRequest.hiddenCheckCount === 1 ? '' : 's'} hidden`,
            });
        }
        nodes.push({
            id: `${repo.id}:pr`,
            kind: 'pullRequest',
            label: `#${pullRequest.number} ${pullRequest.title}`,
            state: pullRequest.state,
            url: pullRequest.url,
            children,
        });
    }
    for (const error of repo.errors) {
        nodes.push({
            id: `${repo.id}:error:${error.source}`,
            kind: 'error',
            label: error.message,
            description: error.hint,
            state: 'failure',
            detailsView: error.detailsView,
        });
    }
    return nodes;
}
