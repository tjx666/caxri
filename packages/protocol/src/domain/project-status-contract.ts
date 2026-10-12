import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './domain.js';
import {
    projectStatusLinearIssueSchema,
    projectStatusOverviewSchema,
    projectStatusSummarySchema,
} from './project-status.js';

const serverRead = commandPolicy('server', 'read');

export const projectStatusMethods = {
    'projectStatus.summary': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            /**
             * Unique token makes an explicit UI refresh bypass the settled cache exactly once.
             */
            refreshToken: identifierSchema.optional(),
        }),
        result: projectStatusSummarySchema,
    },
    'projectStatus.overview': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema }),
        result: projectStatusOverviewSchema,
    },
    /**
     * One Linear issue's title, state, and description opening for a link's hover card, read through the shared Linear
     * store. `null` when the CLI is missing, the workspace has no stored credential, or the issue does not exist: a
     * hover never surfaces an error the user did not ask for.
     */
    'projectStatus.linearIssue': {
        ...serverRead,
        params: z.object({
            identifier: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/u),
            /**
             * The workspace slug from the issue's `linear.app/<workspace>/issue/...` URL.
             */
            workspace: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u),
        }),
        result: projectStatusLinearIssueSchema.nullable(),
    },
} as const satisfies Record<string, MethodSpec>;
