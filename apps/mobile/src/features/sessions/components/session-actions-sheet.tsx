/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ComponentType } from 'react';
import { useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { LucideProps } from 'lucide-react-native';
import { Archive, Pencil } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
import type { useSessionManagement } from '../hooks/use-session-management';
import { sessionRenameDraft } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';

const SheetAction = ({
    busy,
    icon: Icon,
    label,
    onPress,
    testID,
    theme,
}: {
    busy: boolean;
    icon: ComponentType<LucideProps>;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPress={onPress}
        style={({ pressed }) => [
            styles.action,
            { backgroundColor: pressed ? theme.elevated : 'transparent' },
        ]}
        testID={testID}
    >
        {busy ? (
            <ActivityIndicator color={theme.muted} size="small" />
        ) : (
            <Icon color={theme.muted} size={20} />
        )}
        <Text style={[styles.actionText, { color: theme.text }]}>{label}</Text>
    </Pressable>
);

/**
 * Long-press actions for one Session row. Rename swaps the sheet body for an inline text field instead of stacking a
 * second modal, so the keyboard and focus stay in one surface.
 */
export const SessionActionsSheet = ({
    management,
    onClose,
    session,
    theme,
}: {
    management: ReturnType<typeof useSessionManagement>;
    onClose: () => void;
    session: MobileSessionItem | null;
    theme: MobileTheme;
}) =>
    session ? (
        // Keyed by Session so the rename draft and mode start fresh for each row.
        <SessionActionsBody
            key={session.id}
            management={management}
            onClose={onClose}
            session={session}
            theme={theme}
        />
    ) : null;

const SessionActionsBody = ({
    management,
    onClose,
    session,
    theme,
}: {
    management: ReturnType<typeof useSessionManagement>;
    onClose: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const insets = useSafeAreaInsets();
    const [mode, setMode] = useState<'menu' | 'rename'>('menu');
    const [draft, setDraft] = useState(session.displayTitle);
    const isBusy = management.pending?.sessionId === session.id;
    const nextTitle = sessionRenameDraft(draft, session.displayTitle);
    const submitRename = async (): Promise<void> => {
        if (nextTitle !== null && (await management.rename(session.id, nextTitle))) onClose();
    };
    return (
        <Modal
            animationType="fade"
            onRequestClose={onClose}
            statusBarTranslucent
            transparent
            visible
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.root}
            >
                <Pressable
                    accessibilityLabel="Close Session actions"
                    onPress={onClose}
                    style={styles.backdrop}
                    testID="session-actions-backdrop"
                />
                <View
                    style={[
                        styles.sheet,
                        {
                            backgroundColor: theme.surface,
                            borderColor: theme.border,
                            paddingBottom: insets.bottom + 12,
                        },
                    ]}
                    testID="session-actions-sheet"
                >
                    <View style={[styles.grabber, { backgroundColor: theme.border }]} />
                    <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                        {mode === 'rename' ? 'Rename Session' : session.displayTitle}
                    </Text>
                    <Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted }]}>
                        {session.projectTitle}
                    </Text>
                    {mode === 'menu' ? (
                        <View style={styles.actions}>
                            <SheetAction
                                busy={false}
                                icon={Pencil}
                                label="Rename"
                                onPress={() => setMode('rename')}
                                testID="session-action-rename"
                                theme={theme}
                            />
                            <SheetAction
                                busy={isBusy && management.pending?.action === 'archive'}
                                icon={Archive}
                                label="Archive"
                                onPress={() => {
                                    // eslint-disable-next-line no-void -- The hook renders archive failures.
                                    void management.archive(session.id).then((done) => {
                                        if (done) onClose();
                                    });
                                }}
                                testID="session-action-archive"
                                theme={theme}
                            />
                        </View>
                    ) : (
                        <View style={styles.rename}>
                            <TextInput
                                accessibilityLabel="Session name"
                                autoFocus
                                maxLength={200}
                                onChangeText={setDraft}
                                onSubmitEditing={() => {
                                    // eslint-disable-next-line no-void -- The hook renders rename failures.
                                    void submitRename();
                                }}
                                placeholder="Session name"
                                placeholderTextColor={theme.muted}
                                returnKeyType="done"
                                selectTextOnFocus
                                style={[
                                    styles.input,
                                    {
                                        backgroundColor: theme.background,
                                        borderColor: theme.border,
                                        color: theme.text,
                                    },
                                ]}
                                testID="session-rename-input"
                                value={draft}
                            />
                            <View style={styles.buttons}>
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={() => setMode('menu')}
                                    style={[styles.button, { backgroundColor: theme.elevated }]}
                                    testID="session-rename-cancel"
                                >
                                    <Text style={[styles.buttonText, { color: theme.text }]}>
                                        Cancel
                                    </Text>
                                </Pressable>
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: nextTitle === null || isBusy }}
                                    disabled={nextTitle === null || isBusy}
                                    onPress={() => {
                                        // eslint-disable-next-line no-void -- The hook renders rename failures.
                                        void submitRename();
                                    }}
                                    style={[
                                        styles.button,
                                        {
                                            backgroundColor: theme.primary,
                                            opacity: nextTitle === null || isBusy ? 0.5 : 1,
                                        },
                                    ]}
                                    testID="session-rename-save"
                                >
                                    {isBusy ? (
                                        <ActivityIndicator
                                            color={theme.primaryForeground}
                                            size="small"
                                        />
                                    ) : (
                                        <Text
                                            style={[
                                                styles.buttonText,
                                                { color: theme.primaryForeground },
                                            ]}
                                        >
                                            Save
                                        </Text>
                                    )}
                                </Pressable>
                            </View>
                        </View>
                    )}
                    {management.error ? (
                        <Text
                            accessibilityRole="alert"
                            style={[styles.error, { color: theme.danger }]}
                            testID="session-actions-error"
                        >
                            {management.error}
                        </Text>
                    ) : null}
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0, 0, 0, 0.5)' },
    sheet: {
        alignSelf: 'center',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        borderWidth: StyleSheet.hairlineWidth,
        maxWidth: 560,
        paddingHorizontal: 12,
        paddingTop: 8,
        width: '100%',
    },
    grabber: { alignSelf: 'center', borderRadius: 2, height: 4, marginBottom: 12, width: 36 },
    title: { fontSize: 17, fontWeight: '700', paddingHorizontal: 8 },
    subtitle: { fontSize: 13, paddingBottom: 8, paddingHorizontal: 8, paddingTop: 2 },
    actions: { paddingTop: 4 },
    action: {
        alignItems: 'center',
        borderRadius: 12,
        flexDirection: 'row',
        gap: 14,
        minHeight: 52,
        paddingHorizontal: 10,
    },
    actionText: { fontSize: 16 },
    rename: { gap: 12, paddingHorizontal: 8, paddingTop: 8 },
    input: {
        borderRadius: 12,
        borderWidth: 1,
        fontSize: 16,
        minHeight: 48,
        paddingHorizontal: 14,
    },
    buttons: { flexDirection: 'row', gap: 10 },
    button: {
        alignItems: 'center',
        borderRadius: 12,
        flex: 1,
        justifyContent: 'center',
        minHeight: 48,
    },
    buttonText: { fontSize: 16, fontWeight: '700' },
    error: { fontSize: 13, paddingHorizontal: 8, paddingTop: 10 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
