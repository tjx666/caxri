import type { BootstrapState, ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';

import { translate } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { sessionWorktreeProject } from '../primary-sidebar/project-visibility';
import { sessionAgentTerminal } from './session-agent-terminal';
import type { SessionLabel, SessionLabelInput } from './session-labels';
import { sessionLabels } from './session-labels';

interface LabelMemo {
    labels: Map<string, SessionLabel>;
    projects: readonly ProjectRecord[];
    sessions: readonly SessionRecord[];
    terminals: readonly TerminalRecord[];
    untitledLabel: string;
}

const memoSlot: { current?: LabelMemo } = {};

/**
 * The labels of every Session in the snapshot, computed once per change of the three record lists it reads. Every tab
 * and row selects its own primitives out of this map, so a status change (which replaces the Session list) recomputes
 * the map but re-renders only the rows whose title or suffix changed.
 *
 * Archived Sessions are not visible, so they cannot create a collision, but they still count toward ordinals.
 */
export function labelsFor(
    sessions: readonly SessionRecord[],
    projects: readonly ProjectRecord[],
    terminals: readonly TerminalRecord[],
    untitledLabel: string,
): Map<string, SessionLabel> {
    const memo = memoSlot.current;
    if (
        memo?.sessions === sessions &&
        memo.projects === projects &&
        memo.terminals === terminals &&
        memo.untitledLabel === untitledLabel
    )
        return memo.labels;
    const projectTitles = new Map(projects.map((project) => [project.id, project.displayTitle]));
    const inputs: SessionLabelInput[] = sessions.map((session) => ({
        agentLabel: resolveAgentIcon(sessionAgentTerminal(session, terminals)?.kind ?? 'shell')
            .label,
        createdAt: session.createdAt,
        displayTitle: session.displayTitle,
        id: session.id,
        projectId: session.projectId,
        projectTitle: projectTitles.get(session.projectId) ?? '',
        visible: session.archivedAt === undefined,
        workingLocation: sessionWorktreeProject(session, projects)?.displayTitle,
    }));
    const labels = sessionLabels(inputs, untitledLabel);
    memoSlot.current = { labels, projects, sessions, terminals, untitledLabel };
    return labels;
}

/**
 * The label of one Session outside React, for announcements.
 */
export function sessionLabelOf(
    bootstrap: Pick<BootstrapState, 'projects' | 'sessions' | 'terminals'> | undefined,
    sessionId: string,
): SessionLabel | undefined {
    return bootstrap
        ? labelsFor(
              bootstrap.sessions,
              bootstrap.projects,
              bootstrap.terminals,
              translate('session.untitled'),
          ).get(sessionId)
        : undefined;
}
