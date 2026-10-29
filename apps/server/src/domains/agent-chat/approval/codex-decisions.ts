import type { AgentChatDecision } from '@caxri/protocol';

import { clip, isRecord } from '../chat-items';

/**
 * The decisions Codex lists in a command or file-change approval's `availableDecisions`, and the command prefix rule it
 * proposes remembering. Inputs are untrusted JSON.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs
 */

type Json = Record<string, unknown>;

const SIMPLE_DECISIONS = new Set<AgentChatDecision>([
    'accept',
    'acceptForSession',
    'decline',
    'cancel',
]);

/**
 * Longest `execpolicy_amendment` (tokens of a command prefix) and total prefix text kept.
 */
const MAX_AMENDMENT_TOKENS = 32;
const MAX_PREFIX_LENGTH = 500;

function tokens(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AMENDMENT_TOKENS)
        return undefined;
    return value.every((token) => typeof token === 'string' && token !== '')
        ? (value as string[])
        : undefined;
}

/**
 * The command prefix rule Codex offers to remember for this request, kept exactly as Codex sent it so the same array
 * goes back in `acceptWithExecpolicyAmendment`. Only an amendment Codex lists in `availableDecisions` counts, since
 * that list is what Codex accepts as an answer; its own entry wins over the top-level `proposedExecpolicyAmendment`. A
 * network approval never has one: its rule would be a host rule, which Caxri does not offer.
 */
export function codexExecpolicyAmendment(parameters: Json): string[] | undefined {
    if (isRecord(parameters.networkApprovalContext)) return undefined;
    if (!Array.isArray(parameters.availableDecisions)) return undefined;
    for (const decision of parameters.availableDecisions) {
        if (!isRecord(decision) || !isRecord(decision.acceptWithExecpolicyAmendment)) continue;
        const listed = tokens(decision.acceptWithExecpolicyAmendment.execpolicy_amendment);
        return listed ?? tokens(parameters.proposedExecpolicyAmendment);
    }
    return undefined;
}

/**
 * The prefix as the card shows it: the amendment's tokens joined by spaces.
 */
export function codexAmendmentPrefix(amendment: readonly string[]): string {
    return clip(amendment.join(' '), MAX_PREFIX_LENGTH);
}

/**
 * The plain decisions Codex lists, plus `decline` whenever it lists `cancel`, plus `acceptAlways` when it lists a
 * usable prefix amendment. Codex's default command approval offers `accept` and `cancel` but not `decline`, yet its
 * app-server answers `decline` for any command approval: the command is marked declined and the turn goes on, which is
 * what the TUI's "No, continue without running it" sends. Without it a Chat card would offer only `Run`, since `cancel`
 * (stopping the whole turn) is the Stop button's job, not a card choice. An absent list means every plain decision.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs
 */
export function codexApprovalDecisions(parameters: Json): AgentChatDecision[] | undefined {
    const available = parameters.availableDecisions;
    if (!Array.isArray(available)) return undefined;
    const decisions = new Set(
        available.filter(
            (decision): decision is AgentChatDecision =>
                typeof decision === 'string' && SIMPLE_DECISIONS.has(decision as AgentChatDecision),
        ),
    );
    if (decisions.has('cancel')) decisions.add('decline');
    if (codexExecpolicyAmendment(parameters)) decisions.add('acceptAlways');
    return decisions.size > 0 ? [...decisions] : undefined;
}
