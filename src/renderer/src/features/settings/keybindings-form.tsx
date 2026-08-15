import { AlertTriangle, Pencil, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { commandDefinitions } from '@shared/commands';
import { findKeybindingConflicts } from '@shared/configuration';
import { normalizeShortcut } from '@shared/shortcuts';
import type { Keybinding } from '@shared/types';

import { ShortcutBadge } from '../../components/shortcut-badge';
import { Button } from '../../components/ui/button';
import { Input, InputGroup } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { keyboardEventShortcut } from '../../lib/keybindings';
import {
    buildKeybindingRows,
    captureRecordingKey,
    commitOnBlur,
    commitOnEnter,
    filterKeybindingRows,
    isFocusNavigationKey,
    isModifierKey,
    startRecording,
    type KeybindingRow,
    type RecordingState,
} from './keybinding-editor';

interface KeybindingsFormProps {
    /** Bumped by the `settings.openKeybindings` command to focus the search field on open,
     * mirroring `TrustedDomainsForm`'s `focusRequestId`. */
    focusRequestId?: number;
    keybindings: Keybinding[];
    onAdd: (command: string, key: string) => void;
    onChange: (index: number, key: string) => void;
    onRemove: (index: number) => void;
}

const titleByCommand = new Map<string, string>(
    commandDefinitions.map((command) => [command.id, command.title]),
);

/** Clear-search affordance shared with `ProjectSearch`'s `searchOptionClassName`. */
const clearSearchButtonClassName =
    'grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-muted cursor-pointer hover:bg-elevated hover:text-foreground';

/** Searchable, keyboard-operable command list backed by the lossless JSONC draft. */
export function KeybindingsForm({
    focusRequestId,
    keybindings,
    onAdd,
    onChange,
    onRemove,
}: KeybindingsFormProps) {
    const [query, setQuery] = useState('');
    const [recording, setRecording] = useState<RecordingState>();
    const [focusRequest, setFocusRequest] = useState<{ command: string; id: number }>();
    const rootRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const rows = useMemo(() => buildKeybindingRows(keybindings), [keybindings]);
    const visibleRows = useMemo(() => filterKeybindingRows(rows, query), [query, rows]);
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
            ...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-keybinding-command]') ??
                []),
        ].find((button) => button.dataset.keybindingCommand === focusRequest.command);
        (target ?? searchRef.current)?.focus();
    }, [focusRequest, visibleRows]);

    useEffect(() => {
        if (!focusRequestId) return;
        searchRef.current?.focus();
    }, [focusRequestId]);

    const restoreFocus = (command: string): void => {
        setFocusRequest((current) => ({ command, id: (current?.id ?? 0) + 1 }));
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
        if (isFocusNavigationKey(event.key)) {
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
            if (!resolution) return; // no chord captured yet: stay in recording mode
            if (resolution.commit) commitPending(row, resolution.commit);
            setRecording(resolution.next);
            restoreFocus(row.command);
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
        <div ref={rootRef} className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
            <div className="border-b border-border p-3">
                <InputGroup appearance="workbench" size="dense">
                    <Search aria-hidden="true" className="shrink-0 text-muted" size={14} />
                    <Input
                        ref={searchRef}
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
            <ul className="structured-editor m-0 min-h-0 list-none overflow-auto p-2">
                {visibleRows.map((row) => {
                    const conflict = row.key
                        ? conflictsByKey.get(normalizeShortcut(row.key))
                        : undefined;
                    const conflictId = conflict ? `keybinding-conflict-${row.id}` : undefined;
                    const isRecording = recording?.rowId === row.id;
                    return (
                        <li
                            key={row.id}
                            aria-describedby={conflictId}
                            className="group mb-1 grid min-h-14 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded border border-transparent px-3 py-2 hover:border-border hover:bg-elevated focus-within:border-border focus-within:bg-elevated"
                        >
                            <div className="min-w-0">
                                <div className="flex min-w-0 items-baseline gap-2">
                                    <strong className="truncate text-[12px] text-foreground">
                                        {row.title}
                                    </strong>
                                    <span className="shrink-0 text-[10px] text-muted">
                                        {row.category}
                                    </span>
                                </div>
                                <code className="block truncate text-[10px] text-muted">
                                    {row.command}
                                </code>
                                {conflict && (
                                    <p
                                        id={conflictId}
                                        role="status"
                                        aria-live="polite"
                                        className="mt-1 flex items-center gap-1 text-[10px] text-danger"
                                    >
                                        <AlertTriangle aria-hidden="true" size={11} />
                                        Conflicts with{' '}
                                        {conflict.commands
                                            .flatMap((command) =>
                                                command === row.command
                                                    ? []
                                                    : [titleByCommand.get(command) ?? command],
                                            )
                                            .join(', ')}
                                    </p>
                                )}
                            </div>
                            <Button
                                aria-label={`${row.key ? 'Edit' : 'Add'} shortcut for ${row.title}`}
                                aria-describedby={conflictId}
                                className="min-w-36"
                                data-keybinding-command={row.command}
                                size="sm"
                                variant={isRecording && recording.pending ? 'default' : 'secondary'}
                                onBlur={() => handleRecordingBlur(row)}
                                onClick={() => setRecording(startRecording(row.id))}
                                onKeyDown={(event) => handleRecordingKey(event, row)}
                            >
                                {isRecording ? (
                                    recording.pending ? (
                                        // Deliberately distinct from a committed binding (the bug
                                        // this closes): accent chrome plus an explicit hint, so an
                                        // uncommitted chord can never be mistaken for a saved one.
                                        <span className="flex flex-col items-center gap-0.5">
                                            <ShortcutBadge
                                                shortcut={recording.pending}
                                                keyClassName="border-accent-foreground/40 bg-transparent text-accent-foreground"
                                            />
                                            <span className="text-[10px] text-accent-foreground/80">
                                                Enter to save · Esc to cancel
                                            </span>
                                        </span>
                                    ) : (
                                        'Press shortcut · Esc to cancel'
                                    )
                                ) : row.key ? (
                                    <ShortcutBadge shortcut={row.key} />
                                ) : (
                                    <>
                                        <Pencil size={12} /> Add Shortcut
                                    </>
                                )}
                            </Button>
                            <div className="flex min-w-16 justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                {row.bindingIndex !== undefined && (
                                    <Button
                                        aria-label={`Remove shortcut for ${row.title}`}
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => removeRow(row)}
                                    >
                                        <Trash2 size={13} />
                                    </Button>
                                )}
                                {row.defaultKey && row.key !== row.defaultKey && (
                                    <Button
                                        aria-label={`Reset shortcut for ${row.title}`}
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => resetRow(row)}
                                    >
                                        <RotateCcw size={13} />
                                    </Button>
                                )}
                            </div>
                        </li>
                    );
                })}
                {visibleRows.length === 0 && (
                    <div className="flex flex-col items-center gap-2 p-6 text-center text-muted">
                        <p>No keyboard shortcuts found.</p>
                    </div>
                )}
            </ul>
        </div>
    );
}
