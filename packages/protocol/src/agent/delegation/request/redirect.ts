import { z } from 'zod';

import { identifierSchema } from '../../../domain/identifiers.js';

/**
 * Longest redirect text, in characters. A redirect travels inline in the child's Chat as one steered message, so it is
 * bounded far below a task (which lives in a private file).
 */
export const MAX_DELEGATION_REDIRECT_TEXT = 4_096;

/**
 * Most redirect operations one task records. The record keeps one claim per operation, active or settled, so a replayed
 * request is recognized after the Server forgot its reply; a full record refuses further redirects instead of evicting
 * a claim that may still be in doubt.
 */
export const MAX_DELEGATION_REDIRECT_OPERATIONS = 64;

/**
 * Why a redirect was refused, as a closed set the caller acts on. A refusal never changes the task, except
 * `delivery_unknown`, which says the message may have reached the child:
 *
 * - `not_running`: the task is not `running` (still starting, collecting, settled, or interrupted).
 * - `waiting`: the child is blocked on a permission request or one of its own questions; answer that first.
 * - `not_chat`: the child runs in a Terminal, whose input cannot be steered.
 * - `human_intervened`: the user took the child over, so the delegating Agent no longer steers it.
 * - `launch_replaced`: the child's Agent process is not the one the task started on.
 * - `turn_changed`: the turn the task runs in ended or was replaced; use a follow-up for new work.
 * - `not_steerable`: the running turn takes no steered input (the provider refused it).
 * - `operation_reused`: the operation ID was used for different text.
 * - `too_many_operations`: the task already recorded the most redirects it keeps.
 * - `delivery_unknown`: the provider did not confirm the message in time, or the Server restarted while it was in flight.
 *   It may be in the child's conversation: read `transcript` before sending anything else.
 */
export type DelegationRedirectRefusal =
    | 'not_running'
    | 'waiting'
    | 'not_chat'
    | 'human_intervened'
    | 'launch_replaced'
    | 'turn_changed'
    | 'not_steerable'
    | 'operation_reused'
    | 'too_many_operations'
    | 'delivery_unknown';

/**
 * Where a recorded redirect operation stands: `pending` while the message is being delivered, `delivered` once the
 * provider confirmed it, `unknown` when it may or may not have arrived. Neither `pending` nor `unknown` is ever sent
 * again automatically.
 */
export const delegationRedirectStateSchema = z.enum(['pending', 'delivered', 'unknown']);
export type DelegationRedirectState = z.infer<typeof delegationRedirectStateSchema>;

/**
 * What a redirect carries. `operationId` names this one redirect: a request repeated with the same ID and text is
 * answered from the record and never delivers the message twice.
 */
export const delegationRedirectParametersSchema = z.strictObject({
    delegationId: identifierSchema,
    operationId: z
        .string()
        .min(8)
        .max(64)
        .regex(/^[\w-]+$/u),
    text: z
        .string()
        .trim()
        .min(1)
        .max(MAX_DELEGATION_REDIRECT_TEXT)
        .refine(
            (value) =>
                [...value].every((character) => {
                    const code = character.codePointAt(0)!;
                    return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
                }),
            'A redirect cannot contain terminal control characters',
        ),
});
