/**
 * Owns the current pairing result through handshake, credential write, and connection adoption.
 */
export const createPairingAttemptOwner = () => {
    let generation = 0;
    let active: number | null = null;
    let controller: AbortController | null = null;
    return {
        begin: () => {
            controller?.abort();
            controller = new AbortController();
            active = ++generation;
            const attempt = active;
            const currentController = controller;
            return {
                isCurrent: () => generation === attempt && !currentController.signal.aborted,
                signal: currentController.signal,
                finish: () => {
                    if (active !== attempt) {
                        return;
                    }

                    active = null;
                    controller = null;
                },
            };
        },
        cancel: () => {
            if (active === null) return false;
            controller?.abort();
            generation += 1;
            active = null;
            controller = null;
            return true;
        },
        invalidate: () => {
            controller?.abort();
            generation += 1;
            active = null;
            controller = null;
        },
    };
};
