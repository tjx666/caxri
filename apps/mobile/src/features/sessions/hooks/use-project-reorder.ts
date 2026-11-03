import { useCallback, useState } from 'react';

import { showToast } from '../../../components/toast-store';
import { useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { mobileErrorMessage } from '../../connection/mobile-error-message';
import { useHostSessions } from '../components/host-sessions-provider';
import type { PendingProjectOrder } from '../project-order';
import {
    isPendingProjectOrderCurrent,
    orderedProjects,
    projectOrderKey,
    projectReorder,
} from '../project-order';

/**
 * Moves a Project filter chip for a control device. The strip shows the new order at once and keeps it until the
 * dashboard carries a different order than the one the move started from, normally the Server's order that Desktop's
 * sidebar shows; a failed move snaps back and says so.
 */
export const useProjectReorder = <Project extends { id: string }>(projects: Project[]) => {
    const { request } = useMobileClient();
    const { sessions } = useHostSessions();
    const { t } = useTranslation();
    const [pending, setPending] = useState<PendingProjectOrder | null>(null);
    const serverOrder = projectOrderKey(projects.map(({ id }) => id));
    const applies = isPendingProjectOrderCurrent(serverOrder, pending);
    // Drop a superseded move during render so a later dashboard that happens to repeat the old order cannot revive it.
    if (pending && !applies) setPending(null);
    const ordered = orderedProjects(projects, applies ? pending.order : null);
    const move = useCallback(
        async (projectId: string, toIndex: number): Promise<void> => {
            const reorder = projectReorder(
                ordered.map(({ id }) => id),
                projectId,
                toIndex,
            );
            if (!reorder) return;
            setPending({ baseline: serverOrder, order: reorder.order });
            try {
                await request('mobile.project.reorder', reorder.request);
                await sessions.refresh();
            } catch (error) {
                setPending(null);
                showToast(
                    'error',
                    mobileErrorMessage(error, t('sessions.home.projectReorderFailed'), t),
                );
            }
        },
        [ordered, request, serverOrder, sessions, t],
    );
    return { move, projects: ordered };
};
