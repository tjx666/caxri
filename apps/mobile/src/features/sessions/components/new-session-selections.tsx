import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import type { TerminalKind } from '@caxri/protocol';
import { Folder, FolderPlus, MessagesSquare, Search, SquareTerminal } from 'lucide-react-native';

import { AgentGlyph } from '../../../components/agent-icon';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { mobileAgentDisplayName } from '../agent-display-name';
import type { NewSessionViewState } from '../hooks/use-new-session';
import {
    NEW_SESSION_AGENT_ORDER,
    newSessionAgentReason,
    newSessionSurfaceDescription,
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
    const { t } = useTranslation();
    const agent = state.agents.find((candidate) => candidate.kind === kind);
    const disabled = !agent?.available || state.isAvailabilityError || state.isAvailabilityLoading;
    const reason = newSessionAgentReason(
        {
            agent,
            isConnected: state.status === 'connected',
            isError: state.isAvailabilityError,
            isLoading: state.isAvailabilityLoading,
        },
        t,
    );
    return (
        <NewSessionChoice
            detail={reason}
            disabled={disabled}
            isCompact
            label={mobileAgentDisplayName(kind)}
            leading={<AgentGlyph kind={kind} size={20} theme={theme} />}
            onPress={() => state.setNewSessionAgent(kind)}
            selected={!disabled && state.selectedAgent === kind}
            testID={`new-session-agent-${kind}`}
            theme={theme}
        />
    );
};

/**
 * Shown only for an Agent that supports Chat; a Shell or a PTY-only Agent always opens in a Terminal.
 */
const NewSessionSurfaceGroup = ({
    state,
    theme,
}: {
    state: NewSessionViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (state.selectedSurface === null) return null;
    return (
        <View accessibilityRole="radiogroup" style={styles.group}>
            <Text style={[styles.groupLabel, { color: theme.muted }]}>
                {t('sessions.new.openAs')}
            </Text>
            <View style={styles.agentGrid}>
                <NewSessionChoice
                    detail={newSessionSurfaceDescription('chat', state.defaultSurface, t)}
                    isCompact
                    label={t('sessions.new.surfaceChat')}
                    leading={<MessagesSquare color={theme.muted} size={18} />}
                    onPress={() => state.setNewSessionSurface('chat')}
                    selected={state.selectedSurface === 'chat'}
                    testID="new-session-surface-chat"
                    theme={theme}
                />
                <NewSessionChoice
                    detail={newSessionSurfaceDescription('pty', state.defaultSurface, t)}
                    isCompact
                    label={t('sessions.new.surfaceTerminal')}
                    leading={<SquareTerminal color={theme.muted} size={18} />}
                    onPress={() => state.setNewSessionSurface('pty')}
                    selected={state.selectedSurface === 'pty'}
                    testID="new-session-surface-terminal"
                    theme={theme}
                />
            </View>
        </View>
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
    const { t } = useTranslation();
    if (state.projects.length === 0) return null;
    const needle = query.trim().toLocaleLowerCase();
    const projects = needle
        ? state.projects.filter(
              (project) =>
                  project.id === state.selectedProjectId ||
                  project.title.toLocaleLowerCase().includes(needle),
          )
        : state.projects;
    return (
        <>
            <View accessibilityRole="radiogroup" style={styles.group}>
                <Text style={[styles.groupLabel, { color: theme.muted }]}>
                    {t('sessions.new.agentGroup')}
                </Text>
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
                            {t('sessions.new.retryAvailability')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
            <NewSessionSurfaceGroup state={state} theme={theme} />
            <View accessibilityRole="radiogroup" style={styles.group}>
                <Text style={[styles.groupLabel, { color: theme.muted }]}>
                    {t('sessions.new.projectGroup')}
                </Text>
                {state.projects.length > PROJECT_FILTER_THRESHOLD ? (
                    <View
                        style={[
                            styles.filter,
                            { backgroundColor: theme.surface, borderColor: theme.border },
                        ]}
                    >
                        <Search color={theme.muted} size={18} />
                        <TextInput
                            accessibilityLabel={t('sessions.new.filterProjects')}
                            autoCapitalize="none"
                            autoCorrect={false}
                            onChangeText={setQuery}
                            placeholder={t('sessions.new.filterProjects')}
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
                        label={project.title}
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
                            {t('sessions.home.addProject')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </>
    );
};
