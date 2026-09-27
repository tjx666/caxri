import { ShieldCheck } from 'lucide-react';

import { useCaxriQuery } from '../../queries/client';
import { useSelectedSession } from '../../stores/selectors';
import { revokePermissionAutoAllow } from '../session/permission-auto-allow-commands';
import { StatusItem } from './status-item';

const PERMISSION_AUTO_ALLOW_CHIP_LABEL =
    'Always allow is on for this Session: every Agent permission request is allowed automatically. Click to turn it off.';

/**
 * Standing disclosure for the selected Session's "Always allow in this Session" grant (issue caxri#1295), which a
 * mobile device turns on. The grant is a Server in-memory mode, not a Caxri failure, so it stays muted per DESIGN.md's
 * status bar redline, like Screencast Mode; clicking revokes it, the same action the Session row menu offers.
 * `session.permissionAutoAllowStatus` refreshes off `agent.permissionAutoAllowChanged` (`queries/invalidation.ts`), so
 * a grant or revoke from a phone shows up here without polling.
 */
export function PermissionAutoAllowChip() {
    const session = useSelectedSession();
    const sessionId = session?.id;
    const { data } = useCaxriQuery(
        'session.permissionAutoAllowStatus',
        { sessionId: sessionId ?? '' },
        { enabled: sessionId !== undefined },
    );
    if (!sessionId || !data?.granted) return null;
    return (
        <StatusItem
            icon={<ShieldCheck />}
            ariaLabel={PERMISSION_AUTO_ALLOW_CHIP_LABEL}
            title={PERMISSION_AUTO_ALLOW_CHIP_LABEL}
            className="text-muted"
            onClick={() => revokePermissionAutoAllow(sessionId)}
        >
            Always Allow
        </StatusItem>
    );
}
