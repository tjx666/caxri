/**
 * Collapses the notification shade and quick settings so every case starts from the same system UI. The shade is device
 * state that `pm clear` leaves alone: one left open (by an earlier case's swipe near the top edge, a sibling session,
 * or a manual pull) covers the app, and the next case then fails on a wait that points nowhere near the cause.
 * `MOB-CONV-04` failed that way once in a batch (#3787). Collapsing an already collapsed shade is a no-op.
 */
export function collapseAndroidStatusBar(runDevice: (arguments_: string[]) => unknown): void {
    runDevice(['shell', 'cmd', 'statusbar', 'collapse']);
}
