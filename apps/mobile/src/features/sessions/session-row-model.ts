import { DEFAULT_SESSION_TITLE } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { mobileAgentDisplayName } from './agent-display-name';
import type { MobileSessionItem } from './session-model';

/**
 * The title to show for a Session. Server Core stores an unnamed Session's placeholder as the English
 * `DEFAULT_SESSION_TITLE` (`Untitled`) because it is data shared with Desktop and the CLI, so the phone translates it
 * only at display time, as Desktop's `sessionTitleForDisplay` does. Rename drafts and search keep the stored title.
 */
export const sessionTitleForDisplay = (displayTitle: string, t: Translate = translate): string =>
    displayTitle === DEFAULT_SESSION_TITLE ? t('sessions.untitled') : displayTitle;

export const sessionAgentLabel = (session: MobileSessionItem, t: Translate = translate): string => {
    const kind = session.primaryTerminal?.kind;
    return kind ? mobileAgentDisplayName(kind) : t('sessions.noAgent');
};

const ageMinutes = (at: number, now: number): number =>
    Math.max(0, Math.floor((now - at) / 60_000));

/**
 * The compact age a Session row shows (`now`, `5m`, `2h`, `3d`). A Session row passes its last activity, the same clock
 * that orders it inside its group, so the ages read top to bottom from newest.
 */
export const sessionAgeLabel = (at: number, now: number, t: Translate = translate): string => {
    const minutes = ageMinutes(at, now);
    if (minutes < 1) return t('sessions.age.now');
    if (minutes < 60) return t('sessions.age.minutes', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('sessions.age.hours', { count: hours });
    return t('sessions.age.days', { count: Math.floor(hours / 24) });
};

/**
 * A past moment relative to now, as in `just now` or `5m ago`.
 */
const relativeAgeLabel = (at: number, now: number, t: Translate = translate): string =>
    ageMinutes(at, now) < 1
        ? t('sessions.age.justNow')
        : t('sessions.age.ago', { age: sessionAgeLabel(at, now, t) });

export const archivedAgeLabel = (
    archivedAt: number,
    now: number,
    t: Translate = translate,
): string => t('sessions.age.archived', { age: relativeAgeLabel(archivedAt, now, t) });

/**
 * How old a saved copy shown in place of a live read is, as in `Showing Sessions saved 5m ago.`
 */
export const savedAgeLabel = (savedAt: number, now: number, t: Translate = translate): string =>
    t('sessions.age.saved', { age: relativeAgeLabel(savedAt, now, t) });

/**
 * A Session's state for the screen reader. On a saved copy it says how old that state is, because a Session shown as
 * working may have finished since (`Working, as of 5m ago`).
 */
export const sessionStateLabel = (
    stateLabel: string,
    savedAt: number | null,
    now: number,
    t: Translate = translate,
): string => {
    if (savedAt === null) return stateLabel;
    return t('sessions.age.stateAsOf', {
        age: relativeAgeLabel(savedAt, now, t),
        state: stateLabel,
    });
};

/**
 * Which mark the Session status slot shows. A saved copy cannot know a Session is still running, so it never spins:
 * `running-saved` is a still glyph. While the open Chat compacts its context (`isCompacting`), its timeline already
 * says `Compacting context…`, so the slot stays empty instead of spinning as if the Agent were working on a task.
 */
export const sessionStatusGlyphKind = (
    session: Pick<MobileSessionItem, 'hasUnread' | 'lastActivityState'>,
    isSaved: boolean,
    isCompacting = false,
): 'attention' | 'running' | 'running-saved' | 'failed' | null => {
    if (session.hasUnread) return 'attention';
    if (session.lastActivityState === 'running') {
        if (isCompacting) return null;
        return isSaved ? 'running-saved' : 'running';
    }
    if (session.lastActivityState === 'failed') return 'failed';
    return null;
};
