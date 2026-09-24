import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import type { TerminalKey } from './key-input';
import { TerminalKeyBar } from './terminal-key-bar';
import { TerminalLiveStatus } from './terminal-live-status';
import { terminalViewStyles as styles } from './terminal-view-styles';
import type { useLiveTerminal } from './use-live-terminal';

interface TerminalControlsProperties {
    role: 'view' | 'reply' | 'control' | null;
    terminal: ReturnType<typeof useLiveTerminal>;
    theme: MobileTheme;
}

const TerminalToolbar = ({
    terminal,
    theme,
}: Pick<TerminalControlsProperties, 'terminal' | 'theme'>) => (
    <View style={styles.toolbar}>
        {!terminal.hasLease ? (
            <Pressable
                accessibilityHint="Temporarily sizes the shared Terminal for this phone."
                accessibilityLabel="Take over Terminal size"
                accessibilityRole="button"
                accessibilityState={{ disabled: !terminal.canControl || !terminal.hasSize }}
                disabled={!terminal.canControl || !terminal.hasSize}
                onPress={() => {
                    // eslint-disable-next-line no-void -- The hook reports takeover failures in the UI.
                    void terminal.takeOver();
                }}
                style={styles.toolbarButton}
                testID="terminal-take-over"
            >
                <Text style={[styles.toolbarLabel, { color: theme.primary }]}>Take over</Text>
            </Pressable>
        ) : null}
        {!terminal.atBottom ? (
            <Pressable
                accessibilityLabel="Jump to latest Terminal output"
                accessibilityRole="button"
                onPress={terminal.jump}
                style={styles.toolbarButton}
                testID="terminal-jump-latest"
            >
                <Text style={[styles.toolbarLabel, { color: theme.primary }]}>Jump to latest</Text>
            </Pressable>
        ) : null}
        {terminal.state === 'error' ? (
            <Pressable
                accessibilityLabel="Retry Terminal"
                accessibilityRole="button"
                onPress={terminal.retry}
                style={styles.toolbarButton}
                testID="terminal-retry"
            >
                <Text style={[styles.toolbarLabel, { color: theme.primary }]}>Retry</Text>
            </Pressable>
        ) : null}
    </View>
);

const TerminalTextEntry = ({
    terminal,
    theme,
}: Pick<TerminalControlsProperties, 'terminal' | 'theme'>) => {
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const sendText = async (): Promise<void> => {
        if (!draft || sending) return;
        setSending(true);
        try {
            if ((await terminal.sendInput(draft)) === 'sent') setDraft('');
        } finally {
            setSending(false);
        }
    };
    const onKey = (key: TerminalKey): void => {
        // eslint-disable-next-line no-void -- The hook owns the visible error state for failed input.
        void terminal.pressKey(key);
    };

    return (
        <>
            <View style={styles.textInputRow}>
                <TextInput
                    accessibilityHint="Types text into the Terminal. Use the Enter key to submit it."
                    accessibilityLabel="Terminal text input"
                    editable={terminal.canControl && !sending}
                    multiline
                    onChangeText={setDraft}
                    placeholder="Type into Terminal"
                    placeholderTextColor={theme.muted}
                    style={[
                        styles.textInput,
                        {
                            backgroundColor: theme.surface,
                            borderColor: theme.border,
                            color: theme.text,
                        },
                    ]}
                    testID="terminal-input"
                    value={draft}
                />
                <Pressable
                    accessibilityHint="Types the text exactly as shown without pressing Enter."
                    accessibilityLabel="Type text into Terminal"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !terminal.canControl || !draft || sending }}
                    disabled={!terminal.canControl || !draft || sending}
                    onPress={() => {
                        // eslint-disable-next-line no-void -- The hook reports delivery uncertainty and retains the draft.
                        void sendText();
                    }}
                    style={[
                        styles.textSend,
                        { backgroundColor: theme.primary, opacity: terminal.canControl ? 1 : 0.45 },
                    ]}
                    testID="terminal-send"
                >
                    <Text style={[styles.textSendLabel, { color: theme.primaryForeground }]}>
                        Type
                    </Text>
                </Pressable>
            </View>
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
        </>
    );
};

export const TerminalLiveControls = ({ role, terminal, theme }: TerminalControlsProperties) => (
    <>
        <TerminalLiveStatus role={role} terminal={terminal} theme={theme} />
        <TerminalToolbar terminal={terminal} theme={theme} />
        <TerminalTextEntry terminal={terminal} theme={theme} />
    </>
);
