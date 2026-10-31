import { useCallback, useState } from 'react';

import { showToast } from '../../../components/toast-store';
import { useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { mobileErrorMessage } from '../../connection/mobile-error-message';
import { useHostSessions } from '../components/host-sessions-provider';
import { orderedProjects, projectReorder } from '../project-order';

/**
 * Moves a Project filter chip for a control device. The strip shows the new order at once and keeps it until the
 * refreshed dashboard carries the Server's order, the same one Desktop's sidebar shows; a failed move snaps back and
 * says so.
 */
export const useProjectReorder = <Project extends { id: string }>(projects: Project[]) => {
    const { request } = useMobileClient();
    const { sessions } = useHostSessions();
    const { t } = useTranslation();
    const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
    const ordered = orderedProjects(projects, pendingOrder);
    const move = useCallback(
        async (projectId: string, toIndex: number): Promise<void> => {
            const reorder = projectReorder(
                ordered.map(({ id }) => id),
                projectId,
                toIndex,
            );
            if (!reorder) return;
            setPendingOrder(reorder.order);
            try {
                await request('mobile.project.reorder', reorder.request);
                await sessions.refresh();
            } catch (error) {
                showToast(
                    'error',
                    mobileErrorMessage(error, t('sessions.home.projectReorderFailed'), t),
                );
            } finally {
                setPendingOrder(null);
            }
        },
        [ordered, request, sessions, t],
    );
    return { move, projects: ordered };
};
