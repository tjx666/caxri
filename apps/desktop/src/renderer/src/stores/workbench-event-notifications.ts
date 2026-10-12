import type { BootstrapState, ServerEvent } from '@caxri/protocol';

import { sessionTitleForDisplay } from '../features/session/session-title';
import { translate } from '../i18n';
import { recordNotification } from './notifications';

type EventPayload<E extends ServerEvent['event']> = Extract<ServerEvent, { event: E }>['payload'];

/**
 * Records an Agent attention change in the notification center, named by its Session's current display title.
 */
export function recordAgentNotification(
    payload: EventPayload<'agent.notification'>,
    bootstrap: BootstrapState | undefined,
): void {
    const session = bootstrap?.sessions.find((item) => item.id === payload.sessionId);
    recordNotification({
        kind: 'info',
        message: translate(
            payload.attentionKind === 'waiting'
                ? 'core.agentNotification.waiting'
                : 'core.agentNotification.completed',
            {
                title: session ? sessionTitleForDisplay(session.displayTitle, translate) : 'Agent',
            },
        ),
        projectId: session?.projectId,
        projectTitle: bootstrap?.projects.find((item) => item.id === session?.projectId)
            ?.displayTitle,
    });
}

export function recordProjectStatusAlert(payload: EventPayload<'projectStatus.alert'>): void {
    recordNotification({
        kind: 'error',
        message: translate(
            payload.kind === 'check'
                ? 'core.projectStatusAlert.checkFailed'
                : 'core.projectStatusAlert.deploymentFailed',
            { name: payload.name },
        ),
        projectId: `${payload.repository}:${payload.branch}`,
        projectTitle: `${payload.repository} · ${payload.branch}`,
    });
}
