import { useRef } from 'react';
import type { HostInstance } from 'react-native';
import { View } from 'react-native';

import type { MobilePreviewTarget } from '@caxri/protocol';
import { Globe } from 'lucide-react-native';

import { Chip } from '../../components/chip';
import { PopoverAction, PopoverMenu } from '../../components/popover-menu';
import { Spinner } from '../../components/spinner';
import { usePopoverAnchor } from '../../components/use-popover-anchor';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import type { SessionPreviews } from './use-open-preview';

/**
 * The Session header's preview entry when the Session has no pull request: `Preview :5173` (or `Preview · 2` for
 * several ports, which open a menu to choose one). It appears only while a process of this Session listens on a port (a
 * dev server the Agent started) and opens the page in the in-app browser through the computer's preview proxy. With a
 * pull request the header carries only that chip and lists the same ports in its menu (`PreviewMenuActions`). The idea
 * follows QuickTUI's Port Forwarding; see `docs/mobile/preview.md`.
 */
export const PreviewChip = ({
    onOpen,
    previews,
    theme,
}: {
    onOpen: (target: MobilePreviewTarget) => Promise<void>;
    previews: SessionPreviews;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const anchor = useRef<HostInstance>(null);
    const menu = usePopoverAnchor(anchor);
    const { targets } = previews;
    if (targets.length === 0) return null;
    const [first] = targets;
    const isSingle = targets.length === 1;
    return (
        <>
            <View collapsable={false} ref={anchor}>
                <Chip
                    accessibilityHint={t('browser.preview.chipHint')}
                    accessibilityLabel={
                        isSingle
                            ? t('browser.preview.chipOne', { port: first.port })
                            : t('browser.preview.chipMany', { count: targets.length })
                    }
                    label={
                        isSingle
                            ? t('browser.preview.chipLabel', { port: first.port })
                            : t('browser.preview.chipLabelMany', { count: targets.length })
                    }
                    onPress={() => {
                        if (previews.openingPort !== null) return;
                        if (isSingle) void onOpen(first);
                        else menu.open();
                    }}
                    testID="preview-chip"
                    theme={theme}
                >
                    {previews.openingPort === null ? (
                        <Globe color={theme.muted} size={16} />
                    ) : (
                        <Spinner color={theme.muted} size={16} testID="preview-chip-opening" />
                    )}
                </Chip>
            </View>
            <PopoverMenu
                closeLabel={t('browser.preview.closeMenu')}
                onClose={menu.close}
                placement={menu.placement}
                theme={theme}
            >
                {targets.map((target) => (
                    <PopoverAction
                        accessibilityHint={target.processName}
                        icon={Globe}
                        key={target.port}
                        label={t('browser.preview.menuOpen', { port: target.port })}
                        onPress={() => {
                            menu.close();
                            void onOpen(target);
                        }}
                        testID={`preview-target-${target.port}`}
                        theme={theme}
                    />
                ))}
            </PopoverMenu>
        </>
    );
};

/**
 * One `Open preview · :5173` row per previewable port, for the Session header's menu when a pull request holds the
 * inline slot.
 */
export const PreviewMenuActions = ({
    onClose,
    onOpen,
    previews,
    theme,
}: {
    onClose: () => void;
    onOpen: (target: MobilePreviewTarget) => Promise<void>;
    previews: SessionPreviews;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return previews.targets.map((target) => (
        <PopoverAction
            accessibilityHint={target.processName}
            disabled={previews.openingPort !== null}
            icon={Globe}
            key={target.port}
            label={t('browser.preview.menuOpen', { port: target.port })}
            onPress={() => {
                onClose();
                void onOpen(target);
            }}
            testID={`session-menu-preview-${target.port}`}
            theme={theme}
        />
    ));
};
