import { useEffect, useRef, useState } from 'react';

import {
    formatAgentChatFileMention,
    formatAgentChatSessionReference,
    searchSessionReferenceCandidates,
} from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';

import { useTranslation } from '../../i18n';
import { useMobileClient } from '../connection/mobile-client-provider';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { insertComposerSuggestion } from '../sessions/composer-suggestions';
import { allMobileSessions } from '../sessions/hooks/use-session-polling';
import type { AgentChatMentionRow } from './agent-chat-mentions';
import { agentChatMentionRows, agentChatMentionToken } from './agent-chat-mentions';

/**
 * The Chat composer's `@` list, as on Desktop: Project files by name (`mobile.files.search`, the Terminal composer's
 * search) and the Host's other Sessions with an Agent by title. Choosing a file inserts its `@path` mention; choosing a
 * Session asks the Server to condense that conversation into a reference file (`mobile.session.conversationReference`)
 * and inserts the sentence citing it, so the conversation itself never reaches the phone. `rows` is `undefined` while
 * the draft does not end in an `@` token; `error` says a Session could not be cited, until the next choice.
 */
export const useAgentChatMentions = ({
    draft,
    isEnabled,
    onDraftChange,
    sessionId,
}: {
    draft: string;
    isEnabled: boolean;
    onDraftChange: (draft: string) => void;
    sessionId: string;
}) => {
    const { t } = useTranslation();
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const { sessions } = useHostSessions();
    const [preparingSessionId, setPreparingSessionId] = useState<string>();
    const [error, setError] = useState<string | null>(null);
    /**
     * What the user has typed by the time a Session reference arrives, so the insertion does not undo it.
     */
    const latestDraft = useRef(draft);
    useEffect(() => {
        latestDraft.current = draft;
    }, [draft]);
    const mention = isEnabled ? agentChatMentionToken(draft) : undefined;
    const files = useQuery({
        enabled:
            status === 'connected' &&
            isForeground &&
            connectionScopeKey !== null &&
            Boolean(mention?.query),
        // Only the same Session's earlier answer may stand in, so the list does not flicker between keystrokes.
        placeholderData: (previous, previousQuery) =>
            previousQuery?.queryKey[3] === sessionId ? previous : undefined,
        queryFn: () => request('mobile.files.search', { sessionId, query: mention!.query }),
        queryKey: ['mobile', 'composer-files', connectionScopeKey, sessionId, mention?.query],
        retry: false,
        staleTime: 15_000,
    });
    const rows = mention
        ? agentChatMentionRows(
              mention.query ? files.data?.paths : undefined,
              searchSessionReferenceCandidates(
                  allMobileSessions(sessions.sections),
                  sessionId,
                  mention.query,
              ),
          )
        : undefined;
    const choose = async (row: AgentChatMentionRow): Promise<void> => {
        if (!mention || preparingSessionId !== undefined) return;
        setError(null);
        if (row.kind === 'file') {
            onDraftChange(
                insertComposerSuggestion(
                    draft,
                    mention.token,
                    formatAgentChatFileMention(row.path),
                ),
            );
            return;
        }
        setPreparingSessionId(row.sessionId);
        try {
            const reference = await request('mobile.session.conversationReference', {
                sessionId: row.sessionId,
            });
            // Text typed after the `@` while the reference was prepared stays; the reference then follows it.
            const current = latestDraft.current;
            const text = formatAgentChatSessionReference(reference);
            onDraftChange(
                current.endsWith(mention.token)
                    ? insertComposerSuggestion(current, mention.token, text)
                    : `${current}${current === '' || /\s$/u.test(current) ? '' : ' '}${text} `,
            );
        } catch {
            setError(t('chat.mentions.sessionFailed', { title: row.title }));
        } finally {
            setPreparingSessionId(undefined);
        }
    };
    return {
        choose,
        error,
        isError: files.isError,
        isSearching: Boolean(mention?.query) && files.isFetching,
        preparingSessionId,
        rows,
    };
};
