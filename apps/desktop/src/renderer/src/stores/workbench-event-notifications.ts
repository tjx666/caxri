import type { BootstrapState, ServerEvent } from '@caxri/protocol';

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
        message: `${session?.displayTitle ?? 'Agent'} ${payload.attentionKind === 'waiting' ? 'is waiting for your input.' : 'completed a turn.'}`,
        projectId: session?.projectId,
        projectTitle: bootstrap?.projects.find((item) => item.id === session?.projectId)
            ?.displayTitle,
    });
}

export function recordProjectStatusAlert(payload: EventPayload<'projectStatus.alert'>): void {
    recordNotification({
        kind: 'error',
        message:
            payload.kind === 'check'
                ? `CI failed: ${payload.name}`
                : `${payload.name} deployment failed`,
        projectId: `${payload.repository}:${payload.branch}`,
        projectTitle: `${payload.repository} · ${payload.branch}`,
    });
}
