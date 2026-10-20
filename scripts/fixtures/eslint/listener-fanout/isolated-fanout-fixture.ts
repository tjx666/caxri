declare const listeners: Set<(value: number) => void>;
declare const subscriptions: { dispose(): void }[];
declare const items: { close(): void }[];
declare const commands: { decoration?: { dispose(): void }; startMarker: { dispose(): void } }[];
declare const editor: { dispose(): void };
declare function notifyListeners(listeners: Iterable<(value: number) => void>, value: number): void;
declare function disposeAll(disposables: Iterable<{ dispose(): void }>): void;

notifyListeners(listeners, 1);
disposeAll(subscriptions);
editor.dispose();
for (const item of items) item.close();
for (const subscription of subscriptions) {
    try {
        subscription.dispose();
    } catch {}
}
for (const command of commands) {
    command.decoration?.dispose();
    command.startMarker.dispose();
}

export {};
