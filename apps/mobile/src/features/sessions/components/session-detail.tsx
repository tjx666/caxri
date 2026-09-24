import type { RefObject } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import type { TerminalPreviewViewState } from '../hooks/use-terminal-preview';
import type { MobileSessionItem } from '../session-model';
import type { SessionPreviewPosition } from '../session-preview-scroll';
import type { SessionSegment } from '../session-ui-state';
import { SessionDetailComposer } from './session-detail-composer';
import { SessionDetailHeader } from './session-detail-header';
import { sessionDetailStyles as styles } from './session-detail-styles';
import { SessionTerminalPreview } from './session-terminal-preview';

const segmentLabels: Record<SessionSegment, string> = {
    conversation: 'Conversation',
    terminal: 'Terminal',
    changes: 'Changes',
};

const SessionSegmentPlaceholder = ({
    kind,
    theme,
}: {
    kind: 'conversation' | 'changes';
    theme: MobileTheme;
}) => (
    <View style={styles.placeholder} testID={`${kind}-placeholder`}>
        <Text accessibilityRole="header" style={[styles.placeholderTitle, { color: theme.text }]}>
            {segmentLabels[kind]}
        </Text>
        <Text style={[styles.placeholderBody, { color: theme.muted }]}>
            {kind === 'conversation'
                ? 'Conversation view is coming soon. Use the Terminal to follow this Agent.'
                : 'Changes review is coming soon. Review files on your computer for now.'}
        </Text>
    </View>
);

export const SessionDetail = ({
    draft,
    isConnected,
    onBack,
    onDraftChange,
    onMarkRead,
    onRefresh,
    onSegmentChange,
    previewScrollBySessionRef,
    previewState,
    segment,
    session,
    theme,
    wideChanges,
}: {
    draft: string;
    isConnected: boolean;
    onBack?: () => void;
    onDraftChange: (draft: string) => void;
    onMarkRead: () => Promise<void>;
    onRefresh: () => Promise<void>;
    onSegmentChange: (segment: SessionSegment) => void;
    previewScrollBySessionRef: RefObject<Partial<Record<string, SessionPreviewPosition>>>;
    previewState: TerminalPreviewViewState;
    segment: SessionSegment;
    session: MobileSessionItem;
    theme: MobileTheme;
    wideChanges: boolean;
}) => {
    const terminal = (
        <SessionTerminalPreview
            previewScrollBySessionRef={previewScrollBySessionRef}
            previewState={previewState}
            session={session}
            theme={theme}
        />
    );
    const body =
        segment === 'terminal' ? (
            terminal
        ) : (
            <SessionSegmentPlaceholder
                kind={segment === 'conversation' ? 'conversation' : 'changes'}
                theme={theme}
            />
        );
    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="session-detail"
        >
            <SessionDetailHeader
                isConnected={isConnected}
                onBack={onBack}
                onMarkRead={onMarkRead}
                onSegmentChange={onSegmentChange}
                segment={segment}
                session={session}
                theme={theme}
            />
            {segment === 'changes' && wideChanges ? (
                <View style={styles.bodyRow}>
                    {terminal}
                    <View style={[styles.wideChanges, { borderColor: theme.border }]}>
                        <SessionSegmentPlaceholder kind="changes" theme={theme} />
                    </View>
                </View>
            ) : (
                <View style={styles.body}>{body}</View>
            )}
            <SessionDetailComposer
                draft={draft}
                isConnected={isConnected}
                onDraftChange={onDraftChange}
                onRefresh={onRefresh}
                session={session}
                theme={theme}
            />
        </KeyboardAvoidingView>
    );
};
