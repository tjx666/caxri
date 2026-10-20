declare const listeners: Set<(value: number) => void>;
declare const subscriptions: { dispose(): void }[];
declare const handlers: (() => void)[];
declare const removers: (() => void)[];
declare const disposables: { dispose(): void }[];
declare const cleanups: (() => void)[];
declare const executionListeners: (() => void)[];

for (const listener of listeners) listener(1);
for (const listener of listeners) {
    listener?.(2);
}
handlers.forEach((handler) => handler());
for (const subscription of subscriptions) subscription.dispose();
for (const subscription of subscriptions) {
    subscription?.dispose();
}
for (const dispose of executionListeners) dispose();
for (const remove of removers) remove();
disposables.forEach((disposable) => disposable.dispose());
cleanups.forEach((stop) => {
    stop();
});

export {};
