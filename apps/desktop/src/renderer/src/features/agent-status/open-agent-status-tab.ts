import { agentStatusTabPath } from '@caxri/protocol';

import { openEditorTab } from '../editor/document-commands';

/**
 * Opens one Agent Terminal's status tab. The status-bar speed chip and the `Show Agent Status` command share this, so
 * both land on the same tab identity.
 */
export function openAgentStatusTab(terminalId: string): void {
    openEditorTab(agentStatusTabPath(terminalId));
}
