import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Turns off the Session's "Always allow in this Session" grant (issue caxri#1295). No `refresh` option: the Session row
 * menu's own `session.permissionAutoAllowStatus` read refreshes off the Server's `agent.permissionAutoAllowChanged`
 * event (`queries/invalidation.ts`), so a manual invalidation here would only race that same event.
 */
export function revokePermissionAutoAllow(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(translate('session.errors.revokeAutoAllowFailed'), () =>
        caxri.request('session.revokePermissionAutoAllow', { sessionId }),
    );
}
