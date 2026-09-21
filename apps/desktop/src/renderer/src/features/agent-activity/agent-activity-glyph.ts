import type { AgentActivityState } from '@caxri/protocol';

import type { SessionActivityPresentation } from '../primary-sidebar/session-activity';
import {
    sessionActivityPresentation,
    sessionUnreadTone,
} from '../primary-sidebar/session-activity';
import type { AgentActivityRow } from './agent-activity-rows';
import { isAgentActivityActionable } from './agent-activity-rows';

export type AgentActivityGlyphId =
    'check' | 'dashed' | 'hollow' | 'question' | 'spinner' | 'unplug' | 'x';

export interface AgentActivityGlyph {
    id: AgentActivityGlyphId;
    /**
     * The words the glyph stands for. The row prints no state text, so this is both its accessible name and its hover
     * title — the only place a user can still read "Waiting for you".
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
 * "Idle" under "Idle" — three of the six groups repeated themselves verbatim, and the phrase cost the width the Project
 * name needed. The shape carries it instead, and {@link AgentActivityGlyph.label} carries the words.
 *
 * Tone still follows the list's two-tier rule unchanged ({@link isAgentActivityActionable}): only a row that asks the
 * user for something is tinted, so visual weight always means "this one wants you". An unread row is tinted by _why_ it
 * is unread rather than by what its Agent is doing now — `statusPresentation` answers the second question, and its
 * answer is `neutral` for a completed turn, the commonest attention reason of all.
 */
export function agentActivityGlyph(row: AgentActivityRow): AgentActivityGlyph {
    const { groupId, session, status, statusPresentation } = row;
    if (status.kind === 'detached')
        return { id: 'unplug', label: 'Detached', toneClassName: TONE_TEXT_CLASSNAME.neutral };
    // `running` folds in compaction, so the label comes from the live presentation rather than the stored state.
    if (status.kind === 'running')
        return {
            id: 'spinner',
            label: statusPresentation.label,
            toneClassName: TONE_TEXT_CLASSNAME.neutral,
        };
    const state: AgentActivityState =
        groupId === 'attention'
            ? (session.lastAttentionKind ?? 'unknown')
            : session.lastActivityState;
    const presentation = sessionActivityPresentation(state);
    const tone = !isAgentActivityActionable(groupId)
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
