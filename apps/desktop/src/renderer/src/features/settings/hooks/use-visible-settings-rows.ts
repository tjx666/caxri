import { useMemo } from 'react';

import type { AgentProvider } from '@caxri/protocol';

import { useSettingsAdvancedStore } from '../settings-advanced-store';
import { revealedSettingRowIds } from '../settings-focus-requests';
import type { SettingRowDescriptor } from '../settings-registry';
import { countHiddenAdvancedRows, filterSettingsRows } from '../settings-search';
import type { SettingsValueContext } from '../settings-values';
import { isRowModified } from '../settings-values';

/**
 * The rows the Settings list shows for a query: every match while searching, otherwise the basic rows, plus advanced
 * rows when Show advanced settings is on or a focus request is scrolling to one.
 */
export function useVisibleSettingsRows(
    rows: readonly SettingRowDescriptor[],
    query: string,
    valueContext: SettingsValueContext,
    requests: {
        trustedDomainsFocusRequestId?: number;
        gitExclusionsFocusRequestId?: number;
        rowFocusRequest?: { rowId: string };
        agentActionsFocusRequest?: { provider: AgentProvider };
        agentExecutableFocusRequest?: { provider: AgentProvider };
    },
): {
    showAdvanced: boolean;
    visibleRows: SettingRowDescriptor[];
    hiddenAdvancedCount: number;
} {
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
    const { argvConfig, settings } = valueContext;
    const modifiedRowIds = useMemo(
        () =>
            new Set(
                rows
                    .filter(
                        (row) =>
                            row.advanced && isRowModified(row.binding, { argvConfig, settings }),
                    )
                    .map((row) => row.id),
            ),
        [rows, argvConfig, settings],
    );
    const visibleRows = useMemo(
        () => filterSettingsRows(rows, query, { showAdvanced, revealedRowIds, modifiedRowIds }),
        [rows, query, showAdvanced, revealedRowIds, modifiedRowIds],
    );
    const hiddenAdvancedCount = useMemo(
        () =>
            showAdvanced ? 0 : countHiddenAdvancedRows(rows, { revealedRowIds, modifiedRowIds }),
        [rows, showAdvanced, revealedRowIds, modifiedRowIds],
    );
    return { showAdvanced, visibleRows, hiddenAdvancedCount };
}
