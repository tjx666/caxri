import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * One worktree of the Session's repository, as the phone's Files picker shows it. It carries no folder path: the phone
 * names a worktree by its title and branch, and selects it by the Project ID Desktop already authorized.
 */
export interface MobileWorkbenchRoot {
    /**
     * Present only for an authorized worktree; a worktree Desktop has not authorized yet is listed but not selectable.
     */
    projectId?: string;
    title: string;
    branch: string;
    isMain: boolean;
    /**
     * The worktree Files, Changes, and Desktop's editor currently show for this Session.
     */
    isCurrent: boolean;
}

const mobileWorkbenchRootSchema: z.ZodType<MobileWorkbenchRoot> = z.strictObject({
    projectId: identifierSchema.optional(),
    title: z.string().min(1).max(1_024),
    branch: z.string().min(1).max(1_024),
    isMain: z.boolean(),
    isCurrent: z.boolean(),
});

/**
 * `mobile.workbenchRoot.list` as a named type. The method registry's inferred declaration sits at the compiler's
 * serialization limit (TS7056), so new method specs are annotated like `AgentChatReadSpec`.
 *
 * @public
 */
export interface MobileWorkbenchRootListSpec extends ReturnType<
    typeof commandPolicy<'server', 'read'>
> {
    params: z.ZodType<{ sessionId: string }>;
    result: z.ZodType<{ roots: MobileWorkbenchRoot[] }>;
}

/**
 * `mobile.workbenchRoot.select` as a named type, for the same reason as {@link MobileWorkbenchRootListSpec}.
 *
 * @public
 */
export interface MobileWorkbenchRootSelectSpec extends ReturnType<
    typeof commandPolicy<'server', 'write'>
> {
    params: z.ZodType<{ sessionId: string; projectId: string }>;
    result: z.ZodType<null>;
}

const listSpec: MobileWorkbenchRootListSpec = {
    ...commandPolicy('server', 'read', ['sessions.read']),
    params: z.strictObject({ sessionId: identifierSchema }),
    result: z.strictObject({ roots: z.array(mobileWorkbenchRootSchema).max(1_024) }),
};

const selectSpec: MobileWorkbenchRootSelectSpec = {
    ...commandPolicy('server', 'write', ['sessions.write']),
    params: z.strictObject({ sessionId: identifierSchema, projectId: identifierSchema }),
    result: z.null(),
};

/**
 * The Session's Workbench Root: the worktree its Files and Changes show. Listing is open to every role; switching is a
 * `control` command that goes through the same `session.selectWorkbenchRoot` Desktop's status bar picker uses, and only
 * among worktrees Desktop already authorized, so the phone never grants a new folder.
 */
export const mobileWorkbenchRootMethods = {
    'mobile.workbenchRoot.list': listSpec,
    'mobile.workbenchRoot.select': selectSpec,
} as const satisfies Record<string, MethodSpec>;
