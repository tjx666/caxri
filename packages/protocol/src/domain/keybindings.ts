import { z } from 'zod';

import { MAX_SHORTCUT_CHORDS, splitShortcutChords } from '../configuration/shortcuts.js';
import type { CommandId } from './commands.js';
import { MAX_TERMINAL_INPUT_LENGTH } from './terminal-limits.js';

const TERMINAL_SEND_SEQUENCE_COMMAND_ID =
    'workbench.action.terminal.sendSequence' satisfies CommandId;

export const keybindingWhenSchema = z.enum(['terminalFocus']);

export const keybindingSchema = z
    .object({
        key: z.string().min(1).max(100),
        /**
         * Catalog IDs are `CommandId` (see `./commands.js`); unknown values stay visible as custom keybindings.
         */
        command: z.string().min(1).max(200),
        /**
         * Arbitrary JSON arguments are retained verbatim; commands with schema-level requirements validate below.
         */
        args: z.record(z.string(), z.unknown()).optional(),
        when: keybindingWhenSchema.optional(),
    })
    .superRefine((binding, context) => {
        // `cmd+k cmd+s` is one keybinding of two chords. Dispatch tracks a single pending chord, so a longer
        // sequence would silently never fire; reject it at the file boundary instead.
        if (splitShortcutChords(binding.key).length > MAX_SHORTCUT_CHORDS)
            context.addIssue({
                code: 'custom',
                message: `A keybinding may chain at most ${MAX_SHORTCUT_CHORDS} chords, for example "cmd+k cmd+s"`,
                path: ['key'],
            });
        if (binding.command !== TERMINAL_SEND_SEQUENCE_COMMAND_ID) return;
        if (!binding.args || typeof binding.args.text !== 'string') {
            context.addIssue({
                code: 'custom',
                message: 'workbench.action.terminal.sendSequence requires args.text',
                path: ['args', 'text'],
            });
            return;
        }
        if (binding.args.text.length > MAX_TERMINAL_INPUT_LENGTH)
            context.addIssue({
                code: 'too_big',
                maximum: MAX_TERMINAL_INPUT_LENGTH,
                message: `Terminal input must contain at most ${MAX_TERMINAL_INPUT_LENGTH} characters`,
                origin: 'string',
                path: ['args', 'text'],
                type: 'string',
            });
    });

export const keybindingConflictSchema = z.object({
    key: z.string(),
    commands: z.array(z.string()),
    // Why the listed commands cannot all work; `findKeybindingConflicts` defines each value.
    reason: z.enum(['chordPrefix', 'duplicate']),
});

export type Keybinding = z.infer<typeof keybindingSchema>;
export type KeybindingConflict = z.infer<typeof keybindingConflictSchema>;
