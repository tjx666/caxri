import type { MouseEvent } from 'react';
import { useRef } from 'react';

import { useContextMenu } from '../../../hooks/use-context-menu';
import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { tryCommand } from '../../../stores/toasts';
import type { DelimitedTable } from '../csv-table';
import type { TableCellPosition, TableSelection } from '../csv-table-selection';
import { serializeTsv, tableSelectionText } from '../csv-table-selection';

async function copyTableText(text: string, t: Translate): Promise<void> {
    await tryCommand(t('preview.table.copyFailed'), () => navigator.clipboard.writeText(text));
}

/**
 * Copying from the table: Cmd+C on the selection, and the cell context menu that copies the selection, the cell, or its
 * row as TSV. A failed clipboard write reports itself through `tryCommand`.
 */
export function useCsvTableClipboard({
    rowOrder,
    selection,
    table,
}: {
    rowOrder: readonly number[];
    selection: TableSelection | undefined;
    table: DelimitedTable;
}) {
    const { t } = useTranslation();
    const contextCell = useRef<TableCellPosition>(undefined);
    const openMenu = useContextMenu(() => {
        const cell = contextCell.current;
        const row = cell && table.rows[rowOrder[cell.row]];
        if (!cell || !row) return [];
        return [
            selection && {
                label: t('preview.table.copy'),
                shortcut: 'cmd+c',
                onSelect: () =>
                    copyTableText(tableSelectionText(table.rows, rowOrder, selection), t),
            },
            {
                label: t('preview.table.copyCell'),
                onSelect: () => copyTableText(row[cell.column] ?? '', t),
            },
            {
                label: t('preview.table.copyRow'),
                onSelect: () => copyTableText(serializeTsv([row]), t),
            },
        ];
    });
    /**
     * Opens the context menu for the cell the event happened in.
     */
    const openCellMenu = (event: MouseEvent, cell: TableCellPosition) => {
        contextCell.current = cell;
        openMenu(event);
    };
    const copySelection = (selected: TableSelection) =>
        copyTableText(tableSelectionText(table.rows, rowOrder, selected), t);
    return { copySelection, openCellMenu };
}
