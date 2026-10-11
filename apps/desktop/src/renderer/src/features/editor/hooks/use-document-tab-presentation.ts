import {
    agentProviderCatalog,
    parseAgentStatusTab,
    parseAgentTranscriptTab,
} from '@caxri/protocol';

import { useTerminal } from '../../../stores/selectors';
import { useCachedAgentChatTask } from '../../agent-chat/hooks/use-agent-chat-task';
import { documentTabPresentation } from '../document-tab-presentation';

/**
 * `documentTabPresentation` fed with the live records a virtual tab names: an Agent transcript or status tab's Terminal
 * and an Agent Chat task tab's cached task. Tab identity is the Terminal or task ID alone; the label follows its stable
 * semantic title, never a PTY window title.
 */
export function useDocumentTabPresentation(path: string, displayPath: string | undefined) {
    const transcriptTerminal = useTerminal(parseAgentTranscriptTab(path)?.terminalId ?? '');
    const statusTerminal = useTerminal(parseAgentStatusTab(path)?.terminalId ?? '');
    const task = useCachedAgentChatTask(path);
    return documentTabPresentation(path, {
        agentName: statusTerminal?.provider
            ? agentProviderCatalog[statusTerminal.provider].displayName
            : undefined,
        displayPath,
        transcriptTitle: transcriptTerminal?.title,
        task,
    });
}
