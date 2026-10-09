import type { PermissionAutoAllowAccess } from './agents';
import type { DomainHandlers } from './domain-services';

/**
 * Desktop's read and revoke of the "Always allow in this Session" grant (issue caxri#1295). Both forward straight to
 * `agent-runtime.ts`'s `PermissionAutoAllowController`, which already owns the grant's logging and event emission; a
 * Desktop-initiated revoke always uses reason `'user'`, matching the mobile `mobile.attention.autoAllowRevokeInternal`
 * handler in `mobile/handlers.ts`.
 */
export function createSessionPermissionAutoAllowHandlers({
    attentionAutoAllowStatus,
    revokeAutoAllow,
}: Pick<PermissionAutoAllowAccess, 'attentionAutoAllowStatus' | 'revokeAutoAllow'>): Pick<
    DomainHandlers,
    'session.permissionAutoAllowStatus' | 'session.revokePermissionAutoAllow'
> {
    return {
        'session.permissionAutoAllowStatus': ({ sessionId }) => attentionAutoAllowStatus(sessionId),
        'session.revokePermissionAutoAllow': ({ sessionId }) => revokeAutoAllow(sessionId, 'user'),
    };
}
