import type {
    AgentChatCommandDelegation,
    AgentChatItem,
    AgentChatPatchOperation,
} from '@caxri/protocol';
import { MAX_COMMAND_DELEGATIONS } from '@caxri/protocol';

/**
 * What the delegation records say about the tasks one Chat Terminal created. Both reads cover only records whose caller
 * Terminal is this Chat's own, which is what makes an ID in command output trustworthy.
 */
export interface CommandDelegationSource {
    /**
     * The task `delegationId` names when this Chat's Terminal created it. `turnId` is the Chat turn that was running at
     * creation, absent when it was not recorded.
     */
    owned(delegationId: string): { sessionId: string; turnId?: string } | undefined;
    /**
     * The tasks this Chat's Terminal created during `turnId`.
     */
    forTurn(turnId: string): readonly AgentChatCommandDelegation[];
}

/**
 * The two ID shapes Server Core mints for a task (`dispatch-<64 hex>` and a UUID). Matching shapes rather than an
 * output format keeps the stamp independent of `--json`, `--quiet`, `jq`, or a human-readable table.
 */
const DELEGATION_ID =
    /dispatch-[\da-f]{64}|\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gu;

/**
 * Most distinct ID-shaped tokens one command output is looked up for, so a command that prints many UUIDs costs a
 * bounded number of record reads.
 */
const MAX_LOOKUPS_PER_COMMAND = 32;

type CommandItem = Extract<AgentChatItem, { type: 'command' }>;

/**
 * Marks the command items that created a delegation with `delegations`, on live ops and on a history replay alike, so a
 * Client can draw a record row where the Agent delegated work. Commands and their output are model-controlled, so the
 * match is made against the delegation records of this Chat's own Terminal, never trusted from the text:
 *
 * 1. An ID in the command's output that this Terminal created marks that command, several per command allowed. The first
 *    command to name an ID keeps it, so a later `wait` or `result` that prints it is not a second record.
 * 2. A task recorded for a turn but named in no command output (a redirected, backgrounded, or filtered create) is
 *    attached to the newest settled command of that turn, so a created delegation is not lost.
 *
 * Marks stay on their item through its later upserts (a provider rebuilds the item from the tool result, which carries
 * none of this), and `reset` forgets them before the replayed history is marked again. IDs only.
 */
export class CommandDelegationStamper {
    private readonly assigned = new Map<string, string>();
    private readonly byItem = new Map<string, AgentChatCommandDelegation[]>();
    private readonly lastCommandByTurn = new Map<string, string>();
    private readonly seen = new Set<string>();

    constructor(private readonly source: CommandDelegationSource) {}

    private withDelegations(item: CommandItem, isReplay: boolean): CommandItem {
        const { turnId } = item;
        const found = [...(this.byItem.get(item.id) ?? [])];
        const add = (delegationId: string, sessionId: string) => {
            if (found.length >= MAX_COMMAND_DELEGATIONS) return;
            this.assigned.set(delegationId, item.id);
            found.push({ delegationId, sessionId });
        };
        const ids = new Set(item.output.matchAll(DELEGATION_ID).map((match) => match[0]));
        let lookups = 0;
        for (const delegationId of ids) {
            if (lookups++ >= MAX_LOOKUPS_PER_COMMAND) break;
            if (this.assigned.has(delegationId)) continue;
            const owned = this.source.owned(delegationId);
            if (!owned) continue;
            /**
             * A live command of another turn that prints the ID is a read of an older task. A replay's turn IDs need
             * not equal the live ones, so it matches on the ID alone.
             */
            if (
                !isReplay &&
                turnId !== undefined &&
                owned.turnId !== undefined &&
                owned.turnId !== turnId
            )
                continue;
            add(delegationId, owned.sessionId);
        }
        if (
            turnId !== undefined &&
            item.status !== 'running' &&
            this.lastCommandByTurn.get(turnId) === item.id
        )
            for (const task of this.source.forTurn(turnId))
                if (!this.assigned.has(task.delegationId)) add(task.delegationId, task.sessionId);
        if (found.length === 0) return item;
        this.byItem.set(item.id, found);
        return { ...item, delegations: found };
    }

    /**
     * Records the commands a batch carries, in order, before any is stamped. A replay holds a whole turn at once and
     * its tasks already exist, so without this the turn's first settled command would take the unnamed tasks before the
     * command that created them was seen.
     */
    private noteCommands(operations: readonly AgentChatPatchOperation[]): void {
        for (const operation of operations) {
            if (operation.op !== 'upsertItem' || operation.item.type !== 'command') continue;
            // The newest command is the one first seen last; a later upsert of an older item does not move it.
            const { id, turnId } = operation.item;
            if (turnId !== undefined && !this.seen.has(id)) this.lastCommandByTurn.set(turnId, id);
            this.seen.add(id);
        }
    }

    stamp(operations: readonly AgentChatPatchOperation[]): readonly AgentChatPatchOperation[] {
        let stamped: AgentChatPatchOperation[] | undefined;
        const resetIndex = operations.findLastIndex((operation) => operation.op === 'reset');
        const isReplay = resetIndex !== -1;
        if (isReplay) {
            this.assigned.clear();
            this.byItem.clear();
            this.lastCommandByTurn.clear();
            this.seen.clear();
        }
        this.noteCommands(isReplay ? operations.slice(resetIndex + 1) : operations);
        for (const [index, operation] of operations.entries()) {
            if (index <= resetIndex) continue;
            if (operation.op !== 'upsertItem' || operation.item.type !== 'command') continue;
            const item = this.withDelegations(operation.item, isReplay);
            if (item === operation.item) continue;
            stamped ??= [...operations];
            stamped[index] = { op: 'upsertItem', item };
        }
        return stamped ?? operations;
    }
}
