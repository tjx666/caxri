import type { AgentChatWorkItem } from '@caxri/protocol';
import { mergeAgentChatReasoning, splitAgentChatWork } from '@caxri/protocol';

/**
 * A run of consecutive work as the timeline's `work` entry, without its `kind`. Back-to-back thoughts merge into one
 * row titled by the latest, and independent tasks keep their own rows (`splitAgentChatWork`). Once the run settles, a
 * summary of one call adds nothing over the call itself, so that call becomes its own row, as on Desktop. The running
 * turn's trailing run (`isOpen`) keeps its summary, so a second call joining it does not reshape the row.
 */
export function agentChatWorkEntry(
    work: readonly AgentChatWorkItem[],
    taskItemIds: ReadonlySet<string>,
    isOpen: boolean,
):
    | {
          id: string;
          isOpen?: true;
          summarized: readonly AgentChatWorkItem[];
          rows: readonly AgentChatWorkItem[];
      }
    | undefined {
    const first = work.at(0);
    if (!first) return undefined;
    const split = splitAgentChatWork(mergeAgentChatReasoning(work), (item) =>
        taskItemIds.has(item.id),
    );
    const isSingle = !isOpen && split.summarized.length === 1;
    return {
        id: `work:${first.id}`,
        ...(isOpen && { isOpen: true as const }),
        summarized: isSingle ? [] : split.summarized,
        rows: isSingle ? [...split.summarized, ...split.rows] : split.rows,
    };
}
