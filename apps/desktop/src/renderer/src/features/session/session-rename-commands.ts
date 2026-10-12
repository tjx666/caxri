import { translate } from '../../i18n';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { requestSessionRename } from '../../stores/dialogs';
import { getSelectedSession } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import { canSuggestSessionTitle } from '../primary-sidebar/session-rename-draft';

/**
 * Puts the selected Session's sidebar row into rename mode. The rename editor _is_ that row, so a hidden Primary Side
 * Bar is revealed first rather than letting the command type into a surface nobody can see; the same reveal
 * `beginSessionCreation` performs before opening its anchored menu.
 */
export function renameSelectedSession(): void {
    const session = getSelectedSession();
    if (!session) return;
    if (!useChromeLayoutStore.getState().primarySidebarVisible)
        useChromeLayoutStore.getState().setPrimarySidebarVisible(true);
    requestSessionRename(session.id);
}

/**
 * `session.renameWithAi`: the selected Session's Rename with AI, the row's `Shift+Enter`, reached from the palette. It
 * opens the same inline editor and fills it with the suggestion, so nothing is saved until the user accepts it.
 */
export function renameSelectedSessionWithAi(): void {
    const session = getSelectedSession();
    if (!session) return;
    if (!canSuggestSessionTitle(session)) {
        pushToast('info', translate('session.rename.noConversation'));
        return;
    }
    if (!useChromeLayoutStore.getState().primarySidebarVisible)
        useChromeLayoutStore.getState().setPrimarySidebarVisible(true);
    requestSessionRename(session.id, { suggest: true });
}
