import type { AgentProvider } from '@caxri/protocol';

import type { SettingsView } from '../../stores/dialogs';
import type { ConfigKind } from './config-edit';

/**
 * Views reached by scrolling one row into view, so one request carries the row id rather than one prop per row. Both
 * `argv.jsonc` boot flags land here (`settingTitleForArgvKey` in `argv-restart-notice.ts` already ties a boot flag to
 * its row through the binding type; this is the same convention on the navigation side), and so does the suspended
 * Terminal's Open Settings action, on the first of the Agent suspension settings.
 */
const FOCUSED_ROW_IDS: Partial<Record<SettingsView, string>> = {
    'hardware-acceleration': 'terminal.hardwareAcceleration',
    'remote-debugging': 'security.remoteDebugging',
    'agent-suspension': 'terminal.idleSuspension.enabled',
    'claude-windows': 'agents.claude.windows',
};

export function rowFocusRequest(request: {
    id: number;
    view: SettingsView;
}): { id: number; rowId: string } | undefined {
    const rowId = FOCUSED_ROW_IDS[request.view];
    return rowId ? { id: request.id, rowId } : undefined;
}

/**
 * The section and view an open request lands on. Only Source and Keybindings name their own section; every other
 * request, including an untargeted open, lands on the Settings list: leaving the section wherever the last open left it
 * would hand `Cmd+,` to Theme or Keybindings, where the search field an untargeted open focuses does not exist.
 */
export function settingsSectionForRequest(view: SettingsView): {
    tab: ConfigKind;
    view: 'ui' | 'source';
} {
    if (view === 'source') return { tab: 'settings', view: 'source' };
    if (view === 'keybindings') return { tab: 'keybindings', view: 'ui' };
    return { tab: 'settings', view: 'ui' };
}

/**
 * Rows the Settings page's open focus requests scroll to. An advanced row among them stays listed while advanced rows
 * are hidden, so the Git exclusions button, the debugging chip, or the GPU crash card still lands on its row.
 */
export function revealedSettingRowIds(requests: {
    trustedDomainsFocusRequestId?: number;
    gitExclusionsFocusRequestId?: number;
    rowFocusRequest?: { rowId: string };
    agentActionsFocusRequest?: { provider: AgentProvider };
    agentExecutableFocusRequest?: { provider: AgentProvider };
}): ReadonlySet<string> {
    const ids = new Set<string>();
    if (requests.trustedDomainsFocusRequestId) ids.add('security.trustedDomains');
    if (requests.gitExclusionsFocusRequestId) ids.add('git.diffExclude');
    if (requests.rowFocusRequest) ids.add(requests.rowFocusRequest.rowId);
    if (requests.agentActionsFocusRequest)
        ids.add(`agents.${requests.agentActionsFocusRequest.provider}.actions`);
    if (requests.agentExecutableFocusRequest)
        ids.add(`agents.${requests.agentExecutableFocusRequest.provider}.executable`);
    return ids;
}
