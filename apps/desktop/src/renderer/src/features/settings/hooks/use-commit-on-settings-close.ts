import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

import { translate } from '../../../i18n';
import { useDialogStore } from '../../../stores/dialogs';
import { pushToast } from '../../../stores/toasts';
import type { ConfigKind } from '../config-edit';
import { CONFIG_FILE_NAMES } from '../config-edit';
import type { ConfigState } from '../settings-drafts';
import { invalidSourceDraft } from '../settings-drafts';

/**
 * Closing the page is a commit boundary, like switching section or view: a valid Source draft is written now. An
 * invalid one cannot be, and is kept rather than thrown away; the warning says so, and the next untargeted open lands
 * back on it (`invalidSourceDraft`).
 *
 * Observed on the dialog store instead of through a selector hook, so the open flag never re-renders the page
 * controller (and every row under it) when Settings opens or closes. The latest tab and view come through a ref.
 */
export function useCommitOnSettingsClose({
    commitSource,
    stateReference,
    tab,
    view,
}: {
    commitSource: (kind: ConfigKind) => void;
    stateReference: RefObject<ConfigState>;
    tab: ConfigKind;
    view: 'ui' | 'source';
}): void {
    const latestReference = useRef({ commitSource, tab, view });
    useEffect(() => {
        latestReference.current = { commitSource, tab, view };
    }, [commitSource, tab, view]);
    useEffect(
        () =>
            subscribeSettingsClose(() => {
                const latest = latestReference.current;
                if (latest.view === 'source') latest.commitSource(latest.tab);
                const invalidKind = invalidSourceDraft(stateReference.current);
                if (invalidKind)
                    pushToast(
                        'warning',
                        translate('settings.page.unsavedSource', {
                            file: CONFIG_FILE_NAMES[invalidKind],
                        }),
                    );
            }),
        [stateReference],
    );
}

/**
 * Calls `onClose` once each time the Settings page goes from open to closed, and never on open or unrelated changes.
 */
export function subscribeSettingsClose(onClose: () => void): () => void {
    return useDialogStore.subscribe((dialogs, previous) => {
        if (previous.settingsPageOpen && !dialogs.settingsPageOpen) onClose();
    });
}
