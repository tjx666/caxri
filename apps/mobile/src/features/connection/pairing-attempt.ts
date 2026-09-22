export interface PairingAttempt {
    readonly signal: AbortSignal;
    cancel(): void;
}

export interface PairingOperation {
    readonly promise: Promise<void>;
    cancel(): void;
}

export interface PairingAttemptRegistry {
    begin(): PairingAttempt;
    cancel(attempt: PairingAttempt): void;
    cancelCurrent(): void;
    finish(attempt: PairingAttempt): void;
    isCurrent(attempt: PairingAttempt): boolean;
}

export interface PairingAttemptRunInput<Paired> {
    adopt(paired: Paired): boolean;
    attempt: PairingAttempt;
    cancellationError(): Error;
    isCurrent(): boolean;
    onComplete(): void;
    onPaired(paired: Paired): void;
    pair(signal: AbortSignal): Promise<Paired>;
    rollback(paired: Paired): Promise<void>;
}

/**
 * Keeps pairing ownership separate from React screen lifetimes. A stale owner can abort only its own signal, while a
 * replacement attempt remains current and can adopt its connection.
 */
export const createPairingAttemptRegistry = (): PairingAttemptRegistry => {
    let current: PairingAttempt | undefined;

    const begin = (): PairingAttempt => {
        current?.cancel();
        const controller = new AbortController();
        const attempt: PairingAttempt = {
            signal: controller.signal,
            cancel: () => controller.abort(),
        };
        current = attempt;
        return attempt;
    };

    return {
        begin,
        cancel: (attempt) => {
            attempt.cancel();
            if (current === attempt) current = undefined;
        },
        cancelCurrent: () => {
            if (!current) return;
            current.cancel();
            current = undefined;
        },
        finish: (attempt) => {
            if (current === attempt) current = undefined;
        },
        isCurrent: (attempt) => current === attempt && !attempt.signal.aborted,
    };
};

/**
 * Owns the handoff sequence outside the React provider so stale results cannot look like a successful navigation.
 * Completion publishes connection state and retires ownership synchronously with adoption, before another await can let
 * cancellation or a replacement attempt race that state publication.
 */
export const runPairingAttempt = async <Paired>(
    input: PairingAttemptRunInput<Paired>,
): Promise<void> => {
    const paired = await input.pair(input.attempt.signal);
    if (!input.isCurrent()) {
        await input.rollback(paired);
        throw input.cancellationError();
    }
    input.onPaired(paired);
    if (!input.isCurrent()) {
        await input.rollback(paired);
        throw input.cancellationError();
    }
    if (!input.adopt(paired)) throw input.cancellationError();
    if (!input.isCurrent()) {
        await input.rollback(paired);
        throw input.cancellationError();
    }
    input.onComplete();
};
