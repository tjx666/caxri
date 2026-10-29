import type { AgentActivityState } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { SessionActivityPresentation } from '../primary-sidebar/session-activity';
import {
    sessionActivityPresentation,
    sessionUnreadTone,
} from '../primary-sidebar/session-activity';
import type { AgentActivityRow } from './agent-activity-rows';
import { isAgentActivityActionable } from './agent-activity-rows';

export type AgentActivityGlyphId =
    | 'background'
    | 'check'
    | 'clock'
    | 'dashed'
    | 'hollow'
    | 'question'
    | 'spinner'
    | 'unplug'
    | 'x';

export interface AgentActivityGlyph {
    id: AgentActivityGlyphId;
    /**
     * The words the glyph stands for. The row prints no state text, so this is both its accessible name and its hover
     * title, the only place a user can still read "Waiting for you".
     */
    label: string;
    toneClassName: string;
}

/**
 * Six states, six shapes, each one the near-universal sign for its own noun. Nothing here is a color-coded dot: at 14px
 * a user has to tell "waiting" from "failed" from the outline alone, because the tone rule below leaves four of the six
 * in the same muted grey.
 */
const GLYPH_BY_STATE: Record<AgentActivityState, AgentActivityGlyphId> = {
    completed: 'check',
    failed: 'x',
    idle: 'hollow',
    running: 'spinner',
    unknown: 'dashed',
    waiting: 'question',
};

const TONE_TEXT_CLASSNAME: Record<SessionActivityPresentation['tone'], string> = {
    danger: 'text-danger',
    neutral: 'text-muted',
    success: 'text-success',
    warning: 'text-warning',
};

/**
 * The glyph that replaces a row's state phrase, and the one place this list spends color.
 *
 * Every group heading already names its own state, so printing it again on each row said "Working" under "Working" and
 * "Idle" under "Idle": three of the six groups repeated themselves verbatim, and the phrase cost the width the Project
 * name needed. The shape carries it instead, and {@link AgentActivityGlyph.label} carries the words.
 *
 * Tone follows the list's two-tier rule ({@link isAgentActivityActionable}): apart from a live turn's green spinner,
 * only a row that asks the user for something is tinted, so warning and danger weight always means "this one wants
 * you". An unread row is tinted by _why_ it is unread rather than by what its Agent is doing now; `statusPresentation`
 * answers the second question, and its answer is `neutral` for a completed turn, the commonest attention reason of
 * all.
 */
export function agentActivityGlyph(
    row: AgentActivityRow,
    t: Translate = translate,
): AgentActivityGlyph {
    const { groupId, session, status, statusPresentation } = row;
    if (status.kind === 'usageWait')
        return {
            id: 'clock',
            label: status.ariaDescription,
            toneClassName: TONE_TEXT_CLASSNAME.neutral,
        };
    if (status.kind === 'detached')
        return {
            id: 'unplug',
            label: t('agentActivity.glyph.detached'),
            toneClassName: TONE_TEXT_CLASSNAME.neutral,
        };
    /**
     * `running` folds in compaction, so the label comes from the live presentation rather than the stored state.
     *
     * The one tint outside the two-tier rule below. A live turn is the only motion in the list, and in muted grey a
     * spinner under "Working" read as a loading placeholder rather than an Agent doing work; green names it as
     * progress. It cannot be mistaken for a request, because an unread running Session sits under "Needs attention"
     * with its attention glyph instead, and this branch only ever renders under "Working".
     */
    // Waiting on background work is running without progress to show, so it stays muted like the sidebar.
    if (status.kind === 'running' && status.variant === 'background')
        return {
            id: 'background',
            label: statusPresentation.label,
            toneClassName: TONE_TEXT_CLASSNAME.neutral,
        };
    if (status.kind === 'running')
        return {
            id: 'spinner',
            label: statusPresentation.label,
            toneClassName: TONE_TEXT_CLASSNAME.success,
        };
    const unread = groupId === 'attention' && session.hasUnread;
    const state: AgentActivityState = unread
        ? (session.lastAttentionKind ?? 'unknown')
        : session.agentActivityState;
    const presentation = sessionActivityPresentation(state);
    const tone =
        !isAgentActivityActionable(groupId) || (groupId === 'attention' && !unread)
            ? 'neutral'
            : groupId === 'attention'
              ? sessionUnreadTone(state)
              : presentation.tone;
    return {
        id: GLYPH_BY_STATE[state],
        label: presentation.label,
        toneClassName: TONE_TEXT_CLASSNAME[tone],
    };
}
