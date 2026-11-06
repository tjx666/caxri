import { useMemo } from 'react';

import type { TerminalKind, TerminalRecord } from '@caxri/protocol';
import { ChevronDown, Folder } from 'lucide-react';

import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/ui/menu';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useProjects, useSessionById } from '../../stores/selectors';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
import { moveFreshChat } from './fresh-chat-commands';
import {
    FRESH_CHAT_AGENT_SLOT,
    FRESH_CHAT_PROJECT_SLOT,
    freshChatKinds,
    freshChatProjects,
    freshChatSentenceParts,
} from './fresh-chat-session';

const NO_PROJECTS: never[] = [];

const TRIGGER_CLASS =
    'inline-flex h-6 max-w-48 cursor-pointer items-center gap-1 rounded-md border-0 bg-state-hover-quiet px-2 text-[13px] text-foreground hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none';

/**
 * The Chat empty state's heading for a fresh Chat (the pane checks `useIsFreshChatSession` first).
 */
export function FreshChatHeading({ terminal }: { terminal: TerminalRecord }) {
    const session = useSessionById(terminal.sessionId);
    if (!session) return null;
    return (
        <FreshChatTargetPicker
            kind={terminal.kind}
            projectId={session.projectId}
            sessionId={session.id}
        />
    );
}

/**
 * The empty state of a fresh Chat: "Start in [Project ▾] with [Agent ▾]". Choosing another Project or Agent replaces
 * this empty Session with one there (`moveFreshChat`); the line disappears with the first message, which locks both.
 * Codex and Claude Code's desktop apps and T3 Code's draft thread likewise let a new thread pick its Project on its
 * first screen instead of before it exists.
 */
function FreshChatTargetPicker({
    kind,
    projectId,
    sessionId,
}: {
    kind: TerminalKind;
    projectId: string;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const allProjects = useProjects();
    const projects = useMemo(
        () => freshChatProjects(topLevelProjects(allProjects ?? NO_PROJECTS)),
        [allProjects],
    );
    const project = allProjects?.find((candidate) => candidate.id === projectId);
    const projectMenu = (
        <Menu key="project">
            <MenuTrigger
                render={
                    <button
                        type="button"
                        aria-label={t('session.freshChat.chooseProject')}
                        className={TRIGGER_CLASS}
                        data-fresh-chat-project
                    >
                        <Folder className="flex-none text-muted" size={13} />
                        <span className="min-w-0 truncate">{project?.title}</span>
                        <ChevronDown className="flex-none text-muted" size={12} />
                    </button>
                }
            />
            <MenuContent aria-label={t('session.freshChat.chooseProject')} align="center">
                {projects.map((candidate) => (
                    <MenuItem
                        key={candidate.id}
                        onClick={() => {
                            if (candidate.id !== projectId)
                                moveFreshChat(sessionId, { projectId: candidate.id, kind });
                        }}
                    >
                        <Folder className="flex-none text-muted" size={14} />
                        <span className="flex-1 truncate">{candidate.title}</span>
                    </MenuItem>
                ))}
            </MenuContent>
        </Menu>
    );
    const agentMenu = (
        <Menu key="agent">
            <MenuTrigger
                render={
                    <button
                        type="button"
                        aria-label={t('session.freshChat.chooseAgent')}
                        className={TRIGGER_CLASS}
                        data-fresh-chat-agent
                    >
                        <AgentIdentityIcon identity={kind} size={13} />
                        <span className="min-w-0 truncate">{resolveAgentIcon(kind).label}</span>
                        <ChevronDown className="flex-none text-muted" size={12} />
                    </button>
                }
            />
            <MenuContent aria-label={t('session.freshChat.chooseAgent')} align="center">
                {freshChatKinds().map((candidate) => (
                    <MenuItem
                        key={candidate}
                        onClick={() => {
                            if (candidate !== kind)
                                moveFreshChat(sessionId, { projectId, kind: candidate });
                        }}
                    >
                        <AgentIdentityIcon identity={candidate} size={14} />
                        <span className="flex-1 truncate">{resolveAgentIcon(candidate).label}</span>
                    </MenuItem>
                ))}
            </MenuContent>
        </Menu>
    );
    const sentence = t('session.freshChat.startIn', {
        agent: FRESH_CHAT_AGENT_SLOT,
        project: FRESH_CHAT_PROJECT_SLOT,
    });
    return (
        <div
            className="flex flex-wrap items-center justify-center gap-1.5 text-[13px] text-muted"
            data-fresh-chat-target
        >
            {freshChatSentenceParts(sentence).map(({ key, part }) => {
                if (part === FRESH_CHAT_PROJECT_SLOT) return projectMenu;
                if (part === FRESH_CHAT_AGENT_SLOT) return agentMenu;
                return <span key={key}>{part}</span>;
            })}
        </div>
    );
}
