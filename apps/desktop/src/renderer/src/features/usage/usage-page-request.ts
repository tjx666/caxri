import { usageTabPath } from '@caxri/protocol';

import { createStore } from '../../lib/store';
import { getBootstrap } from '../../stores/selectors';
import { openEditorTab } from '../editor/document-commands';

/**
 * What the opener asked the Usage page to show. `sessionId` narrows the report to one Caxri Session (the status bar's
 * usage chip); its absence asks for the whole report, clearing a Session filter an earlier request left on the page.
 */
interface UsagePageRequest {
    readonly sessionId?: string;
}

interface UsagePageRequestState {
    /**
     * A request waiting to be applied, or `undefined` once the page has taken it. A handoff rather than a setting, like
     * the log panel's prefill: the Usage tab path is one fixed identity with no room for parameters, and the page that
     * has to receive the filter may not be mounted yet when the opener asks.
     */
    pending: UsagePageRequest | undefined;
    consumeUsagePageRequest: () => void;
}

export const useUsagePageRequestStore = createStore<UsagePageRequestState>(
    'usagePageRequest',
    (set) => ({
        pending: undefined,
        consumeUsagePageRequest: () => set({ pending: undefined }),
    }),
);

/**
 * Opens the Usage tab, narrowed to `sessionId` when given and showing every Session otherwise.
 */
export function openUsagePage(sessionId?: string): void {
    useUsagePageRequestStore.setState({ pending: sessionId === undefined ? {} : { sessionId } });
    openEditorTab(usageTabPath());
}

/**
 * The status bar usage chip's click: the Usage page narrowed to the Session that owns `terminalId`, or the whole report
 * when the Terminal is no longer known.
 */
export function openUsagePageForTerminal(terminalId: string): void {
    openUsagePage(
        getBootstrap()?.terminals.find((terminal) => terminal.id === terminalId)?.sessionId,
    );
}
