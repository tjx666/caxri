import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema, terminalSnapshotSchema } from './domain.js';
import { terminalPreviewSchema } from './terminal-preview.js';
import { terminalProcessEntrySchema, terminalResourceUsageSchema } from './terminal-resources.js';

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
    'terminal.runningCount': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema.optional() }).default({}),
        result: z.number(),
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
} as const satisfies Record<string, MethodSpec>;
