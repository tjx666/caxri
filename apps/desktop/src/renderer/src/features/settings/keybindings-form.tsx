import type { KeyboardEvent } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Keybinding } from '@caxri/protocol';
import { findKeybindingConflicts } from '@caxri/protocol';
import { Search, X } from 'lucide-react';

import { Input, InputGroup } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { isModifierKey, keyboardEventShortcut } from '../../lib/keybindings';
import type { KeybindingRow, RecordingState } from './keybinding-editor';
import {
    buildKeybindingRows,
    captureRecordingKey,
    clearRecordingKey,
    commitOnBlur,
    commitOnEnter,
    filterKeybindingRows,
    groupKeybindingRows,
    isFocusNavigationKey,
    startRecording,
} from './keybinding-editor';
import { KeybindingRowItem } from './keybinding-row-item';

interface KeybindingsFormProperties {
    /**
     * Bumped by the `settings.openKeybindings` command to focus the search field on open, mirroring
     * `TrustedDomainsForm`'s `focusRequestId`.
     */
    focusRequestId?: number;
    keybindings: Keybinding[];
    onAdd: (command: string, key: string) => void;
    onChange: (index: number, key: string) => void;
    onRemove: (index: number) => void;
}

/**
 * Clear-search affordance shared with `ProjectSearch`'s `searchOptionClassName`.
 */
const clearSearchButtonClassName =
    'grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-muted cursor-pointer hover:bg-elevated hover:text-foreground';

/**
 * Searchable, keyboard-operable command list backed by the lossless JSONC draft.
 */
export function KeybindingsForm({
    focusRequestId,
    keybindings,
    onAdd,
    onChange,
    onRemove,
}: KeybindingsFormProperties) {
    const [query, setQuery] = useState('');
    const [recording, setRecording] = useState<RecordingState>();
    const [focusRequest, setFocusRequest] = useState<{ command: string; id: number }>();
    const rootReference = useRef<HTMLDivElement>(null);
    const searchReference = useRef<HTMLInputElement>(null);
    const rows = useMemo(() => buildKeybindingRows(keybindings), [keybindings]);
    const visibleRows = useMemo(() => filterKeybindingRows(rows, query), [query, rows]);
    const groups = useMemo(() => groupKeybindingRows(visibleRows), [visibleRows]);
    const conflictsByKey = useMemo(
        () =>
            new Map(
                findKeybindingConflicts(keybindings).map((conflict) => [conflict.key, conflict]),
            ),
        [keybindings],
    );

    useLayoutEffect(() => {
        if (!focusRequest) return;
        const target = [
            ...(rootReference.current?.querySelectorAll<HTMLButtonElement>(
                '[data-keybinding-command]',
            ) ?? []),
        ].find((button) => button.dataset.keybindingCommand === focusRequest.command);
        (target ?? searchReference.current)?.focus();
    }, [focusRequest, visibleRows]);

    useEffect(() => {
        if (!focusRequestId) return;
        searchReference.current?.focus();
    }, [focusRequestId]);

    const restoreFocus = (command: string): void => {
        setFocusRequest((current) => ({ command, id: (current?.id ?? 0) + 1 }));
    };

    const startRecordingRow = (row: KeybindingRow): void => {
        setRecording(startRecording(row.id));
    };

    const commitPending = (row: KeybindingRow, key: string): void => {
        if (row.bindingIndex === undefined) onAdd(row.command, key);
        else onChange(row.bindingIndex, key);
    };

    const handleRecordingKey = (
        event: KeyboardEvent<HTMLButtonElement>,
        row: KeybindingRow,
    ): void => {
        if (recording?.rowId !== row.id) return;
        if (isFocusNavigationKey(event)) {
            // Let Tab/Shift+Tab pass through un-captured so focus keeps moving normally;
            // recording just cancels instead of trapping the key.
            setRecording(undefined);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
            setRecording(undefined);
            return;
        }
        if (event.key === 'Enter') {
            const resolution = commitOnEnter(recording);
            if (!resolution) return; // nothing captured yet: stay in recording mode
            if (resolution.commit) commitPending(row, resolution.commit);
            setRecording(resolution.next);
            restoreFocus(row.command);
            return;
        }
        /**
         * Capture appends chords, so an unmodified Backspace is the way to discard a mistyped one and retype it. A
         * modified Backspace stays recordable, which is what `Cmd+Backspace`-style bindings need.
         */
        if (
            event.key === 'Backspace' &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
        ) {
            setRecording(clearRecordingKey(recording));
            return;
        }
        if (isModifierKey(event.key)) return;
        setRecording(captureRecordingKey(recording, keyboardEventShortcut(event.nativeEvent)));
    };

    const handleRecordingBlur = (row: KeybindingRow): void => {
        if (recording?.rowId !== row.id) return;
        // A captured-but-uncommitted chord must never be silently discarded on blur: commit it
        // exactly like Enter would. Only a blur before any key was captured has nothing to lose,
        // so it cancels recording the same way Escape does.
        const resolution = commitOnBlur(recording);
        if (resolution.commit) commitPending(row, resolution.commit);
        setRecording(resolution.next);
    };

    const resetRow = (row: KeybindingRow): void => {
        if (!row.defaultKey) return;
        if (row.bindingIndex === undefined) onAdd(row.command, row.defaultKey);
        else onChange(row.bindingIndex, row.defaultKey);
        setRecording(undefined);
        restoreFocus(row.command);
    };

    const removeRow = (row: KeybindingRow): void => {
        if (row.bindingIndex === undefined) return;
        onRemove(row.bindingIndex);
        setRecording(undefined);
        restoreFocus(row.command);
    };

    return (
        <div
            ref={rootReference}
            className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
        >
            <div className="border-b border-border p-3">
                <InputGroup appearance="workbench" size="dense">
                    <Search aria-hidden="true" className="shrink-0 text-muted" size={14} />
                    <Input
                        ref={searchReference}
                        appearance="embedded"
                        aria-label="Search keyboard shortcuts"
                        placeholder="Search commands or shortcuts"
                        size="dense"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    {query && (
                        <Tooltip content="Clear Search">
                            <button
                                type="button"
                                className={clearSearchButtonClassName}
                                aria-label="Clear keyboard shortcut search"
                                onClick={() => setQuery('')}
                            >
                                <X size={13} />
                            </button>
                        </Tooltip>
                    )}
                </InputGroup>
                <p className="mt-2 text-[11px] text-muted">
                    {visibleRows.length} of {rows.length} shortcuts
                </p>
            </div>
            <div className="structured-editor m-0 min-h-0 overflow-auto p-2">
                {groups.map((group) => (
                    <section key={group.category} className="mb-3 last:mb-0">
                        <h3 className="mb-1 truncate px-3 text-[10px] font-medium tracking-wide text-muted uppercase">
                            {group.category}
                        </h3>
                        <ul className="m-0 list-none p-0">
                            {group.rows.map((row) => (
                                <KeybindingRowItem
                                    key={row.id}
                                    conflictsByKey={conflictsByKey}
                                    recording={recording}
                                    row={row}
                                    onRecordingBlur={handleRecordingBlur}
                                    onRecordingKey={handleRecordingKey}
                                    onRemove={removeRow}
                                    onReset={resetRow}
                                    onStartRecording={startRecordingRow}
                                />
                            ))}
                        </ul>
                    </section>
                ))}
                {visibleRows.length === 0 && (
                    <div className="flex flex-col items-center gap-2 p-6 text-center text-muted">
                        <p>No keyboard shortcuts found.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
