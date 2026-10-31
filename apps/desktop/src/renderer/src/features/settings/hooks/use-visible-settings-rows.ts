import { useMemo } from 'react';

import type { AgentProvider } from '@caxri/protocol';

import { useSettingsAdvancedStore } from '../settings-advanced-store';
import { revealedSettingRowIds } from '../settings-focus-requests';
import type { SettingRowDescriptor } from '../settings-registry';
import { filterSettingsRows } from '../settings-search';

/**
 * The rows the Settings list shows for a query: every match while searching, otherwise the basic rows, plus advanced
 * rows when Show advanced settings is on or a focus request is scrolling to one.
 */
export function useVisibleSettingsRows(
    rows: readonly SettingRowDescriptor[],
    query: string,
    requests: {
        trustedDomainsFocusRequestId?: number;
        gitExclusionsFocusRequestId?: number;
        rowFocusRequest?: { rowId: string };
        agentActionsFocusRequest?: { provider: AgentProvider };
        agentExecutableFocusRequest?: { provider: AgentProvider };
    },
): { showAdvanced: boolean; visibleRows: SettingRowDescriptor[] } {
    const showAdvanced = useSettingsAdvancedStore((state) => state.showAdvanced);
    const {
        trustedDomainsFocusRequestId,
        gitExclusionsFocusRequestId,
        rowFocusRequest,
        agentActionsFocusRequest,
        agentExecutableFocusRequest,
    } = requests;
    const revealedRowIds = useMemo(
        () =>
            revealedSettingRowIds({
                trustedDomainsFocusRequestId,
                gitExclusionsFocusRequestId,
                rowFocusRequest,
                agentActionsFocusRequest,
                agentExecutableFocusRequest,
            }),
        [
            trustedDomainsFocusRequestId,
            gitExclusionsFocusRequestId,
            rowFocusRequest,
            agentActionsFocusRequest,
            agentExecutableFocusRequest,
        ],
    );
    const visibleRows = useMemo(
        () => filterSettingsRows(rows, query, { showAdvanced, revealedRowIds }),
        [rows, query, showAdvanced, revealedRowIds],
    );
    return { showAdvanced, visibleRows };
}
