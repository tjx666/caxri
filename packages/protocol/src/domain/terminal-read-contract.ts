import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './identifiers.js';
import { terminalPreviewSchema } from './terminal-preview.js';
import { terminalSnapshotSchema } from './terminal-record.js';
import {
    ptyUsageSchema,
    terminalProcessEntrySchema,
    terminalResourceUsageSchema,
} from './terminal-resources.js';

const serverRead = commandPolicy('server', 'read');

export const terminalReadMethods = {
    'terminal.snapshot': {
        ...serverRead,
        params: z.object({ terminalId: identifierSchema }),
        result: terminalSnapshotSchema.nullable(),
    },
    'terminal.preview': {
        ...commandPolicy('server', 'read', ['terminals.preview']),
        params: z.strictObject({ terminalId: identifierSchema }),
        result: terminalPreviewSchema,
    },
    /**
     * Live work in the whole app or one Session, by kind: PTY Terminals (a shell or an Agent CLI) and Chats (the
     * provider process behind an Agent Chat). The window-close and deletion confirmations name each kind, so the user
     * can tell a plain shell from an Agent still working; callers that only need "anything running" add them up.
     */
    'terminal.runningCount': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema.optional() }).default({}),
        result: z.strictObject({
            terminals: z.number().int().nonnegative(),
            chats: z.number().int().nonnegative(),
        }),
    },
    'terminal.resources': {
        ...serverRead,
        params: z.object({ terminalId: identifierSchema }),
        result: terminalResourceUsageSchema.nullable(),
    },
    /**
     * Every running Terminal's PTY root PID with its Session, so a process inspector can group OS processes by the
     * Session that owns them.
     */
    'terminal.processes': {
        ...serverRead,
        params: z.object({}).default({}),
        result: z.object({ terminals: z.array(terminalProcessEntrySchema).max(1_024) }),
    },
    /**
     * The machine's PTY limit, the slots in use, and which processes hold them; `null` where the platform has no
     * readable PTY limit.
     */
    'terminal.ptyUsage': {
        ...serverRead,
        params: z.object({}).default({}),
        result: z.object({ usage: ptyUsageSchema.nullable() }),
    },
} as const satisfies Record<string, MethodSpec>;
