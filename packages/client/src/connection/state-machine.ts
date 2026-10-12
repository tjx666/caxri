type DesktopReadiness = 'pending' | 'announced';

interface ReconnectContext {
    attempt: number;
    outageStartedAtMs: number;
    readiness: DesktopReadiness;
}

export type ServerConnectionState =
    | { status: 'idle' }
    | { status: 'attaching'; mode: 'initial' }
    | ({ status: 'backoff' } & ReconnectContext)
    | ({ status: 'attaching'; mode: 'reconnect' } & ReconnectContext)
    | ({ status: 'recovering'; serverContinuity: 'same' | 'replaced' } & ReconnectContext)
    | { status: 'attached' }
    | { status: 'ready' }
    | { status: 'replaced' }
    | { status: 'disposed' };

export type ServerConnectionTransition =
    | { type: 'start' }
    | { type: 'attachment-succeeded'; serverContinuity: 'same' | 'replaced' }
    | { type: 'attachment-failed' }
    | { type: 'desktop-ready' }
    | { type: 'connection-lost'; atMs: number; reason: 'replaced' | 'transport' }
    | { type: 'backoff-elapsed' }
    | { type: 'recovery-completed' }
    /**
     * The user explicitly chose to take back a lease another Desktop replaced. Nothing automatic sends it, so two
     * Desktops never fight over one Server.
     */
    | { type: 'reclaim'; atMs: number }
    | { type: 'dispose' };

export const initialServerConnectionState: ServerConnectionState = { status: 'idle' };

/**
 * The reconnect bookkeeping a state carries, or `undefined` when no reconnect loop owns it. Exported because the "am I
 * between attachments" question belongs to this model: `attaching` alone cannot answer it, since the first attachment
 * shares that status and carries no outage of its own.
 */
export function reconnectContext(state: ServerConnectionState): ReconnectContext | undefined {
    switch (state.status) {
        case 'backoff':
        case 'recovering':
            return state;
        case 'attaching':
            return state.mode === 'reconnect' ? state : undefined;
        default:
            return undefined;
    }
}

/**
 * Pure Desktop↔Server lifecycle transition table. Socket, timer, readiness, and event-recovery I/O stay in the Desktop
 * connection facade; this model only makes mutually exclusive phases and terminal states explicit.
 */
export function transitionServerConnection(
    state: ServerConnectionState,
    transition: ServerConnectionTransition,
): ServerConnectionState {
    if (transition.type === 'dispose') return { status: 'disposed' };
    if (transition.type === 'reclaim')
        return state.status === 'replaced'
            ? {
                  status: 'backoff',
                  attempt: 1,
                  outageStartedAtMs: transition.atMs,
                  readiness: 'announced',
              }
            : state;
    if (state.status === 'disposed' || state.status === 'replaced') return state;

    switch (transition.type) {
        case 'start':
            if (state.status === 'idle') return { status: 'attaching', mode: 'initial' };
            return state;
        case 'attachment-succeeded': {
            if (state.status !== 'attaching') return state;
            if (state.mode === 'initial') return { status: 'attached' };
            return {
                status: 'recovering',
                attempt: state.attempt,
                serverContinuity: transition.serverContinuity,
                outageStartedAtMs: state.outageStartedAtMs,
                readiness: state.readiness,
            };
        }
        case 'attachment-failed': {
            if (state.status !== 'attaching') return state;
            if (state.mode === 'initial') return { status: 'idle' };
            return {
                status: 'backoff',
                attempt: state.attempt + 1,
                outageStartedAtMs: state.outageStartedAtMs,
                readiness: state.readiness,
            };
        }
        case 'desktop-ready': {
            if (state.status === 'attached') return { status: 'ready' };
            if (state.status === 'backoff' || state.status === 'recovering')
                return { ...state, readiness: 'announced' };
            if (state.status === 'attaching' && state.mode === 'reconnect')
                return { ...state, readiness: 'announced' };
            return state;
        }
        case 'connection-lost': {
            if (transition.reason === 'replaced') return { status: 'replaced' };
            const context = reconnectContext(state);
            if (context) {
                return {
                    status: 'backoff',
                    attempt: context.attempt + (state.status === 'backoff' ? 0 : 1),
                    outageStartedAtMs: context.outageStartedAtMs,
                    readiness: context.readiness,
                };
            }
            if (state.status === 'idle') return state;
            return {
                status: 'backoff',
                attempt: 1,
                outageStartedAtMs: transition.atMs,
                readiness: state.status === 'ready' ? 'announced' : 'pending',
            };
        }
        case 'backoff-elapsed':
            if (state.status !== 'backoff') return state;
            return { ...state, status: 'attaching', mode: 'reconnect' };
        case 'recovery-completed':
            if (state.status !== 'recovering') return state;
            return state.readiness === 'announced' ? { status: 'ready' } : { status: 'attached' };
    }
}
