import { translate, useTranslation } from '../../i18n';
import { isAgentProcessRunning } from '../../lib/terminal-agent-runtime';
import { getBootstrap, useProjects, useSessions } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import type { SessionReferenceCandidate } from '../session/session-reference';
import { searchSessionReferences, sessionReferenceQuery } from '../session/session-reference';
import { prepareSessionReference } from '../session/session-reference-commands';
import { didSendAgentActionInputSteps } from './agent-actions-commands';

/**
 * The picker's `@` mode: a search starting with `@` lists other Sessions by title instead of actions, the prefix that
 * cites a Session in the Chat composer too. Choosing one inserts a reference to a condensed copy of that Session's
 * conversation into the Agent's input. It never submits: the user is mid-sentence, the same as the action picker's
 * Insert.
 */
export function useAgentActionSessionReferences({
    currentSessionId,
    isOpen,
    runInputSequence,
    search,
    terminalId,
}: {
    currentSessionId: string | undefined;
    isOpen: boolean;
    /**
     * Shared with the action picker: runs one input write while the modal stays focused, so a keystroke cannot
     * interleave with it, then closes the picker. A second call while one runs is ignored.
     */
    runInputSequence: (task: () => Promise<void>) => void;
    search: string;
    terminalId: string | undefined;
}) {
    const { t } = useTranslation();
    const sessions = useSessions();
    const projects = useProjects();
    const query = sessionReferenceQuery(search);
    const candidates =
        isOpen && query !== undefined
            ? searchSessionReferences(sessions, projects, currentSessionId, query)
            : [];
    const insert = (candidate: SessionReferenceCandidate): void => {
        if (!terminalId) return;
        runInputSequence(async () => {
            const reference = await prepareSessionReference(candidate.sessionId);
            // The Agent may have exited while the file was written; the reference must not reach the Shell behind it.
            const current = getBootstrap()?.terminals.find(({ id }) => id === terminalId);
            if (reference && !isAgentProcessRunning(current?.lastAgentProcessState))
                pushToast('error', translate('agentActions.agentNotRunning'));
            else if (reference)
                await didSendAgentActionInputSteps(terminalId, [{ data: `${reference} ` }]);
        });
    };
    return {
        candidates,
        /**
         * The selected cmdk row's dataset names a Session row by `data-session-reference`.
         */
        candidateFor: (dataset: DOMStringMap | undefined) =>
            candidates.find((candidate) => candidate.sessionId === dataset?.sessionReference),
        emptyText: t(
            query === undefined ? 'agentActions.empty.actions' : 'agentActions.empty.sessions',
        ),
        insert,
        isActive: query !== undefined,
    };
}
