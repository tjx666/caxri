import type {
    AgentSecretScope,
    AgentSecretSummary,
    ProjectRecord,
    ServerOperationParameters,
} from '@caxri/protocol';
import { agentSecretNameSchema, CaxriError, isTopLevelProject } from '@caxri/protocol';

/**
 * The Select value standing for the global scope; Project scopes use the Project ID.
 */
export const GLOBAL_SCOPE_VALUE = '__global__';

export function scopeValue(scope: AgentSecretScope): string {
    return scope.kind === 'global' ? GLOBAL_SCOPE_VALUE : scope.projectId;
}

export function scopeFromValue(value: string): AgentSecretScope {
    return value === GLOBAL_SCOPE_VALUE
        ? { kind: 'global' }
        : { kind: 'project', projectId: value };
}

/**
 * Projects a secret can be saved for. A worktree Project shares its owner's secrets (see the Server's
 * `AgentSecretService`), so only top-level Projects are offered.
 */
export function secretScopeProjects(
    projects: readonly ProjectRecord[] | undefined,
): ProjectRecord[] {
    return (projects ?? []).filter((project) => isTopLevelProject(project));
}

/**
 * The scope a new secret defaults to: the selected Project, or its owner when a worktree Project is selected, else
 * every Project.
 */
export function defaultSecretScope(project: ProjectRecord | undefined): AgentSecretScope {
    if (!project) return { kind: 'global' };
    return { kind: 'project', projectId: project.ownerProjectId ?? project.id };
}

/**
 * Global secrets first, then Project secrets grouped by Project title, each group by name.
 */
export function sortSecrets(
    secrets: readonly AgentSecretSummary[],
    projectTitle: (projectId: string) => string | undefined,
): AgentSecretSummary[] {
    const group = (secret: AgentSecretSummary): string =>
        secret.scope.kind === 'global'
            ? ''
            : `\u{1}${projectTitle(secret.scope.projectId) ?? secret.scope.projectId}`;
    return secrets.toSorted(
        (left, right) =>
            group(left).localeCompare(group(right)) || left.name.localeCompare(right.name),
    );
}

export function isValidSecretName(name: string): boolean {
    return agentSecretNameSchema.safeParse(name).success;
}

type SecretRequestAnswer = ServerOperationParameters<'secrets.requests.answer'>['answer'];

/**
 * A request card's answer: Save stores the value for the request's Project, or for every Project when the user ticked
 * it; Decline sends no value.
 */
export function secretRequestAnswer(
    action: 'save' | 'decline',
    value: string,
    isGlobal: boolean,
): SecretRequestAnswer {
    return action === 'save'
        ? { action, value, scope: isGlobal ? 'global' : 'project' }
        : { action };
}

/**
 * `gone` when the request was already answered, withdrawn, or expired, so the card says so instead of a retry hint.
 */
export function secretAnswerFailure(error: unknown): 'failed' | 'gone' {
    return error instanceof CaxriError && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')
        ? 'gone'
        : 'failed';
}
