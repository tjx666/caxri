import type { KeyboardEvent } from 'react';

import type { KeybindingConflict } from '@caxri/protocol';
import { commandDefinitions, formatShortcut, normalizeShortcut } from '@caxri/protocol';
import { AlertTriangle, Pencil, RotateCcw, Trash2 } from 'lucide-react';

import { ShortcutBadge } from '../../components/shortcut-badge';
import { Button } from '../../components/ui/button';
import type { KeybindingRow, RecordingState } from './keybinding-editor';

const titleByCommand = new Map<string, string>(
    commandDefinitions.map((command) => [command.id, command.title]),
);

interface KeybindingRowItemProperties {
    conflictsByKey: Map<string, KeybindingConflict>;
    onRecordingBlur: (row: KeybindingRow) => void;
    onRecordingKey: (event: KeyboardEvent<HTMLButtonElement>, row: KeybindingRow) => void;
    onRemove: (row: KeybindingRow) => void;
    onReset: (row: KeybindingRow) => void;
    onStartRecording: (row: KeybindingRow) => void;
    recording: RecordingState | undefined;
    row: KeybindingRow;
}

/**
 * One row of `KeybindingsForm`'s command list: the command title, an optional conflict notice, the shortcut recorder
 * button, and its reset/remove actions. Split out of `KeybindingsForm` so the row's list body stays a plain `.map` over
 * a focused renderer (react-doctor/no-giant-component).
 */
export function KeybindingRowItem({
    conflictsByKey,
    onRecordingBlur,
    onRecordingKey,
    onRemove,
    onReset,
    onStartRecording,
    recording,
    row,
}: KeybindingRowItemProperties) {
    const conflict = row.key ? conflictsByKey.get(normalizeShortcut(row.key)) : undefined;
    const conflictId = conflict ? `keybinding-conflict-${row.id}` : undefined;
    const isRecording = recording?.rowId === row.id;
    return (
        <li
            aria-describedby={conflictId}
            className="group grid min-h-8 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded border border-transparent px-3 py-1 focus-within:border-border focus-within:bg-elevated hover:border-border hover:bg-elevated"
        >
            <div className="min-w-0">
                {/* The command id is one Tab lookup a script author needs and every other
                    reader does not, so it stays out of the row's own text (issue
                    caxri#1289: "unbgrouped Keybindings list" also flagged this as
                    clutter); the title's native tooltip surfaces it on hover, and the
                    `sr-only` span keeps it in the accessible name for anyone else. */}
                <strong className="block truncate text-[12px] text-foreground" title={row.command}>
                    {row.title}
                    <span className="sr-only">: {row.command}</span>
                </strong>
                {conflict && (
                    <p
                        id={conflictId}
                        role="status"
                        aria-live="polite"
                        className="flex items-center gap-1 text-[10px] text-danger"
                    >
                        <AlertTriangle aria-hidden="true" size={11} />
                        {conflict.reason === 'chordPrefix' ? (
                            // Not "conflicts with": nothing else has to be bound for this
                            // to be dead. The chord opens a sequence, so dispatch waits
                            // for a second key instead of ever running this command.
                            <>Never fires: {formatShortcut(conflict.key)} starts a chord sequence</>
                        ) : (
                            <>
                                Conflicts with{' '}
                                {conflict.commands
                                    .flatMap((command) =>
                                        command === row.command
                                            ? []
                                            : [titleByCommand.get(command) ?? command],
                                    )
                                    .join(', ')}
                            </>
                        )}
                    </p>
                )}
            </div>
            <Button
                aria-label={`${row.key ? 'Edit' : 'Add'} shortcut for ${row.title}`}
                aria-describedby={conflictId}
                className="min-w-36"
                data-keybinding-command={row.command}
                data-keybinding-recording={isRecording || undefined}
                size="sm"
                variant={isRecording && recording.pending ? 'default' : 'secondary'}
                onBlur={() => onRecordingBlur(row)}
                onClick={() => onStartRecording(row)}
                onKeyDown={(event) => onRecordingKey(event, row)}
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
                            {/* Capture appends a second chord into a sequence, so
                                clearing needs its own key and its own hint; otherwise a
                                mistyped first chord looks unrecoverable without leaving
                                recording. */}
                            <span className="text-[10px] text-accent-foreground/80">
                                Enter save · ⌫ clear · Esc cancel
                            </span>
                        </span>
                    ) : (
                        'Press shortcut · Esc to cancel'
                    )
                ) : row.key ? (
                    // Borderless: the Button above is already this chip's chrome, so the
                    // shared `Kbd` chip's own hairline and fill would double the border
                    // the row draws around a bound shortcut (issue caxri#1289).
                    // `ShortcutBadge`'s `keyClassName` passes straight through to `Kbd`'s
                    // own `className`, letting this one call site override the chip
                    // without editing the shared `Kbd`/`ShortcutBadge` components.
                    <ShortcutBadge
                        keyClassName="border-transparent bg-transparent"
                        shortcut={row.key}
                    />
                ) : (
                    <>
                        <Pencil size={12} /> Add Shortcut
                    </>
                )}
            </Button>
            <div className="flex min-w-16 justify-end gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                {row.bindingIndex !== undefined && (
                    <Button
                        aria-label={`Remove shortcut for ${row.title}`}
                        size="icon"
                        variant="ghost"
                        onClick={() => onRemove(row)}
                    >
                        <Trash2 size={13} />
                    </Button>
                )}
                {row.defaultKey && row.key !== row.defaultKey && (
                    <Button
                        aria-label={`Reset shortcut for ${row.title}`}
                        size="icon"
                        variant="ghost"
                        onClick={() => onReset(row)}
                    >
                        <RotateCcw size={13} />
                    </Button>
                )}
            </div>
        </li>
    );
}
