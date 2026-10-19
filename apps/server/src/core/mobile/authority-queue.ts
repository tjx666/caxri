import type { Principal } from '@caxri/protocol';

type PairedPrincipal = Extract<Principal, { kind: 'paired-device' }>;

/**
 * The mobile access controller's authority queue and the writes revocation can cancel. Every grant check and grant
 * change runs one at a time through `withAuthority`, so a revocation can never interleave with an admission. A write
 * that outlives its admission registers an `AbortController` under its device and generation, which `abortOperations`
 * cancels when that pairing is revoked or the controller closes.
 */
export const createMobileAuthorityQueue = () => {
    let authorityTail = Promise.resolve();
    const inFlightOperations = new Map<string, Set<AbortController>>();
    const withAuthority = <T>(task: () => Promise<T> | T): Promise<T> => {
        const previous = authorityTail;
        const release = Promise.withResolvers<void>();
        authorityTail = release.promise;
        return (async () => {
            await previous;
            try {
                return await task();
            } finally {
                release.resolve();
            }
        })();
    };
    const operationKey = (deviceId: string, generation: number): string =>
        `${deviceId}:${generation}`;
    const registerOperation = (principal: PairedPrincipal) => {
        const cancellation = new AbortController();
        const key = operationKey(principal.deviceId, principal.generation);
        const controllers = inFlightOperations.get(key) ?? new Set<AbortController>();
        controllers.add(cancellation);
        inFlightOperations.set(key, controllers);
        return cancellation;
    };
    const unregisterOperation = (
        identity: { deviceId: string; generation: number },
        controller: AbortController,
    ): void => {
        const key = operationKey(identity.deviceId, identity.generation);
        const controllers = inFlightOperations.get(key);
        controllers?.delete(controller);
        if (controllers?.size === 0) inFlightOperations.delete(key);
    };
    return {
        /**
         * Cancels the in-flight writes of one pairing generation, or of every pairing when `identity` is omitted.
         */
        abortOperations: (identity?: { deviceId: string; generation: number }): void => {
            for (const [key, controllers] of inFlightOperations) {
                if (identity && key !== operationKey(identity.deviceId, identity.generation))
                    continue;
                for (const controller of controllers) controller.abort();
            }
        },
        /**
         * Runs a paired-device write that revocation can cancel. Admission and the final grant check run in the
         * authority queue, the write itself outside it, so a slow write never holds up the revocation that would abort
         * it.
         */
        runRevocableOperation: async <T>(
            admit: () => PairedPrincipal,
            write: (principal: PairedPrincipal, signal: AbortSignal) => Promise<T>,
            settle: (principal: PairedPrincipal, signal: AbortSignal) => void,
        ): Promise<T> => {
            const { principal, cancellation } = await withAuthority(() => {
                const principal = admit();
                return { principal, cancellation: registerOperation(principal) };
            });
            try {
                const result = await write(principal, cancellation.signal);
                return await withAuthority(() => {
                    settle(principal, cancellation.signal);
                    return result;
                });
            } finally {
                await withAuthority(() => unregisterOperation(principal, cancellation));
            }
        },
        withAuthority,
    };
};
