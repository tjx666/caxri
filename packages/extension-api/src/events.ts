export interface DisposableLike {
    dispose(): void;
}

export class Disposable implements DisposableLike {
    static from(...disposables: readonly DisposableLike[]): Disposable {
        return new Disposable(() => {
            for (const disposable of disposables) disposable.dispose();
        });
    }

    private isDisposed = false;

    constructor(private readonly callOnDispose: () => void = () => {}) {}

    dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.callOnDispose();
    }
}

export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: Event<void>;
}

export type Event<T> = (listener: (event: T) => unknown) => Disposable;

export class EventEmitter<T> implements DisposableLike {
    private readonly listeners = new Set<(event: T) => unknown>();
    private isDisposed = false;

    readonly event: Event<T> = (listener) => {
        if (this.isDisposed) return new Disposable();
        this.listeners.add(listener);
        return new Disposable(() => this.listeners.delete(listener));
    };

    fire(event: T): void {
        if (this.isDisposed) return;
        /**
         * Isolates each listener the same way `@caxri/utils`'s `notifyListeners` does, so one throwing subscriber
         * cannot stop delivery to the rest — the most likely place for that to happen is a third-party extension's own
         * listener. This package ships to extension authors and must stay dependency-free, so the isolation is inlined
         * here instead of importing the shared helper. There is no host-side logger reachable from this zero-dependency
         * layer, so a listener failure is swallowed rather than reported (caxri#1441).
         */
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                // Isolated and intentionally unreported; see the JSDoc above.
            }
        }
    }

    dispose(): void {
        this.isDisposed = true;
        this.listeners.clear();
    }
}

export class CancellationTokenSource implements DisposableLike {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    private readonly cancellation = new EventEmitter<void>();
    private isCancelled = false;
    readonly token: CancellationToken;

    constructor() {
        // eslint-disable-next-line unicorn/no-this-assignment, @typescript-eslint/no-this-alias -- The token getter must retain the source identity while exposing a stable public token object.
        const source = this;
        this.token = {
            get isCancellationRequested() {
                return source.isCancelled;
            },
            onCancellationRequested: this.cancellation.event,
        };
    }

    cancel(): void {
        if (this.isCancelled) return;
        this.isCancelled = true;
        this.cancellation.fire();
    }

    dispose(): void {
        this.cancel();
        this.cancellation.dispose();
    }
}
