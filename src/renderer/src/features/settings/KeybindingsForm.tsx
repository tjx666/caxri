import { AlertTriangle, Pencil, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { commandDefinitions } from '@shared/commands';
import { findKeybindingConflicts } from '@shared/configuration';
import { normalizeShortcut } from '@shared/shortcuts';
import type { Keybinding } from '@shared/types';

import { ShortcutBadge } from '../../components/ShortcutBadge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { keyboardEventShortcut } from '../../lib/keybindings';
import { buildKeybindingRows, filterKeybindingRows, type KeybindingRow } from './keybinding-editor';

interface KeybindingsFormProps {
    keybindings: Keybinding[];
    onAdd: (command: string, key: string) => void;
    onChange: (index: number, key: string) => void;
    onRemove: (index: number) => void;
}

interface RecordingState {
    pending?: string;
    rowId: string;
}

const titleByCommand = new Map(commandDefinitions.map((command) => [command.id, command.title]));
const modifierKeys = new Set(['Alt', 'Control', 'Meta', 'Shift']);

/** Searchable, keyboard-operable command list backed by the lossless JSONC draft. */
export function KeybindingsForm({ keybindings, onAdd, onChange, onRemove }: KeybindingsFormProps) {
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

    const restoreFocus = (command: string): void => {
        setFocusRequest((current) => ({ command, id: (current?.id ?? 0) + 1 }));
    };

    const commitRecording = (row: KeybindingRow): void => {
        const pending = recording?.pending;
        if (!pending) return;
        if (row.bindingIndex === undefined) onAdd(row.command, pending);
        else onChange(row.bindingIndex, pending);
        setRecording(undefined);
        restoreFocus(row.command);
    };

    const handleRecordingKey = (
        event: KeyboardEvent<HTMLButtonElement>,
        row: KeybindingRow,
    ): void => {
        if (recording?.rowId !== row.id) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
            setRecording(undefined);
            return;
        }
        if (event.key === 'Enter') {
            commitRecording(row);
            return;
        }
        if (modifierKeys.has(event.key)) return;
        setRecording({ rowId: row.id, pending: keyboardEventShortcut(event.nativeEvent) });
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
                <label className="relative block">
                    <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
                        size={14}
                    />
                    <Input
                        ref={searchRef}
                        aria-label="Search keyboard shortcuts"
                        className="bg-background pl-8"
                        placeholder="Search commands or shortcuts"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>
                <p className="mt-2 text-[11px] text-muted">
                    {visibleRows.length} of {rows.length} commands and bindings
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
                            aria-invalid={conflict ? true : undefined}
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
                                variant="secondary"
                                onClick={() => setRecording({ rowId: row.id })}
                                onKeyDown={(event) => handleRecordingKey(event, row)}
                            >
                                {isRecording ? (
                                    recording.pending ? (
                                        <ShortcutBadge shortcut={recording.pending} />
                                    ) : (
                                        'Press shortcut'
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
                    <p className="p-6 text-center text-muted">No keyboard shortcuts found.</p>
                )}
            </ul>
        </div>
    );
}
