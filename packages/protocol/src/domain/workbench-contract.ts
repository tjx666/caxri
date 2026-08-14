import { z } from 'zod';

import {
    identifierSchema,
    pathSchema,
    sessionRecordSchema,
    workbenchRootOptionSchema,
} from './domain.js';
import { commandPolicy, type MethodSpec } from '../transport/method-spec.js';

const canceled = z.object({ canceled: z.literal(true) });

/** Public Session commands for selecting or authorizing the Files/Editor/Git root. */
export const workbenchMethods = {
    'session.workbenchRoots': {
        ...commandPolicy('host', 'read'),
        params: z.object({ sessionId: identifierSchema }),
        result: z.array(workbenchRootOptionSchema).max(1_024),
    },
    'session.selectWorkbenchRoot': {
        ...commandPolicy('host', 'write'),
        params: z.object({ sessionId: identifierSchema, projectId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.authorizeWorkbenchRoot': {
        ...commandPolicy('desktop', 'write'),
        params: z.object({ sessionId: identifierSchema }),
        result: z.union([canceled, sessionRecordSchema]),
    },
    'session.dismissWorkbenchCandidate': {
        ...commandPolicy('host', 'write'),
        params: z.object({ sessionId: identifierSchema, candidateId: identifierSchema }),
        result: z.null(),
    },
    'session.continueInWorktree': {
        ...commandPolicy('desktop', 'write'),
        params: z.object({ sessionId: identifierSchema, candidateId: identifierSchema }),
        result: z.union([canceled, sessionRecordSchema]),
    },
} as const satisfies Record<string, MethodSpec>;

/** Main-only authority handoff; paths never enter the public Renderer contract. */
export const workbenchInternalMethods = {
    'session.workbenchCandidate.claim': {
        ...commandPolicy('host', 'write'),
        params: z.object({ sessionId: identifierSchema, candidateId: identifierSchema }),
        result: z.object({
            candidateId: identifierSchema,
            rootPath: pathSchema,
            projectId: identifierSchema.optional(),
        }),
    },
    'session.workbenchCandidate.authorize': {
        ...commandPolicy('host', 'write'),
        params: z.object({
            sessionId: identifierSchema,
            candidateId: identifierSchema,
            rootPath: pathSchema,
        }),
        result: sessionRecordSchema,
    },
    'session.workbenchCandidate.cancel': {
        ...commandPolicy('host', 'write'),
        params: z.object({ sessionId: identifierSchema, candidateId: identifierSchema }),
        result: z.null(),
    },
    'session.workbenchRoot.authorizeSelection': {
        ...commandPolicy('host', 'write'),
        params: z.object({ sessionId: identifierSchema, rootPath: pathSchema }),
        result: sessionRecordSchema,
    },
    'session.validateWorkbenchRoots': {
        ...commandPolicy('host', 'write'),
        params: z.object({ sessionId: identifierSchema.optional() }).default({}),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;
