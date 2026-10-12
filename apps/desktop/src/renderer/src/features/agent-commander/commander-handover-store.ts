import { createStore } from '../../lib/store';

interface CommanderHandoverDialogState {
    /**
     * The open hand-over picker and the Sessions it starts with selected, carried as a bumped revision so opening it
     * again from another Session's menu re-seeds the selection instead of keeping the previous one.
     */
    request?: { id: number; sessionIds: readonly string[] };
}

export const useCommanderHandoverStore = createStore<CommanderHandoverDialogState>(
    'commander-handover',
    () => ({}),
);

export function openCommanderHandover(sessionIds: readonly string[] = []): void {
    useCommanderHandoverStore.setState((state) => ({
        request: { id: (state.request?.id ?? 0) + 1, sessionIds },
    }));
}

export function closeCommanderHandover(): void {
    useCommanderHandoverStore.setState({ request: undefined });
}
