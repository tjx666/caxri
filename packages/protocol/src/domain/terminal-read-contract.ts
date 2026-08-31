import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import {
    identifierSchema,
    terminalPreviewSchema,
    terminalResourceUsageSchema,
    terminalSnapshotSchema,
} from './domain.js';

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
} as const satisfies Record<string, MethodSpec>;
