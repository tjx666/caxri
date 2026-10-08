import type { ProjectStatusErrorLogs } from '@caxri/protocol';

import { createStore } from '../../../../lib/store';

interface LogPrefillState {
    /**
     * A filter waiting to be applied, or `undefined` once the viewer has taken it.
     *
     * It is a handoff rather than a setting: the viewer consumes it and clears it, so a prefill survives the panel
     * being closed at the moment it was requested, and reopening the panel later by hand still opens on whatever the
     * user last left there. A second request simply replaces an untaken first: the newer one is the one the user just
     * clicked.
     */
    pending: ProjectStatusErrorLogs | undefined;
    consumeLogPrefill(): void;
    requestLogPrefill(prefill: ProjectStatusErrorLogs): void;
}

/**
 * The one channel by which something outside the log panel asks it to open on a particular query.
 *
 * A store rather than a command argument because `panel.showLogs` only activates the view container: the Renderer's
 * command definitions take no parameters, and the panel that has to receive the filter is mounted by that activation
 * rather than reachable from the caller.
 */
export const useLogPrefillStore = createStore<LogPrefillState>('logPrefill', (set) => ({
    pending: undefined,
    consumeLogPrefill: () => set({ pending: undefined }),
    requestLogPrefill: (prefill) => set({ pending: prefill }),
}));
