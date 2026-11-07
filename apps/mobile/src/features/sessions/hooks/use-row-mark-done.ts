import { useCallback, useState } from 'react';

import { showToast } from '../../../components/toast-store';
import { useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import type { MobileSessionItem } from '../session-model';

const withoutId = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => {
    const next = new Set(ids);
    next.delete(id);
    return next;
};

/**
 * Mark as Done from a Session row's check, as Desktop's Activity view does from a Needs attention row. It resolves the
 * attention generation the row showed, then refreshes the list so the row moves out of Needs attention at once. A
 * failure has no sheet or header to sit in, so it shows as a toast; `pendingIds` keeps a second tap from sending the
 * same request while the first is in flight.
 */
export const useRowMarkDone = ({ onRefresh }: { onRefresh: () => Promise<void> }) => {
    const { request } = useMobileClient();
    const { t } = useTranslation();
    const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
    const markDone = useCallback(
        async (session: MobileSessionItem): Promise<void> => {
            const sessionId = session.id;
            setPendingIds((previous) => new Set(previous).add(sessionId));
            try {
                await request('session.markDone', {
                    sessionId,
                    attentionGeneration: session.attentionGeneration,
                });
            } catch (error) {
                showToast(
                    'error',
                    t(
                        error instanceof MobileGatewayRequestError && error.code === 'FORBIDDEN'
                            ? 'sessions.detail.markDoneForbidden'
                            : 'sessions.detail.markDoneFailed',
                    ),
                );
                setPendingIds((previous) => withoutId(previous, sessionId));
                return;
            }
            try {
                await onRefresh();
            } catch {
                // The Session is already done; a failed refresh only delays the move until the next poll.
            }
            setPendingIds((previous) => withoutId(previous, sessionId));
        },
        [onRefresh, request, t],
    );
    return { markDone, pendingIds };
};
