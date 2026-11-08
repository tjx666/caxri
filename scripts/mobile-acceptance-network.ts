/**
 * Turns both emulator network transports back on. A scenario or ad hoc probe that disables them (the stale-session
 * cases, an offline capture) and then fails or is interrupted before its own `finally` leaves the emulator offline, and
 * every later case then fails at pairing with no hint that networking is the cause. `pm clear` leaves this device state
 * alone, so the runner restores it at the start and end of every case. Both transports are attempted even when the
 * first fails; enabling an already enabled transport is a no-op.
 */
export function enableAndroidNetwork(runDevice: (arguments_: string[]) => unknown): void {
    let failure: unknown;
    for (const service of ['wifi', 'data']) {
        try {
            runDevice(['shell', 'svc', service, 'enable']);
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure) throw new Error('Mobile Acceptance could not enable every network transport');
}
