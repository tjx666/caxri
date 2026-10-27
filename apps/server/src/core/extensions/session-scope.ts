import type { ExtensionViewEventContext } from '@caxri/protocol';

/**
 * One Session's Project and Workbench Root identities plus the visible Project IDs, as `app.sessionContext` returns
 * them. Empty identities mean the Session no longer exists or is hidden.
 */
export interface ResolvedSessionContext {
    ownerProjectId?: string;
    projectIds: string[];
    sessionId?: string;
    workbenchRootProjectId?: string;
}

/**
 * The Session and Workbench Root a view request or nested extension API call is scoped to.
 */
export interface SessionScope {
    sessionId: string;
    workbenchRootProjectId: string;
}

/**
 * Copies only the Session scope out of a wider view context, so extra context fields never reach the API call.
 */
export function sessionScopeOf({ sessionId, workbenchRootProjectId }: SessionScope): SessionScope {
    return { sessionId, workbenchRootProjectId };
}

export type SessionContextReader = (sessionId: string) => Promise<ResolvedSessionContext>;

export async function resolveViewContext(
    readSessionContext: SessionContextReader,
    context: ExtensionViewEventContext,
): Promise<{ sessionId?: string; workbenchRootProjectId?: string }> {
    return context.kind === 'session' ? readSessionContext(context.sessionId) : {};
}

/**
 * Rejects a result whose Session was deleted, hidden, or rebound to another Workbench Root while it was computed.
 */
export async function assertSessionScopeUnchanged(
    readSessionContext: SessionContextReader,
    scope: SessionScope,
): Promise<void> {
    const current = await readSessionContext(scope.sessionId);
    if (
        current.sessionId !== scope.sessionId ||
        current.workbenchRootProjectId !== scope.workbenchRootProjectId
    )
        throw Object.assign(
            new Error('Session scope changed while the extension request was running'),
            { code: 'GENERATION_EXPIRED' },
        );
}

/**
 * Requires the Session's owner Project and Workbench Root to be visible and inside the extension's Project grant.
 */
export function assertSessionWithinGrant(
    resolved: ResolvedSessionContext,
    grantProjectIds: ReadonlySet<string> | undefined,
): void {
    const visibleProjectIds = new Set(resolved.projectIds);
    const scopeProjectIds = [resolved.ownerProjectId, resolved.workbenchRootProjectId].filter(
        (projectId): projectId is string => Boolean(projectId),
    );
    if (
        scopeProjectIds.some(
            (projectId) => !visibleProjectIds.has(projectId) || !grantProjectIds?.has(projectId),
        )
    )
        throw Object.assign(new Error('Session Project is outside the extension grant'), {
            code: 'PROJECT_SCOPE_DENIED',
        });
}
