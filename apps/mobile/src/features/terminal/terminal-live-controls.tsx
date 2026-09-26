import type { TextInput as TextInputHandle } from 'react-native';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';

import { ArrowDown, Keyboard, RotateCw, X } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import type { TerminalKey } from './key-input';
import { TerminalKeyBar } from './terminal-key-bar';
import { terminalViewStyles as styles } from './terminal-view-styles';
import type { useLiveTerminal } from './use-live-terminal';

type LiveTerminal = ReturnType<typeof useLiveTerminal>;

/**
 * An invisible field that turns the system keyboard into Terminal keystrokes. Android's `visible-password` keyboard
 * type disables IME composition, prediction, and autocorrect, so every key commits immediately — the same approach
 * dedicated Android terminals use. Composed Chinese text belongs in the Agent composer instead, where it is submitted
 * as one message.
 */
export const TerminalKeyboardInput = ({
    inputReference,
    terminal,
}: {
    inputReference: React.RefObject<TextInputHandle | null>;
    terminal: LiveTerminal;
}) => (
    <TextInput
        ref={inputReference}
        accessibilityLabel="Terminal keyboard"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        caretHidden
        contextMenuHidden
        editable={terminal.canControl}
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'ascii-capable'}
        onChangeText={(text) => {
            // eslint-disable-next-line no-void -- The hook reports delivery failures in the Terminal status.
            if (text) void terminal.typeText(text);
        }}
        onKeyPress={({ nativeEvent }) => {
            // eslint-disable-next-line no-void -- The hook reports delivery failures in the Terminal status.
            if (nativeEvent.key === 'Backspace') void terminal.typeText('\u{7F}');
        }}
        onSubmitEditing={() => {
            // eslint-disable-next-line no-void -- The hook reports delivery failures in the Terminal status.
            void terminal.typeText('\r');
        }}
        spellCheck={false}
        style={styles.hiddenInput}
        submitBehavior="submit"
        testID="terminal-input"
        value=""
    />
);

/**
 * Status that must interrupt the screen floats as a compact chip over the Terminal instead of stacking rows under it.
 */
export const TerminalStatusChip = ({
    role,
    terminal,
    theme,
}: {
    role: 'view' | 'reply' | 'control' | null;
    terminal: LiveTerminal;
    theme: MobileTheme;
}) => {
    const label =
        terminal.error ??
        {
            loading: 'Loading Terminal…',
            ready: role === 'control' ? null : 'View only on this device',
            stale: 'Connection lost · showing the last frame',
            stopped: 'Terminal has stopped',
            unavailable: 'Terminal is unavailable',
            error: 'Unable to load the Terminal',
        }[terminal.state];
    if (!label) return null;
    const isError = terminal.error !== null || terminal.state === 'error';
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
                    accessibilityLabel="Retry Terminal"
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
    const canTakeOver = terminal.canControl && terminal.hasSize;
    return (
        <View pointerEvents="box-none" style={styles.floating}>
            {terminal.atBottom ? null : (
                <Pressable
                    accessibilityLabel="Jump to latest Terminal output"
                    accessibilityRole="button"
                    onPress={terminal.jump}
                    style={[
                        styles.floatingRound,
                        { backgroundColor: theme.elevated, borderColor: theme.border },
                    ]}
                    testID="terminal-jump-latest"
                >
                    <ArrowDown color={theme.text} size={20} />
                </Pressable>
            )}
            {terminal.hasLease || !terminal.canControl ? null : (
                <Pressable
                    accessibilityHint="Sizes the shared Terminal for this phone and opens the keyboard."
                    accessibilityLabel="Take over Terminal"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canTakeOver }}
                    disabled={!canTakeOver}
                    onPress={onTakeOver}
                    style={[
                        styles.floatingPill,
                        { backgroundColor: theme.primary, opacity: canTakeOver ? 1 : 0.45 },
                    ]}
                    testID="terminal-take-over"
                >
                    <Keyboard color={theme.primaryForeground} size={18} strokeWidth={2.25} />
                    <Text style={[styles.floatingLabel, { color: theme.primaryForeground }]}>
                        Take over
                    </Text>
                </Pressable>
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
    const onKey = (key: TerminalKey): void => {
        // eslint-disable-next-line no-void -- The hook owns the visible error state for failed input.
        void terminal.pressKey(key);
    };
    return (
        <View style={[styles.controlBar, { borderColor: theme.border }]}>
            <TerminalKeyBar
                canControl={terminal.canControl}
                ctrl={terminal.ctrl}
                onKey={onKey}
                onPaste={() => {
                    // eslint-disable-next-line no-void -- Clipboard errors are rendered by the hook.
                    void terminal.paste();
                }}
                theme={theme}
            />
            <IconButton
                accessibilityLabel="Show or hide keyboard"
                icon={Keyboard}
                onPress={onToggleKeyboard}
                size={20}
                testID="terminal-keyboard-toggle"
                theme={theme}
            />
            <IconButton
                accessibilityHint="Returns the Terminal to your computer's size."
                accessibilityLabel="Release Terminal"
                icon={X}
                onPress={() => {
                    // eslint-disable-next-line no-void -- The hook reports release failures in the UI.
                    void terminal.release();
                }}
                size={20}
                testID="terminal-release"
                theme={theme}
            />
        </View>
    );
};
