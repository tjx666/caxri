import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './domain.js';
import {
    terminalCommitLinkResolutionSchema,
    terminalReferenceContextSchema,
} from './terminal-reference.js';

const serverRead = commandPolicy('server', 'read');

export const terminalReferenceMethods = {
    'terminal.referenceContext': {
        ...serverRead,
        params: z.object({ terminalId: identifierSchema }),
        result: terminalReferenceContextSchema,
    },
    'terminal.commitLink.resolve': {
        ...serverRead,
        params: z.object({
            terminalId: identifierSchema,
            reference: z.string().regex(/^[0-9a-f]{7,40}$/i),
        }),
        result: terminalCommitLinkResolutionSchema,
    },
} as const satisfies Record<string, MethodSpec>;
