import { translate } from '../../i18n';
import type { ContextMenuEntries } from '../../lib/context-menu';
import { getOpenSessionIds } from '../../stores/open-sessions';
import { closeSessionTabs } from './session-tab-commands';
import { sessionIdsToClose } from './session-tabs-state';

/**
 * The right-click menu of an Open Session tab. Every entry only edits the strip; none touches the Session itself, which
 * stays in the sidebar. Read when the menu opens, so "Close Tabs to the Right" reflects the strip as it is then.
 */
export function sessionTabMenu(sessionId: string): ContextMenuEntries {
    const ids = getOpenSessionIds();
    /**
     * Fire-and-forget: closing toasts its own failure.
     */
    const close = (scope: 'one' | 'others' | 'right') => () => {
        // eslint-disable-next-line no-void -- intentional floating-promise discard
        void closeSessionTabs(sessionId, scope);
    };
    return [
        {
            label: translate('sessionTabs.close'),
            disabled: sessionIdsToClose(ids, sessionId, 'one').length === 0,
            onSelect: close('one'),
        },
        {
            label: translate('sessionTabs.closeOthers'),
            disabled: sessionIdsToClose(ids, sessionId, 'others').length === 0,
            onSelect: close('others'),
        },
        {
            label: translate('sessionTabs.closeToRight'),
            disabled: sessionIdsToClose(ids, sessionId, 'right').length === 0,
            onSelect: close('right'),
        },
    ];
}
