/**
 * Why the phone closed its gateway socket, carried as a private-range WebSocket close code (RFC 6455 reserves 4000-4999
 * for applications). The phone has no structured-log sink, so the close frame is the only place its own verdict reaches
 * the Server log. Best effort: when the network is already gone the frame never arrives and the Server records a
 * dropped peer instead.
 */
export const mobileClientCloseReasons = {
    /**
     * The phone sent a heartbeat and the Server did not acknowledge it in time.
     */
    'heartbeat-timeout': 4001,
    /**
     * A read or mutation reply did not arrive in time.
     */
    'request-timeout': 4002,
    /**
     * A Server frame failed to decrypt, parse, or match the phone's request and subscription state.
     */
    'protocol-error': 4004,
    /**
     * The phone could not write a frame to the socket.
     */
    'send-failed': 4005,
    /**
     * A request failed without a Server error reply, for example a reply the phone could not parse.
     */
    'request-failed': 4006,
    /**
     * The app screen that owned the connection went away, for example after a render error reset the app.
     */
    'unmounted': 4010,
    /**
     * The app returned to the foreground after long enough in the background to start over.
     */
    'foreground-reconnect': 4011,
    /**
     * The phone's network changed while it was waiting to reconnect.
     */
    'network-reconnect': 4012,
    /**
     * A foreground probe or a read went unanswered and a replacement connection was ready before this one answered.
     */
    'probe-failed': 4013,
    /**
     * A newer connection or pairing replaced this one, or a reconnect finished after its owner had gone.
     */
    'superseded': 4014,
    /**
     * The user removed this computer from the phone.
     */
    'forgotten': 4015,
    /**
     * A direct LAN or Tailscale path answered repeatedly while the phone was on the Relay, so it reconnects directly.
     */
    'route-upgrade': 4016,
    /**
     * The Server did not confirm a new connection with `ready` in time after the phone's handshake `confirm`.
     */
    'ready-timeout': 4018,
    /**
     * More Server frames arrived than the phone's bounded inbox holds while its reader was still busy.
     */
    'inbox-overflow': 4017,
} as const;

export type MobileClientCloseReason = keyof typeof mobileClientCloseReasons;

const reasonByCode = new Map<number, MobileClientCloseReason>(
    Object.entries(mobileClientCloseReasons).map(([reason, code]) => [
        code,
        reason as MobileClientCloseReason,
    ]),
);

/**
 * The phone's close reason for a received close code, `undefined` for a standard or unknown code.
 */
export const mobileClientCloseReasonOf = (code: number): MobileClientCloseReason | undefined =>
    reasonByCode.get(code);
