import type { UpdateState } from '@caxri/protocol';

/**
 * Whether a verified update is waiting to install, as the native menu last saw it. Main's update service records each
 * published state here, and the menu reads it when it is built, so `Check for Updates…` can read `View Update…`.
 */
const readiness = { isReady: false };

export function isUpdateReadyInMenu(): boolean {
    return readiness.isReady;
}

/**
 * Records a published update state and returns whether readiness flipped. A native menu label cannot change in place,
 * so the caller rebuilds the menu only then.
 */
export function didUpdateReadinessChange(state: UpdateState): boolean {
    const isReady = state.status === 'ready';
    if (isReady === readiness.isReady) return false;
    readiness.isReady = isReady;
    return true;
}
