import {
    agentProviderCatalog,
    isExternalEditorTabPath,
    isUntitledEditorTabPath,
    parseAgentContextTab,
    parseAgentSideChatTab,
    parseAgentStatusTab,
    parseAgentTranscriptTab,
    parseFilePreviewTab,
} from '@caxri/protocol';
import { useShallow } from 'zustand/react/shallow';

import { useTranslation } from '../../../i18n';
import { useTerminal } from '../../../stores/selectors';
import { sessionViewScope, useSessionViewStore } from '../../../stores/session-view';
import { useCachedAgentChatTask } from '../../agent-chat/hooks/use-agent-chat-task';
import { usePaneViewSession } from '../../workbench/pane-view-session';
import { documentTabPresentation } from '../document-tab-presentation';
import { untitledLanguageKey, useUntitledLanguageStore } from '../untitled/language-store';
import { untitledFirstLineName } from '../untitled/names';

const noDisplayPaths: readonly string[] = [];

/**
 * `documentTabPresentation` fed with the live records a virtual tab names: an Agent transcript, status, or context
 * tab's Terminal, an Agent Chat task tab's cached task, and, for files outside every Project, the display paths of the
 * Session's other external documents in the pane's Session. Tab identity is the Terminal or task ID alone; the label
 * follows its stable semantic title, never a PTY window title.
 */
export function useDocumentTabPresentation(path: string, displayPath: string | undefined) {
    const { t } = useTranslation();
    const session = usePaneViewSession();
    const documentScope = session
        ? sessionViewScope(session.id, session.workbenchRootProjectId)
        : undefined;
    const transcriptTerminal = useTerminal(parseAgentTranscriptTab(path)?.terminalId ?? '');
    const agentTerminal = useTerminal(
        (parseAgentStatusTab(path) ?? parseAgentContextTab(path) ?? parseAgentSideChatTab(path))
            ?.terminalId ?? '',
    );
    const task = useCachedAgentChatTask(path);
    const previewSourcePath = parseFilePreviewTab(path)?.path;
    const previewSourceDisplayPath = useSessionViewStore((state) =>
        documentScope && previewSourcePath && isExternalEditorTabPath(previewSourcePath)
            ? state.documents[documentScope]?.[previewSourcePath]?.displayPath
            : undefined,
    );
    /**
     * Only an external editor tab needs its siblings; every other tab selects one shared empty list, so a keystroke in
     * an unrelated buffer never re-renders it.
     */
    const externalDisplayPaths = useSessionViewStore(
        useShallow((state) => {
            if (!documentScope || !isExternalEditorTabPath(path)) return noDisplayPaths;
            const documents = state.documents[documentScope] ?? {};
            return Object.entries(documents)
                .filter(([documentPath]) => isExternalEditorTabPath(documentPath))
                .map(([, document]) => document.displayPath)
                .filter((value): value is string => Boolean(value));
        }),
    );
    const isUntitled = isUntitledEditorTabPath(path);
    /**
     * Derived inside the selector so a keystroke re-renders the tab only when the first line's name actually changes.
     */
    const untitledName = useSessionViewStore((state) => {
        const content =
            documentScope && isUntitled
                ? state.documents[documentScope]?.[path]?.content
                : undefined;
        return content === undefined ? undefined : untitledFirstLineName(content);
    });
    const untitledLanguageExtension = useUntitledLanguageStore((state) =>
        documentScope && isUntitled
            ? state.candidates[untitledLanguageKey(documentScope, path)]?.[0]
            : undefined,
    );
    return documentTabPresentation(
        path,
        {
            agentName: agentTerminal?.provider
                ? agentProviderCatalog[agentTerminal.provider].displayName
                : undefined,
            agentTerminalTitle: agentTerminal?.title,
            displayPath,
            externalDisplayPaths,
            previewSourceDisplayPath,
            transcriptTitle: transcriptTerminal?.title,
            task,
            untitledLanguageExtension,
            untitledName,
        },
        t,
    );
}
