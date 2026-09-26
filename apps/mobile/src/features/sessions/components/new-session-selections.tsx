import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import type { TerminalKind } from '@caxri/protocol';
import { Folder, FolderPlus, Search } from 'lucide-react-native';

import { AgentGlyph } from '../../../components/agent-icon';
import type { MobileTheme } from '../../../theme/tokens';
import type { NewSessionViewState } from '../hooks/use-new-session';
import {
    NEW_SESSION_AGENT_LABELS,
    NEW_SESSION_AGENT_ORDER,
    newSessionAgentReason,
} from '../new-session-model';
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
    const reason = newSessionAgentReason({
        agent,
        isConnected: state.status === 'connected',
        isError: state.isAvailabilityError,
        isLoading: state.isAvailabilityLoading,
    });
    return (
        <NewSessionChoice
            disabled={disabled}
            isCompact
            label={NEW_SESSION_AGENT_LABELS[kind]}
            leading={<AgentGlyph kind={kind} size={20} theme={theme} />}
            onPress={() => state.setNewSessionAgent(kind)}
            reason={reason}
            selected={!disabled && state.selectedAgent === kind}
            testID={`new-session-agent-${kind}`}
            theme={theme}
        />
    );
};

/**
 * Beyond this many Projects the list outgrows one screen, so a filter field appears above it.
 */
const PROJECT_FILTER_THRESHOLD = 6;

export const NewSessionSelections = ({
    onAddProject,
    state,
    theme,
}: {
    /**
     * Present only for a control device, which may add a Project from this screen.
     */
    onAddProject?: () => void;
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    const [query, setQuery] = useState('');
    if (state.projects.length === 0) return null;
    const needle = query.trim().toLocaleLowerCase();
    const projects = needle
        ? state.projects.filter(
              (project) =>
                  project.id === state.selectedProjectId ||
                  project.displayTitle.toLocaleLowerCase().includes(needle),
          )
        : state.projects;
    return (
        <>
            <View accessibilityRole="radiogroup" style={styles.group}>
                <Text style={[styles.groupLabel, { color: theme.muted }]}>Agent</Text>
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
            <View accessibilityRole="radiogroup" style={styles.group}>
                <Text style={[styles.groupLabel, { color: theme.muted }]}>Project</Text>
                {state.projects.length > PROJECT_FILTER_THRESHOLD ? (
                    <View
                        style={[
                            styles.filter,
                            { backgroundColor: theme.surface, borderColor: theme.border },
                        ]}
                    >
                        <Search color={theme.muted} size={18} />
                        <TextInput
                            accessibilityLabel="Filter Projects"
                            autoCapitalize="none"
                            autoCorrect={false}
                            onChangeText={setQuery}
                            placeholder="Filter Projects"
                            placeholderTextColor={theme.muted}
                            style={[styles.filterInput, { color: theme.text }]}
                            testID="new-session-project-filter"
                            value={query}
                        />
                    </View>
                ) : null}
                {projects.map((project) => (
                    <NewSessionChoice
                        key={project.id}
                        label={project.displayTitle}
                        leading={<Folder color={theme.muted} size={18} />}
                        onPress={() => state.setNewSessionProjectId(project.id)}
                        selected={project.id === state.selectedProjectId}
                        testID={`new-session-project-${project.id}`}
                        theme={theme}
                    />
                ))}
                {onAddProject ? (
                    <Pressable
                        accessibilityRole="button"
                        onPress={onAddProject}
                        style={({ pressed }) => [
                            styles.choice,
                            {
                                backgroundColor: pressed ? theme.surface : 'transparent',
                                borderColor: theme.border,
                                borderStyle: 'dashed',
                            },
                        ]}
                        testID="new-session-add-project"
                    >
                        <FolderPlus color={theme.primary} size={18} />
                        <Text style={[styles.choiceTitle, { color: theme.primary }]}>
                            Add Project
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </>
    );
};
