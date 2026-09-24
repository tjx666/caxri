import { Pressable, Text, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { terminalViewStyles as styles } from './terminal-view-styles';
import type { useLiveTerminal } from './use-live-terminal';

const stateLabel = {
    loading: 'Loading Terminal…',
    ready: null,
    stale: 'Connection lost. Showing the last Terminal frame. Keys are disabled.',
    stopped: 'Terminal has stopped.',
    unavailable: 'Terminal is unavailable.',
    error: 'Unable to load the Terminal. Retry to reconnect.',
} as const;

interface TerminalStatusProperties {
    role: 'view' | 'reply' | 'control' | null;
    terminal: ReturnType<typeof useLiveTerminal>;
    theme: MobileTheme;
}

export const TerminalLeaseBanner = ({ terminal, theme }: Omit<TerminalStatusProperties, 'role'>) =>
    terminal.hasLease ? (
        <View style={[styles.leaseBanner, { backgroundColor: theme.surface }]}>
            <Text style={[styles.leaseText, { color: theme.text }]}>
                Sized for this phone. Your computer&apos;s view is resized until you release.
            </Text>
            <Pressable
                accessibilityHint="Restores the computer's Terminal size."
                accessibilityLabel="Release Terminal size"
                accessibilityRole="button"
                onPress={() => {
                    // eslint-disable-next-line no-void -- The hook reports release failures in the UI.
                    void terminal.release();
                }}
                style={styles.toolbarButton}
                testID="terminal-release"
            >
                <Text style={[styles.toolbarLabel, { color: theme.primary }]}>Release</Text>
            </Pressable>
        </View>
    ) : null;

export const TerminalLiveStatus = ({ role, terminal, theme }: TerminalStatusProperties) => (
    <>
        {stateLabel[terminal.state] ? (
            <View
                style={[styles.status, { backgroundColor: theme.surface }]}
                testID={`terminal-${terminal.state}`}
            >
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    {stateLabel[terminal.state]}
                </Text>
            </View>
        ) : null}
        {terminal.error ? (
            <View style={styles.status}>
                <Text
                    accessibilityRole="alert"
                    style={[styles.statusText, { color: theme.danger }]}
                >
                    {terminal.error}
                </Text>
            </View>
        ) : null}
        {role !== 'control' ? (
            <View style={styles.status} testID="terminal-read-only">
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    This device can view the Terminal. Pair it with control access to type or take
                    over.
                </Text>
            </View>
        ) : null}
    </>
);
