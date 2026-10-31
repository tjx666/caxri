import { useState } from 'react';

import type { MobileTreeItemAction } from '@caxri/protocol';

import { Chip } from '../../components/chip';
import { ConfirmSheet } from '../../components/confirm-sheet';
import { Spinner } from '../../components/spinner';
import { showToast } from '../../components/toast-store';
import { useTranslation } from '../../i18n';
import { openExternalLink } from '../../lib/open-external-link';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import { runTreeAction, treeActionTint } from './tree-item-actions';
import { TreeItemIcon } from './tree-item-icon';

/**
 * One inline action of a tree row, such as the Status panel's per-repository `Merge`, drawn as Desktop draws it: a
 * labeled pill when the provider labeled it, otherwise its glyph alone, tinted by its tone. A provider confirmation
 * (failing checks, unmet protection) asks first in the app's confirmation sheet. The pill shows a spinner and takes no
 * second press until the command settles.
 */
export const TreeItemActionButton = ({
    action,
    onOpenChat,
    sessionId,
    testID,
    theme,
}: {
    action: MobileTreeItemAction;
    onOpenChat?: () => void;
    sessionId: string;
    testID: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { request } = useMobileClient();
    const [isBusy, setBusy] = useState(false);
    const [isConfirming, setConfirming] = useState(false);
    const tint = treeActionTint(action.tone, theme);
    const run = () => {
        setBusy(true);
        void runTreeAction(action, {
            execute: (commandId, arguments_) =>
                request('mobile.tree.executeCommand', {
                    sessionId,
                    commandId,
                    arguments: arguments_,
                }),
            notify: showToast,
            openChat: onOpenChat,
            openLink: (url) => openExternalLink(url),
            t,
        }).finally(() => setBusy(false));
    };
    return (
        <>
            <Chip
                accessibilityHint={action.tooltip}
                accessibilityLabel={action.label ?? action.command.title}
                disabled={isBusy}
                label={action.label}
                onPress={() => (action.confirmation ? setConfirming(true) : run())}
                testID={testID}
                theme={theme}
                tint={tint}
            >
                {isBusy ? (
                    <Spinner color={tint} size={16} />
                ) : action.icon ? (
                    <TreeItemIcon icon={{ ...action.icon, color: tint }} theme={theme} />
                ) : null}
            </Chip>
            {isConfirming && action.confirmation ? (
                <ConfirmSheet
                    confirmLabel={action.confirmation.confirmLabel}
                    detail={action.confirmation.message}
                    onClose={() => setConfirming(false)}
                    onConfirm={run}
                    testID={`${testID}-confirm`}
                    theme={theme}
                    title={action.confirmation.title}
                    tone="primary"
                />
            ) : null}
        </>
    );
};
