/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useRef } from 'react';
import type { HostInstance } from 'react-native';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { MobilePreviewTarget } from '@caxri/protocol';
import { Globe } from 'lucide-react-native';

import { PopoverMenu } from '../../components/popover-menu';
import { Spinner } from '../../components/spinner';
import { usePopoverAnchor } from '../../components/use-popover-anchor';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { useSessionPreviews } from './use-session-previews';

/**
 * Matches the pull request chip beside it: 28dp tall with slop up to the 48dp touch target.
 */
const CHIP_HIT_SLOP = { bottom: 10, left: 10, right: 10, top: 10 };

/**
 * The Session header's preview entry. It appears only while a process of this Session listens on a port (a dev server
 * the Agent started), names that port, and opens the page in the in-app browser through the computer's preview proxy.
 * Several ports open a menu to choose one. The idea follows QuickTUI's Port Forwarding; see `docs/mobile/preview.md`.
 */
export const PreviewChip = ({
    deviceRole,
    sessionId,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const previews = useSessionPreviews(sessionId, deviceRole);
    const anchor = useRef<HostInstance>(null);
    const menu = usePopoverAnchor(anchor);
    const { targets } = previews;
    if (targets.length === 0) return null;
    const [first] = targets;
    const isSingle = targets.length === 1;
    const open = async (target: MobilePreviewTarget): Promise<void> => {
        if (!(await previews.open(target)))
            Alert.alert(t('browser.preview.openFailedTitle'), t('browser.preview.openFailedBody'));
    };
    return (
        <>
            <View collapsable={false} ref={anchor}>
                <Pressable
                    accessibilityHint={t('browser.preview.chipHint')}
                    accessibilityLabel={
                        isSingle
                            ? t('browser.preview.chipOne', { port: first.port })
                            : t('browser.preview.chipMany', { count: targets.length })
                    }
                    accessibilityRole="button"
                    accessibilityState={{ busy: previews.openingPort !== null }}
                    disabled={previews.openingPort !== null}
                    hitSlop={CHIP_HIT_SLOP}
                    onPress={() => {
                        if (isSingle) void open(first);
                        else menu.open();
                    }}
                    style={({ pressed }) => [
                        styles.chip,
                        { backgroundColor: theme.elevated, opacity: pressed ? 0.7 : 1 },
                    ]}
                    testID="preview-chip"
                >
                    {previews.openingPort === null ? (
                        <Globe color={theme.muted} size={15} />
                    ) : (
                        <Spinner color={theme.muted} size={15} testID="preview-chip-opening" />
                    )}
                    <Text style={[styles.label, { color: theme.text }]}>
                        {isSingle
                            ? first.port
                            : t('browser.preview.portCount', { count: targets.length })}
                    </Text>
                </Pressable>
            </View>
            <PopoverMenu
                closeLabel={t('browser.preview.closeMenu')}
                onClose={menu.close}
                placement={menu.placement}
                theme={theme}
            >
                {targets.map((target) => (
                    <Pressable
                        key={target.port}
                        accessibilityRole="button"
                        onPress={() => {
                            menu.close();
                            void open(target);
                        }}
                        style={({ pressed }) => [
                            styles.menuAction,
                            pressed && { backgroundColor: theme.elevated },
                        ]}
                        testID={`preview-target-${target.port}`}
                    >
                        <Globe color={theme.muted} size={18} />
                        <Text style={[styles.menuPort, { color: theme.text }]}>{target.port}</Text>
                        <Text
                            numberOfLines={1}
                            style={[styles.menuProcess, { color: theme.muted }]}
                        >
                            {target.processName}
                        </Text>
                    </Pressable>
                ))}
            </PopoverMenu>
        </>
    );
};

const styles = StyleSheet.create({
    chip: {
        alignItems: 'center',
        borderRadius: 14,
        flexDirection: 'row',
        gap: 5,
        height: 28,
        paddingHorizontal: 9,
    },
    label: { fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '600' },
    menuAction: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        minHeight: 48,
        minWidth: 200,
        paddingHorizontal: 16,
    },
    menuPort: { fontSize: 15, fontVariant: ['tabular-nums'], fontWeight: '600' },
    menuProcess: { flexShrink: 1, fontSize: 14 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
