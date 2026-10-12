import type { TreeItemDto } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { openExternalUrl } from '../../lib/external-link';
import { isCancelledRequest, pushToast } from '../../stores/toasts';
import { agentPromptText, sendPromptToSessionAgent } from '../terminal/agent-prompt-commands';
import { actionFailureMessage, dispatchExtensionViewAction } from './view-container-commands';

/**
 * The Workbench command a provider uses for "open this page", resolved here rather than in the Extension Host.
 */
const OPEN_EXTERNAL_COMMAND = 'caxri.openExternal';

/**
 * The Workbench command a provider uses for "hand this prompt to the Agent", such as the Status panel's `Fix` for
 * unresolved review comments. Extensions have no authority over Agents, so the Renderer resolves it: the prompt goes to
 * the selected Session's Agent only because the user clicked the provider's button.
 */
const SEND_TO_AGENT_COMMAND = 'caxri.sendToAgent';

export type TreeItemAction = NonNullable<TreeItemDto['actions']>[number];

/**
 * Asks first when the provider attached a confirmation, then runs the action's command through
 * {@link runTreeItemCommand}. Resolves once the command settled, so the button can stay busy for the whole round trip
 * rather than inviting a second click while the first is still running.
 */
export async function runTreeItemAction(action: TreeItemAction): Promise<void> {
    if (action.confirmation) {
        const isConfirmed = await caxri.window.showConfirm({
            title: action.confirmation.title,
            message: action.confirmation.message,
            confirmLabel: action.confirmation.confirmLabel,
        });
        if (!isConfirmed) return;
    }
    await runTreeItemCommand(action.command, action.feedback);
}

/**
 * Runs {@link SEND_TO_AGENT_COMMAND} with the action's feedback copy: the failure prefix is the provider's, and the
 * success toast names the Agent that received the prompt, which only the Renderer knows.
 */
async function sendTreeItemPromptToAgent(
    command: TreeItemAction['command'],
    feedback?: TreeItemAction['feedback'],
): Promise<void> {
    const failure =
        feedback?.failure ??
        translate('viewContainers.commands.runFailed', { title: command.title });
    const prompt = agentPromptText(command.arguments?.[0]);
    if (!prompt) {
        pushToast('error', translate('viewContainers.commands.promptMissing', { failure }));
        return;
    }
    try {
        const agentName = await sendPromptToSessionAgent(prompt);
        pushToast(
            'success',
            translate('viewContainers.commands.sentToAgent', { agent: agentName }),
        );
    } catch (error) {
        if (!isCancelledRequest(error)) pushToast('error', actionFailureMessage(error, failure));
    }
}

/**
 * The one way a tree row's own command or an inline action's command runs: `caxri.openExternal` (a link row, or a
 * blocked merge's "Open on GitHub") opens the page in the Renderer without a round trip to the extension,
 * `caxri.sendToAgent` hands its prompt to the Session's Agent, and every other command goes through the shared
 * extension dispatcher with its toasts.
 */
export async function runTreeItemCommand(
    command: TreeItemAction['command'],
    feedback?: TreeItemAction['feedback'],
): Promise<void> {
    if (command.id === OPEN_EXTERNAL_COMMAND) {
        const [url] = command.arguments ?? [];
        if (typeof url === 'string')
            await openExternalUrl(url, (message) => pushToast('error', message));
        else
            pushToast(
                'error',
                translate('viewContainers.commands.linkMissing', { title: command.title }),
            );
        return;
    }
    if (command.id === SEND_TO_AGENT_COMMAND) {
        await sendTreeItemPromptToAgent(command, feedback);
        return;
    }
    await dispatchExtensionViewAction(command.id, command.title, command.arguments ?? [], feedback);
}

/**
 * What a key pressed on an inline action button does, given the button's position among the row's actions:
 *
 * - `focus`: move roving focus to the action at `index`;
 * - `row`: hand focus back to the row (Left from the first action, or Escape);
 * - `native`: the button handles the key itself (Enter and Space click it), so the row must not see it;
 * - `none`: the key belongs to the group but has nothing to do (Right on the last action);
 * - `undefined`: the key is not the action group's, and it may bubble to the row (Up/Down keep moving between rows).
 *
 * Left and Right stop at the ends instead of wrapping, matching the tree's own edge behavior.
 */
export type TreeItemActionKeyIntent =
    { kind: 'focus'; index: number } | { kind: 'native' } | { kind: 'none' } | { kind: 'row' };

export function treeItemActionKeyIntent(
    key: string,
    index: number,
    count: number,
): TreeItemActionKeyIntent | undefined {
    switch (key) {
        case 'ArrowLeft':
            return index <= 0 ? { kind: 'row' } : { kind: 'focus', index: index - 1 };
        case 'ArrowRight':
            return index >= count - 1 ? { kind: 'none' } : { kind: 'focus', index: index + 1 };
        case 'Escape':
            return { kind: 'row' };
        case 'Enter':
        case ' ':
            return { kind: 'native' };
        default:
            return undefined;
    }
}
