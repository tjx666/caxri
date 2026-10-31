import { useRef } from 'react';
import type { HostInstance } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';

import {
    Activity,
    Archive,
    EllipsisVertical,
    FolderPlus,
    Gauge,
    Search,
    Settings,
} from 'lucide-react-native';

import { IconButton } from '../../../components/icon-button';
import { PopoverAction, PopoverDivider, PopoverMenu } from '../../../components/popover-menu';
import { usePopoverAnchor } from '../../../components/use-popover-anchor';
import { useTranslation } from '../../../i18n';
import { mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { BotInboxHomeEntry } from '../../bot-inbox/bot-inbox-home-entry';
import type { useSessionPolling } from '../hooks/use-session-polling';
import { ProjectFilterChips } from './project-filter-chips';

type Project = ReturnType<typeof useSessionPolling>['projects'][number];

const styles = StyleSheet.create({
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        paddingRight: mobileSpace.xs,
        paddingTop: mobileSpace.sm,
    },
    menuCaption: {
        ...mobileType.meta,
        paddingBottom: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.xs,
    },
});

export const SessionHomeHeader = ({
    activeProjectId,
    hostDisplayName,
    onAddProject,
    onChooseProject,
    onMoveProject,
    onOpenArchived,
    onOpenInbox,
    onOpenSearch,
    onOpenSettings,
    onOpenStatus,
    onOpenUsage,
    projects,
    theme,
}: {
    activeProjectId: string | null;
    hostDisplayName: string;
    /**
     * Present only for a control device; view and reply devices cannot widen their own Project grant.
     */
    onAddProject?: () => void;
    onChooseProject: (projectId: string | null) => void;
    /**
     * Present only for a control device: a held Project chip can be dragged to a new place.
     */
    onMoveProject?: (projectId: string, toIndex: number) => void;
    onOpenArchived: () => void;
    /**
     * Present only for a control device: the Bot Inbox spans every Project, beyond a narrower device grant. Its entry
     * appears under the filters only while Caxri Bot has raised something.
     */
    onOpenInbox?: () => void;
    onOpenSearch: () => void;
    onOpenSettings: () => void;
    /**
     * Present only for a control device: computer status names Sessions from every Project.
     */
    onOpenStatus?: () => void;
    /**
     * Opens the Agent usage screen: plan limits, output speed, and API status.
     */
    onOpenUsage: () => void;
    projects: Project[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const menuAnchor = useRef<HostInstance>(null);
    const menu = usePopoverAnchor(menuAnchor);
    const { close: closeMenu } = menu;
    return (
        <>
            <View style={styles.header}>
                <ProjectFilterChips
                    activeProjectId={activeProjectId}
                    onChooseProject={onChooseProject}
                    onMoveProject={onMoveProject}
                    projects={projects}
                    theme={theme}
                />
                <IconButton
                    accessibilityHint={t('sessions.search.openHint')}
                    accessibilityLabel={t('sessions.search.open')}
                    icon={Search}
                    onPress={onOpenSearch}
                    testID="session-search-button"
                    theme={theme}
                />
                <View collapsable={false} ref={menuAnchor}>
                    <IconButton
                        accessibilityHint={t('sessions.home.computerMenuHint')}
                        accessibilityLabel={t('sessions.home.computerMenu')}
                        expanded={menu.isOpen}
                        icon={EllipsisVertical}
                        onPress={menu.open}
                        testID="computer-menu-button"
                        theme={theme}
                    />
                </View>
            </View>
            {onOpenInbox ? <BotInboxHomeEntry onOpen={onOpenInbox} theme={theme} /> : null}
            <PopoverMenu
                closeLabel={t('sessions.home.closeComputerMenu')}
                onClose={closeMenu}
                placement={menu.placement}
                theme={theme}
            >
                <Text
                    accessibilityLabel={t('sessions.home.pairedComputer', {
                        host: hostDisplayName,
                    })}
                    numberOfLines={1}
                    style={[styles.menuCaption, { color: theme.muted }]}
                    testID="computer-menu-name"
                >
                    {hostDisplayName}
                </Text>
                <PopoverDivider theme={theme} />
                <PopoverAction
                    accessibilityHint={t('usage.openHint')}
                    icon={Gauge}
                    label={t('usage.open')}
                    onPress={() => {
                        closeMenu();
                        onOpenUsage();
                    }}
                    testID="agent-usage-action"
                    theme={theme}
                />
                {onOpenStatus ? (
                    <PopoverAction
                        icon={Activity}
                        label={t('sessions.home.computerStatus')}
                        onPress={() => {
                            closeMenu();
                            onOpenStatus();
                        }}
                        testID="computer-status-action"
                        theme={theme}
                    />
                ) : null}
                <PopoverDivider theme={theme} />
                <PopoverAction
                    icon={Archive}
                    label={t('sessions.home.archivedSessions')}
                    onPress={() => {
                        closeMenu();
                        onOpenArchived();
                    }}
                    testID="archived-sessions-action"
                    theme={theme}
                />
                {onAddProject ? (
                    <PopoverAction
                        icon={FolderPlus}
                        label={t('sessions.home.addProject')}
                        onPress={() => {
                            closeMenu();
                            onAddProject();
                        }}
                        testID="add-project-action"
                        theme={theme}
                    />
                ) : null}
                <PopoverDivider theme={theme} />
                <PopoverAction
                    icon={Settings}
                    label={t('sessions.home.settings')}
                    onPress={() => {
                        closeMenu();
                        onOpenSettings();
                    }}
                    testID="settings-action"
                    theme={theme}
                />
            </PopoverMenu>
        </>
    );
};
