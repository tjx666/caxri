import type { BootstrapState, ServerEvent } from '@caxri/protocol';

import { sessionTitleForDisplay } from '../features/session/session-title';
import { translate } from '../i18n';
import { recordNotification } from './notifications';
import { reportSessionAutoArchived } from './session-auto-archive-notice';
import { pushToast } from './toasts';

type EventPayload<E extends ServerEvent['event']> = Extract<ServerEvent, { event: E }>['payload'];

/**
 * Records an Agent attention change in the notification center, named by its Session's current display title.
 */
function recordAgentNotification(
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
                title: session ? sessionTitleForDisplay(session.title, translate) : 'Agent',
            },
        ),
        projectId: session?.projectId,
        projectTitle: bootstrap?.projects.find((item) => item.id === session?.projectId)?.title,
    });
}

function recordProjectStatusAlert(payload: EventPayload<'projectStatus.alert'>): void {
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

/**
 * Main reports this at most once per launch: a banner was dropped because the notification helper is missing and the
 * basic macOS fallback failed too. The toast points at the Settings row that explains how to fix it.
 */
function reportNotificationHelperUnavailable(): void {
    pushToast('warning', translate('settings.notificationHelper.toast.unavailable'), {
        action: { id: 'settings.openNotifications' },
    });
}

/**
 * Routes the Main- and Server-raised events that belong in the notification center to their recorders.
 */
export function recordNotificationEvent(
    event: Extract<
        ServerEvent,
        {
            event:
                | 'agent.notification'
                | 'notifications.helperUnavailable'
                | 'projectStatus.alert'
                | 'session.autoArchived';
        }
    >,
    bootstrap: BootstrapState | undefined,
): void {
    switch (event.event) {
        case 'agent.notification':
            recordAgentNotification(event.payload, bootstrap);
            return;
        case 'projectStatus.alert':
            recordProjectStatusAlert(event.payload);
            return;
        case 'notifications.helperUnavailable':
            reportNotificationHelperUnavailable();
            return;
        case 'session.autoArchived':
            reportSessionAutoArchived(event.payload, bootstrap);
            return;
    }
}
