import { useEffect, useRef, useState } from 'react';
import type { TextInputInstance } from 'react-native';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';

import { ArrowDown, Keyboard, RotateCw, Undo2 } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import { useTranslation } from '../../i18n';
import { chipHitSlop, PRESSED_OPACITY } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import type { TerminalKey } from './key-input';
import type { MobileTerminalExitPresentation } from './terminal-exit-presentation';
import { TerminalKeyBar } from './terminal-key-bar';
import { floatingShadow, terminalViewStyles as styles } from './terminal-view-styles';
import type { useLiveTerminal } from './use-live-terminal';

type LiveTerminal = ReturnType<typeof useLiveTerminal>;

const LEASE_HINT_MS = 5000;

/**
 * An invisible field that turns the system keyboard into Terminal keystrokes. Android's `visible-password` keyboard
 * type disables IME composition, prediction, and autocorrect, so every key commits immediately: the same approach
 * dedicated Android terminals use. Composed Chinese text belongs in the Agent composer instead, where it is submitted
 * as one message.
 */
export const TerminalKeyboardInput = ({
    inputReference,
    terminal,
}: {
    inputReference: React.RefObject<TextInputInstance | null>;
    terminal: LiveTerminal;
}) => {
    const { t } = useTranslation();
    return (
        <TextInput
            ref={inputReference}
            accessibilityLabel={t('terminal.keyboardInput')}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            caretHidden
            contextMenuHidden
            editable={terminal.canControl}
            keyboardType={Platform.OS === 'android' ? 'visible-password' : 'ascii-capable'}
            onChangeText={(text) => {
                if (text) void terminal.typeText(text);
            }}
            onKeyPress={({ nativeEvent }) => {
                if (nativeEvent.key === 'Backspace') void terminal.typeText('\u{7F}');
            }}
            onSubmitEditing={() => {
                void terminal.typeText('\r');
            }}
            spellCheck={false}
            style={styles.hiddenInput}
            submitBehavior="submit"
            testID="terminal-input"
            value=""
        />
    );
};

/**
 * Status that must interrupt the screen floats as a compact chip over the Terminal instead of stacking rows under it.
 */
export const TerminalStatusChip = ({
    exitPresentation,
    isConnected,
    role,
    terminal,
    theme,
}: {
    /**
     * The specific reason a stopped Terminal exited, so a crash reads differently from a clean exit instead of both
     * sharing the generic "Terminal has stopped" copy. Falls back to that generic muted copy when the caller has not
     * threaded the Session's `primaryTerminal.lastProcessState` through yet.
     */
    exitPresentation?: MobileTerminalExitPresentation;
    /**
     * While the phone is offline the app-wide Reconnecting banner already explains the frozen frame.
     */
    isConnected: boolean;
    role: 'view' | 'reply' | 'control' | null;
    terminal: LiveTerminal;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const stopped = exitPresentation ?? {
        label: t('terminal.exit.stopped'),
        tone: 'muted' as const,
    };
    const label =
        terminal.error ??
        {
            loading: t('terminal.loading'),
            ready: role === 'control' ? null : t('terminal.viewOnly'),
            stale: isConnected ? t('terminal.stale') : null,
            stopped: stopped.label,
            unavailable: t('terminal.unavailable'),
            error: t('terminal.loadFailed'),
        }[terminal.state];
    if (!label) return null;
    const isError =
        terminal.error !== null ||
        terminal.state === 'error' ||
        (terminal.state === 'stopped' && stopped.tone === 'danger');
    return (
        <View
            accessibilityRole={isError ? 'alert' : undefined}
            style={[
                styles.statusChip,
                { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
            testID={
                terminal.error
                    ? 'terminal-error'
                    : role !== 'control' && terminal.state === 'ready'
                      ? 'terminal-read-only'
                      : `terminal-${terminal.state}`
            }
        >
            <Text
                numberOfLines={2}
                style={[styles.statusText, { color: isError ? theme.danger : theme.muted }]}
            >
                {label}
            </Text>
            {terminal.state === 'error' ? (
                <IconButton
                    accessibilityLabel={t('terminal.retry')}
                    icon={RotateCw}
                    onPress={terminal.retry}
                    size={18}
                    testID="terminal-retry"
                    theme={theme}
                />
            ) : null}
        </View>
    );
};

/**
 * Floating actions for the watch-only state: jump back to live output, and take over to type.
 */
export const TerminalFloatingActions = ({
    onTakeOver,
    terminal,
    theme,
}: {
    onTakeOver: () => void;
    terminal: LiveTerminal;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const canTakeOver = terminal.canControl && terminal.hasSize;
    return (
        <View pointerEvents="box-none" style={styles.floating}>
            {terminal.atBottom ? null : (
                <Pressable
                    accessibilityLabel={t('terminal.jumpToLatest')}
                    accessibilityRole="button"
                    hitSlop={4}
                    onPress={terminal.jump}
                    style={[
                        styles.floatingRound,
                        {
                            backgroundColor: theme.elevated,
                            borderColor: theme.border,
                            boxShadow: floatingShadow(theme.shadow),
                        },
                    ]}
                    testID="terminal-jump-latest"
                >
                    <ArrowDown color={theme.text} size={20} />
                </Pressable>
            )}
            {terminal.hasLease || !terminal.canControl ? null : (
                <View style={styles.takeOverGroup}>
                    {/* Visible disclosure of the same side effect `accessibilityHint` already gives a screen reader,
                    so a sighted user learns it too instead of only finding out after tapping. Hidden from assistive
                    tech to avoid announcing the same fact twice. */}
                    <View
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={[styles.takeOverCaption, { backgroundColor: theme.elevated }]}
                    >
                        <Text style={[styles.takeOverCaptionText, { color: theme.muted }]}>
                            {t('terminal.takeOverCaption')}
                        </Text>
                    </View>
                    <Pressable
                        accessibilityHint={t('terminal.takeOverHint')}
                        accessibilityLabel={t('terminal.takeOverLabel')}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canTakeOver }}
                        disabled={!canTakeOver}
                        hitSlop={chipHitSlop}
                        onPress={onTakeOver}
                        style={({ pressed }) => [
                            styles.floatingPill,
                            {
                                backgroundColor: theme.primary,
                                boxShadow: floatingShadow(theme.shadow),
                                opacity: canTakeOver ? (pressed ? PRESSED_OPACITY : 1) : 0.4,
                            },
                        ]}
                        testID="terminal-take-over"
                    >
                        <Keyboard color={theme.primaryForeground} size={18} strokeWidth={2.25} />
                        <Text style={[styles.floatingLabel, { color: theme.primaryForeground }]}>
                            {t('terminal.takeOver')}
                        </Text>
                    </Pressable>
                </View>
            )}
        </View>
    );
};

/**
 * The only chrome left while this phone controls the Terminal: one scrolling row of keys the soft keyboard lacks, plus
 * fixed keyboard and release buttons.
 */
export const TerminalControlBar = ({
    onToggleKeyboard,
    terminal,
    theme,
}: {
    onToggleKeyboard: () => void;
    terminal: LiveTerminal;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const onKey = (key: TerminalKey): void => {
        void terminal.pressKey(key);
    };
    return (
        <View style={[styles.controlBar, { borderColor: theme.border }]}>
            <TerminalKeyBar
                canControl={terminal.canControl}
                ctrl={terminal.ctrl}
                onKey={onKey}
                onPaste={() => {
                    void terminal.paste();
                }}
                theme={theme}
            />
            <IconButton
                accessibilityLabel={t('terminal.toggleKeyboard')}
                icon={Keyboard}
                onPress={onToggleKeyboard}
                size={20}
                testID="terminal-keyboard-toggle"
                theme={theme}
            />
            <Pressable
                accessibilityHint={t('terminal.releaseHint')}
                accessibilityLabel={t('terminal.release')}
                accessibilityRole="button"
                hitSlop={chipHitSlop}
                onPress={() => {
                    void terminal.release();
                }}
                style={({ pressed }) => [
                    styles.releaseButton,
                    { borderColor: theme.border, opacity: pressed ? PRESSED_OPACITY : 1 },
                ]}
                testID="terminal-release"
            >
                <Undo2 color={theme.text} size={16} />
                <Text style={[styles.releaseLabel, { color: theme.text }]}>
                    {t('terminal.releaseLabel')}
                </Text>
            </Pressable>
        </View>
    );
};

/**
 * Tells the reader once that the phone, not the computer, now sizes the Terminal. A control device takes over on its
 * own (see `shouldAutoTakeOverTerminal`), so without this note the Terminal would reflow with no explanation. It shows
 * for a few seconds the first time this view holds the size and never again for the view's lifetime.
 */
export const TerminalLeaseHint = ({
    hasLease,
    theme,
}: {
    hasLease: boolean;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const hasShown = useRef(false);
    const [isShown, setShown] = useState(false);
    useEffect(() => {
        if (!hasLease || hasShown.current) return;
        hasShown.current = true;
        setShown(true);
        const timer = setTimeout(() => setShown(false), LEASE_HINT_MS);
        return () => {
            clearTimeout(timer);
            setShown(false);
        };
    }, [hasLease]);
    if (!isShown || !hasLease) return null;
    return (
        <View
            accessibilityLiveRegion="polite"
            pointerEvents="none"
            style={[
                styles.leaseHint,
                { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
            testID="terminal-lease-hint"
        >
            <Text numberOfLines={1} style={[styles.statusText, { color: theme.muted }]}>
                {t('terminal.leaseHint')}
            </Text>
        </View>
    );
};
