import { DEFAULT_SESSION_TITLE } from '@caxri/protocol';

import type { Translate } from '../../i18n';

/**
 * The title to show for a Session. Server Core stores the placeholder of an unnamed Session as the English
 * `DEFAULT_SESSION_TITLE` (`Untitled`) because it is data, shared with the CLI and mobile; the Renderer translates it
 * only at display time. Every other title is the user's or the Agent's own text and is shown unchanged.
 *
 * Pass `t` from `useTranslation()` in components and `translate` outside React. Matching, sorting, and rename requests
 * keep using the stored `displayTitle`.
 */
export function sessionTitleForDisplay(displayTitle: string, t: Translate): string {
    return displayTitle === DEFAULT_SESSION_TITLE ? t('session.untitled') : displayTitle;
}
