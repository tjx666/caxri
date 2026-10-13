import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './identifiers.js';
import {
    terminalCommitLinkResolutionSchema,
    terminalReferenceContextSchema,
    terminalReferencePreviewRequestSchema,
    terminalReferencePreviewSchema,
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
    /**
     * Metadata for the hover card over a Terminal reference. Read-only by construction: it can answer what a commit or
     * an issue says and nothing else, so a hover can never mutate anything the user did not ask to change.
     */
    'terminal.reference.preview': {
        ...serverRead,
        params: z.object({
            terminalId: identifierSchema,
            reference: terminalReferencePreviewRequestSchema,
        }),
        result: terminalReferencePreviewSchema,
    },
} as const satisfies Record<string, MethodSpec>;
