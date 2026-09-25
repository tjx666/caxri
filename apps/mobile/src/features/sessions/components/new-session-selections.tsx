import { Pressable, Text, View } from 'react-native';

import type { TerminalKind } from '@caxri/protocol';

import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';
import { NEW_SESSION_AGENT_LABELS, NEW_SESSION_AGENT_ORDER } from '../new-session-model';
import { NewSessionChoice } from './new-session-choice';
import { newSessionStyles as styles } from './new-session-styles';

const NewSessionAgentChoice = ({
    kind,
    state,
    theme,
}: {
    kind: TerminalKind;
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    const agent = state.agents.find((candidate) => candidate.kind === kind);
    const disabled = !agent?.available || state.isAvailabilityError || state.isAvailabilityLoading;
    const reason = state.isAvailabilityError
        ? 'Availability unavailable.'
        : state.isAvailabilityLoading
          ? 'Checking availability…'
          : agent?.available
            ? undefined
            : (agent?.reason ?? 'Not available on this computer.');
    return (
        <NewSessionChoice
            disabled={disabled}
            isCompact
            label={NEW_SESSION_AGENT_LABELS[kind]}
            onPress={() => state.setNewSessionAgent(kind)}
            reason={reason}
            selected={!disabled && state.selectedAgent === kind}
            testID={`new-session-agent-${kind}`}
            theme={theme}
        />
    );
};

export const NewSessionSelections = ({
    state,
    theme,
}: {
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    if (state.projects.length === 0) return null;
    return (
        <>
            <View accessibilityRole="radiogroup" style={styles.group}>
                <Text style={[styles.groupLabel, { color: theme.muted }]}>PROJECT</Text>
                {state.projects.map((project) => (
                    <NewSessionChoice
                        key={project.id}
                        label={project.displayTitle}
                        onPress={() => state.setNewSessionProjectId(project.id)}
                        selected={project.id === state.selectedProjectId}
                        testID={`new-session-project-${project.id}`}
                        theme={theme}
                    />
                ))}
            </View>
            <View accessibilityRole="radiogroup" style={styles.group}>
                <Text style={[styles.groupLabel, { color: theme.muted }]}>AGENT</Text>
                <View style={styles.agentGrid}>
                    {NEW_SESSION_AGENT_ORDER.map((kind) => (
                        <NewSessionAgentChoice key={kind} kind={kind} state={state} theme={theme} />
                    ))}
                </View>
                {state.isAvailabilityError ? (
                    <Pressable
                        accessibilityRole="button"
                        onPress={() => state.refreshAvailability()}
                        style={styles.secondaryAction}
                        testID="new-session-agent-retry"
                    >
                        <Text style={[styles.secondaryText, { color: theme.primary }]}>
                            Retry Agent availability
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </>
    );
};
