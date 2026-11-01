/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { MobileTreeItemAction } from '@caxri/protocol';

import { Chip } from '../../components/chip';
import { ConfirmSheet } from '../../components/confirm-sheet';
import { Spinner } from '../../components/spinner';
import { showToast } from '../../components/toast-store';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { openExternalLink } from '../../lib/open-external-link';
import { PRESSED_OPACITY } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { TreeActionBlocker } from './tree-item-actions';
import { runTreeAction, treeActionBlocker, treeActionTint } from './tree-item-actions';
import { TreeItemIcon } from './tree-item-icon';

const BLOCKER_REASONS = {
    needsControl: 'pullRequest.needsControl',
    offline: 'pullRequest.offline',
} as const satisfies Record<TreeActionBlocker, TranslationKey>;

/**
 * One inline action of a tree row, such as the Status panel's per-repository `Merge`, drawn as Desktop draws it: a
 * labeled pill when the provider labeled it, otherwise its glyph alone, tinted by its tone. A provider confirmation
 * (failing checks, unmet protection) asks first in the app's confirmation sheet. The pill shows a spinner and takes no
 * second press until the command settles.
 */
export const TreeItemActionButton = ({
    action,
    deviceRole,
    onOpenChat,
    sessionId,
    testID,
    theme,
}: {
    action: MobileTreeItemAction;
    deviceRole: 'control' | 'reply' | 'view' | null;
    onOpenChat?: () => void;
    sessionId: string;
    testID: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { request, status } = useMobileClient();
    const [isBusy, setBusy] = useState(false);
    const [isConfirming, setConfirming] = useState(false);
    const tint = treeActionTint(action.tone, theme);
    const blocker = treeActionBlocker(action.command.id, deviceRole, status === 'connected');
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
    const chip = (
        <Chip
            accessibilityHint={blocker ? t(BLOCKER_REASONS[blocker]) : action.tooltip}
            accessibilityLabel={action.label ?? action.command.title}
            disabled={isBusy}
            label={action.label}
            onPress={() => {
                if (blocker) showToast('error', t(BLOCKER_REASONS[blocker]));
                else if (action.confirmation) setConfirming(true);
                else run();
            }}
            testID={testID}
            theme={theme}
            tint={blocker ? theme.muted : tint}
        >
            {isBusy ? (
                <Spinner color={tint} size={16} />
            ) : action.icon ? (
                <TreeItemIcon
                    icon={{ ...action.icon, color: blocker ? theme.muted : tint }}
                    theme={theme}
                />
            ) : null}
        </Chip>
    );
    return (
        <>
            {/* A blocked action stays tappable so the press can say why; the dim look marks it disabled. */}
            {blocker ? <View style={styles.blocked}>{chip}</View> : chip}
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

const styles = StyleSheet.create({ blocked: { opacity: PRESSED_OPACITY } });

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
