import { createStore } from '../../lib/store';

interface BotHandoverDialogState {
    /**
     * The open hand-over picker and the Sessions it starts with selected, carried as a bumped revision so opening it
     * again from another Session's menu re-seeds the selection instead of keeping the previous one.
     */
    request?: { id: number; sessionIds: readonly string[] };
}

export const useBotHandoverStore = createStore<BotHandoverDialogState>('bot-handover', () => ({}));

export function openBotHandover(sessionIds: readonly string[] = []): void {
    useBotHandoverStore.setState((state) => ({
        request: { id: (state.request?.id ?? 0) + 1, sessionIds },
    }));
}

export function closeBotHandover(): void {
    useBotHandoverStore.setState({ request: undefined });
}
