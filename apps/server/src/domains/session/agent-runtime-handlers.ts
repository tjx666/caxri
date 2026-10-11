import type { PermissionAutoAllowAccess } from '../agents';
import type { DomainHandlers } from '../domain-services';
import type { SessionAutoNamingService } from './auto-naming';

/**
 * Desktop Session methods that forward straight to `agent-runtime/runtime.ts`, which already owns their logging and
 * events.
 *
 * - The read and revoke of the "Always allow in this Session" grant (issue caxri#1295) go to its
 *   `PermissionAutoAllowController`; a Desktop-initiated revoke always uses reason `'user'`, matching the mobile
 *   `mobile.attention.autoAllowRevokeInternal` handler in `mobile/handlers.ts`.
 * - A title suggestion goes to the automatic naming service, which shares its provider concurrency limit.
 */
export function createSessionAgentRuntimeHandlers({
    attentionAutoAllowStatus,
    automaticNaming,
    revokeAutoAllow,
}: Pick<PermissionAutoAllowAccess, 'attentionAutoAllowStatus' | 'revokeAutoAllow'> & {
    automaticNaming: Pick<SessionAutoNamingService, 'suggestTitle'>;
}): Pick<
    DomainHandlers,
    | 'session.permissionAutoAllowStatus'
    | 'session.revokePermissionAutoAllow'
    | 'session.suggestTitle'
> {
    return {
        'session.permissionAutoAllowStatus': ({ sessionId }) => attentionAutoAllowStatus(sessionId),
        'session.revokePermissionAutoAllow': ({ sessionId }) => revokeAutoAllow(sessionId, 'user'),
        'session.suggestTitle': ({ sessionId }, signal) =>
            automaticNaming.suggestTitle(sessionId, signal),
    };
}
