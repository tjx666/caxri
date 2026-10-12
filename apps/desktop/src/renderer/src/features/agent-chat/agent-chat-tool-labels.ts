import type { AgentToolKind, AgentToolOutcome, AgentToolPresentation } from '@caxri/protocol';
import { agentToolKindCounts } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

/**
 * The shared tool table in `@caxri/protocol` names each tool with an English past-tense label, which the CLI and the
 * phone also read. The Chat translates those labels at display time by their English source; a label outside this table
 * (an MCP server or an unknown tool's own name) is an identifier and stays as is.
 */
const TOOL_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
    'Ran': 'agentChat.tool.label.ran',
    'Checked output': 'agentChat.tool.label.checkedOutput',
    'Sent input': 'agentChat.tool.label.sentInput',
    'Stopped': 'agentChat.tool.label.stopped',
    'Read': 'agentChat.tool.label.read',
    'Listed': 'agentChat.tool.label.listed',
    'Listed files': 'agentChat.tool.label.listedFiles',
    'Edited': 'agentChat.tool.label.edited',
    'Created': 'agentChat.tool.label.created',
    'Patched': 'agentChat.tool.label.patched',
    'Wrote': 'agentChat.tool.label.wrote',
    'Searched': 'agentChat.tool.label.searched',
    'Found files': 'agentChat.tool.label.foundFiles',
    'Looked up tools': 'agentChat.tool.label.lookedUpTools',
    'Fetched': 'agentChat.tool.label.fetched',
    'Searched the web': 'agentChat.tool.label.searchedWeb',
    'Ran agent': 'agentChat.tool.label.ranAgent',
    'Started agent': 'agentChat.tool.label.startedAgent',
    'Updated plan': 'agentChat.tool.label.updatedPlan',
    'Proposed plan': 'agentChat.tool.label.proposedPlan',
    'Used skill': 'agentChat.tool.label.usedSkill',
    'Asked': 'agentChat.tool.label.asked',
    'Viewed image': 'agentChat.tool.label.viewedImage',
    'Thought': 'agentChat.tool.label.thought',
    'Thinking': 'agentChat.tool.label.thinking',
    'Used the browser': 'agentChat.tool.label.usedBrowser',
    'Used Computer Use': 'agentChat.tool.label.usedComputerUse',
};

/**
 * Tool kinds that name an action. `mcp` and `other` name a server or tool instead and keep their label, and a Computer
 * Use step's label is the title the Agent wrote for it.
 */
type AgentToolActionKind = Exclude<AgentToolKind, 'browser' | 'computer' | 'mcp' | 'other'>;

const isActionKind = (kind: AgentToolKind): kind is AgentToolActionKind =>
    kind !== 'browser' && kind !== 'computer' && kind !== 'mcp' && kind !== 'other';

/**
 * A completed tool's verb (`Edited`) in the active language.
 */
export function agentChatToolLabel(label: string, t: Translate = translate): string {
    const key = Object.hasOwn(TOOL_LABEL_KEYS, label) ? TOOL_LABEL_KEYS[label] : undefined;
    return key ? t(key) : label;
}

/**
 * The present-tense verb for work still running (`Editing`), mirroring `agentToolActiveLabel`. `presentation.label` is
 * already translated.
 */
export function agentChatToolActiveLabel(
    presentation: Pick<AgentToolPresentation, 'kind' | 'label'>,
    t: Translate = translate,
): string {
    return isActionKind(presentation.kind)
        ? t(`agentChat.tool.active.${presentation.kind}`)
        : presentation.label;
}

/**
 * How a settled tool ended (`Failed to edit`, `Not allowed to run`, `Stopped editing`), mirroring
 * `agentToolOutcomeLabel`. `presentation.label` is already translated.
 */
export function agentChatToolOutcomeLabel(
    presentation: Pick<AgentToolPresentation, 'kind' | 'label'>,
    outcome: AgentToolOutcome,
    t: Translate = translate,
): string {
    const { kind, label } = presentation;
    const verb = isActionKind(kind) ? t(`agentChat.tool.verb.${kind}`) : undefined;
    switch (outcome) {
        case 'completed': {
            return label;
        }
        case 'failed': {
            return verb
                ? t('agentChat.tool.failedTo', { verb })
                : t('agentChat.tool.failedNamed', { label });
        }
        case 'declined': {
            return verb
                ? t('agentChat.tool.notAllowedTo', { verb })
                : t('agentChat.tool.notAllowedNamed', { label });
        }
        case 'interrupted': {
            return isActionKind(kind)
                ? t(`agentChat.tool.stopped.${kind}`)
                : t('agentChat.tool.stoppedNamed', { label });
        }
    }
}

/**
 * `Ran 3 commands, read 2 files`, mirroring `summarizeAgentToolGroup` in the active language.
 */
export function agentChatToolGroupSummary(
    tools: Parameters<typeof agentToolKindCounts>[0],
    t: Translate = translate,
): string {
    const phrase = agentToolKindCounts(tools)
        .map(({ kind, count }) =>
            t(`agentChat.tool.group.${kind}${count === 1 ? 'One' : 'Other'}`, { count }),
        )
        .join(t('agentChat.tool.groupSeparator'));
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
