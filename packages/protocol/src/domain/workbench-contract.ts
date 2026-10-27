import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { sessionRecordSchema, workbenchRootOptionSchema } from './domain.js';
import { identifierSchema, pathSchema } from './identifiers.js';
import { windowPresenceInternalMethods } from './window-presence-contract.js';

const canceled = z.object({ canceled: z.literal(true) });

/**
 * Public Session commands for selecting or authorizing the Files/Editor/Git root.
 */
export const workbenchMethods = {
    'session.workbenchRoots': {
        ...commandPolicy('server', 'read'),
        params: z.object({ sessionId: identifierSchema }),
        result: z.array(workbenchRootOptionSchema).max(1_024),
    },
    'session.selectWorkbenchRoot': {
        ...commandPolicy('server', 'write'),
        params: z.object({ sessionId: identifierSchema, projectId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.authorizeWorkbenchRoot': {
        ...commandPolicy('desktop', 'write'),
        params: z.object({ sessionId: identifierSchema, worktreeId: identifierSchema }),
        result: z.union([canceled, sessionRecordSchema]),
    },
    /**
     * Drops the stored editor tabs for a trashed path from one Workbench Root, including the Sessions that are parked
     * on another root and therefore hold that root's layout only on the Server (issue #909).
     */
    'session.workbenchRoot.forgetEditorPath': {
        ...commandPolicy('server', 'write'),
        params: z.object({
            sessionId: identifierSchema,
            workbenchRootProjectId: identifierSchema,
            path: pathSchema,
        }),
        result: z.null(),
    },
    'session.dismissWorkbenchCandidate': {
        ...commandPolicy('server', 'write'),
        params: z.object({ sessionId: identifierSchema, candidateId: identifierSchema }),
        result: z.null(),
    },
    'session.continueInWorktree': {
        ...commandPolicy('desktop', 'write'),
        params: z.object({ sessionId: identifierSchema, candidateId: identifierSchema }),
        result: z.union([canceled, sessionRecordSchema]),
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Main-only authority handoff; Renderer commands cannot submit a path to authorize a candidate.
 */
export const workbenchInternalMethods = {
    ...windowPresenceInternalMethods,
    'session.workbenchRoot.resolve': {
        ...commandPolicy('server', 'read'),
        params: z.object({ sessionId: identifierSchema, worktreeId: identifierSchema }),
        result: pathSchema,
    },
    'session.workbenchCandidate.claim': {
        ...commandPolicy('server', 'write'),
        params: z.object({ sessionId: identifierSchema, candidateId: identifierSchema }),
        result: z.object({
            candidateId: identifierSchema,
            rootPath: pathSchema,
            projectId: identifierSchema.optional(),
        }),
    },
    'session.workbenchCandidate.authorize': {
        ...commandPolicy('server', 'write'),
        params: z.object({
            sessionId: identifierSchema,
            candidateId: identifierSchema,
            rootPath: pathSchema,
        }),
        result: sessionRecordSchema,
    },
    'session.workbenchCandidate.cancel': {
        ...commandPolicy('server', 'write'),
        params: z.object({ sessionId: identifierSchema, candidateId: identifierSchema }),
        result: z.null(),
    },
    'session.workbenchRoot.authorizeSelection': {
        ...commandPolicy('server', 'write'),
        params: z.object({
            sessionId: identifierSchema,
            rootPath: pathSchema,
            worktreeId: identifierSchema,
        }),
        result: sessionRecordSchema,
    },
    'session.validateWorkbenchRoots': {
        ...commandPolicy('server', 'write'),
        params: z.object({ sessionId: identifierSchema.optional() }).default({}),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;
