import type { CSSProperties } from 'react';

import { clamp } from 'es-toolkit';
import { z } from 'zod';

export type ProcessColumnKey = 'cpu' | 'memory' | 'name' | 'pid';

export interface ProcessSort {
    column: ProcessColumnKey;
    /**
     * Spelled as the `aria-sort` token so a header can forward it straight to the attribute.
     */
    direction: 'ascending' | 'descending';
}

export interface ProcessColumnDefinition {
    /**
     * Numeric columns answer "who is burning CPU / holding memory", so their first click sorts descending; a text
     * column reads alphabetically and sorts ascending first.
     */
    isNumeric: boolean;
    key: ProcessColumnKey;
    label: string;
    minWidth: number;
    /**
     * Width used before the container has been measured and after a reset. `name` additionally auto-fits the remaining
     * row width until the user drags it; see {@link resolveProcessColumnWidths}.
     */
    width: number;
}

export const PROCESS_COLUMNS: readonly ProcessColumnDefinition[] = [
    { isNumeric: false, key: 'name', label: 'Name', minWidth: 160, width: 420 },
    { isNumeric: true, key: 'cpu', label: 'CPU', minWidth: 64, width: 96 },
    { isNumeric: true, key: 'memory', label: 'Memory', minWidth: 80, width: 110 },
    { isNumeric: true, key: 'pid', label: 'PID', minWidth: 56, width: 90 },
];

/**
 * Bounds a dragged column so a runaway gesture (or a corrupt persisted value) cannot push the remaining columns off
 * screen behind an effectively infinite horizontal scroll.
 */
export const PROCESS_COLUMN_MAX_WIDTH = 1_600;
export const PROCESS_COLUMN_RESIZE_STEP = 16;
/**
 * V2 since the grouped layout: the v1 default sorted by PID, which says nothing once rows are Sessions and Terminals.
 */
export const PROCESS_TABLE_STATE_STORAGE_KEY = 'caxri.process-explorer.table.v2';
/**
 * Heaviest first: the window is opened to find what is using the machine.
 */
export const DEFAULT_PROCESS_SORT: ProcessSort = { column: 'cpu', direction: 'descending' };

/**
 * A column absent from this map has never been dragged: it renders at its definition width, and `name` auto-fits.
 */
export type ProcessColumnWidths = Partial<Record<ProcessColumnKey, number>>;

export interface ProcessTableState {
    sort: ProcessSort;
    widths: ProcessColumnWidths;
}

const columnsByKey = new Map(PROCESS_COLUMNS.map((column) => [column.key, column] as const));

function columnDefinition(key: ProcessColumnKey): ProcessColumnDefinition {
    return columnsByKey.get(key)!;
}

export function clampProcessColumnWidth(key: ProcessColumnKey, width: number): number {
    return clamp(Math.round(width), columnDefinition(key).minWidth, PROCESS_COLUMN_MAX_WIDTH);
}

/**
 * Turns the persisted widths into the pixel width of every column. `containerWidth` is the measured width of the
 * scrolling grid; pass `0` before the first measurement to fall back to the definition widths.
 *
 * `name` is the only column that stretches: while the user has never dragged it, it absorbs whatever the numeric
 * columns leave over, so the table still ends flush with the right edge at any window size. Dragging it pins a width,
 * after which the leftover space becomes trailing whitespace (Finder's list view behavior) instead of inflating `PID`.
 */
export function resolveProcessColumnWidths(
    widths: ProcessColumnWidths,
    containerWidth: number,
): Record<ProcessColumnKey, number> {
    const resolved = Object.fromEntries(
        PROCESS_COLUMNS.map((column) => {
            const stored = widths[column.key];
            return [
                column.key,
                stored === undefined ? column.width : clampProcessColumnWidth(column.key, stored),
            ];
        }),
    ) as Record<ProcessColumnKey, number>;
    if (widths.name !== undefined || containerWidth <= 0) return resolved;
    return {
        ...resolved,
        name: clampProcessColumnWidth(
            'name',
            containerWidth - resolved.cpu - resolved.memory - resolved.pid,
        ),
    };
}

export function processColumnWidthVariable(key: ProcessColumnKey): string {
    return `--process-column-${key}`;
}

/**
 * Header and body rows share one template so a live drag only has to rewrite the custom properties below — no row ever
 * re-renders mid-gesture. The trailing `minmax(0,1fr)` swallows the space left when the pinned columns are narrower
 * than the window.
 */
export const PROCESS_GRID_TEMPLATE =
    'var(--process-column-name) var(--process-column-cpu) var(--process-column-memory) var(--process-column-pid) minmax(0,1fr)';

/**
 * Keeps the grid at least as wide as its four columns, so widening one scrolls the table horizontally (header included)
 * instead of squeezing its siblings.
 */
export const PROCESS_GRID_MIN_WIDTH =
    'calc(var(--process-column-name) + var(--process-column-cpu) + var(--process-column-memory) + var(--process-column-pid))';

export function processColumnWidthStyle(resolved: Record<ProcessColumnKey, number>): CSSProperties {
    return Object.fromEntries(
        PROCESS_COLUMNS.map((column) => [
            processColumnWidthVariable(column.key),
            `${resolved[column.key]}px`,
        ]),
    );
}

export function nextProcessSort(current: ProcessSort, column: ProcessColumnKey): ProcessSort {
    if (current.column === column)
        return {
            column,
            direction: current.direction === 'ascending' ? 'descending' : 'ascending',
        };
    return { column, direction: columnDefinition(column).isNumeric ? 'descending' : 'ascending' };
}

const processColumnKeySchema = z.enum(['cpu', 'memory', 'name', 'pid']);

const processTableStateSchema = z.object({
    sort: z
        .object({
            column: processColumnKeySchema,
            direction: z.enum(['ascending', 'descending']),
        })
        .optional(),
    widths: z
        .object({
            cpu: z.number().positive(),
            memory: z.number().positive(),
            name: z.number().positive(),
            pid: z.number().positive(),
        })
        .partial()
        .optional(),
});

function defaultProcessTableState(): ProcessTableState {
    return { sort: DEFAULT_PROCESS_SORT, widths: {} };
}

/**
 * Reads the persisted table state, falling back to the defaults for anything malformed. A diagnostics window must open
 * even when its stored layout was written by an older build or hand-edited into nonsense.
 */
export function parseProcessTableState(raw: string | null): ProcessTableState {
    if (!raw) return defaultProcessTableState();
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return defaultProcessTableState();
    }
    const parsed = processTableStateSchema.safeParse(json);
    if (!parsed.success) return defaultProcessTableState();
    const widths: ProcessColumnWidths = {};
    for (const column of PROCESS_COLUMNS) {
        const stored = parsed.data.widths?.[column.key];
        if (stored !== undefined) widths[column.key] = clampProcessColumnWidth(column.key, stored);
    }
    return { sort: parsed.data.sort ?? DEFAULT_PROCESS_SORT, widths };
}

export function serializeProcessTableState(state: ProcessTableState): string {
    return JSON.stringify(state);
}
