/**
 * Whether the Session's ports are worth asking for. Only a `control` device on a live, visible, `direct` connection
 * asks: the preview proxy listens on the gateway's LAN address, so over the Relay every open would fail and the chip
 * would only offer a dead end.
 */
export function isSessionPreviewObservable(state: {
    connectionScopeKey: string | null;
    deviceRole: 'view' | 'reply' | 'control' | null;
    isFocused: boolean;
    isForeground: boolean;
    route: 'direct' | 'relay' | null;
    status: string;
}): boolean {
    return (
        state.deviceRole === 'control' &&
        state.connectionScopeKey !== null &&
        state.isForeground &&
        state.isFocused &&
        state.status === 'connected' &&
        state.route === 'direct'
    );
}
