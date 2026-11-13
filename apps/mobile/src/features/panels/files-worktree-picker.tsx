import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { MobileWorkbenchRoot } from '@caxri/protocol';
import { ChevronDown, FolderGit2 } from 'lucide-react-native';

import { BottomSheet, SheetAction, SheetCancel, SheetTitle } from '../../components/bottom-sheet';
import { showToast } from '../../components/toast-store';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { panelsStyles as styles } from './panels-styles';
import { useWorkbenchRoots } from './use-workbench-roots';

/**
 * How a worktree reads in the picker: its title, with the branch beside it when the two differ.
 */
const rootLabel = (root: MobileWorkbenchRoot): string =>
    root.title === root.branch ? root.title : `${root.title} · ${root.branch}`;

/**
 * The worktree Files and Changes show for this Session, the phone's form of Desktop's status bar worktree picker. It
 * appears only when the repository has another worktree. A `control` device switches among the worktrees Desktop
 * already authorized; a worktree Desktop has not authorized yet is listed but has to be authorized on the computer
 * first.
 */
export const FilesWorktreePicker = ({
    deviceRole,
    onSwitched,
    sessionId,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    /**
     * Runs after a switch, so the Files view leaves folders that belong to the previous worktree.
     */
    onSwitched: () => void;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const { roots, select, switching } = useWorkbenchRoots(sessionId);
    if (roots.length < 2) return null;
    const current = roots.find((root) => root.isCurrent);
    const canSwitch = deviceRole === 'control';
    const choose = async (root: MobileWorkbenchRoot): Promise<void> => {
        if (!root.projectId || root.isCurrent) return;
        try {
            await select(root.projectId);
            onSwitched();
        } catch {
            showToast('error', t('panels.worktreeSwitchFailed'));
        }
    };
    return (
        <>
            <Pressable
                accessibilityHint={canSwitch ? undefined : t('panels.worktreeNeedsControl')}
                accessibilityLabel={t('panels.worktreeCurrent', {
                    name: current ? rootLabel(current) : t('panels.worktreeUnknown'),
                })}
                accessibilityRole="button"
                disabled={switching}
                onPress={() => setIsOpen(true)}
                style={({ pressed }) => [
                    styles.crumbs,
                    styles.worktreeRow,
                    {
                        backgroundColor: pressed ? theme.surface : 'transparent',
                        borderColor: theme.border,
                    },
                ]}
                testID="files-worktree"
            >
                <FolderGit2 color={theme.muted} size={16} />
                <Text numberOfLines={1} style={[styles.rowText, { color: theme.text }]}>
                    {switching
                        ? t('panels.worktreeSwitching')
                        : current
                          ? rootLabel(current)
                          : t('panels.worktreeUnknown')}
                </Text>
                <ChevronDown color={theme.muted} size={16} />
            </Pressable>
            {isOpen ? (
                <BottomSheet
                    closeLabel={t('panels.worktreeClose')}
                    onClose={() => setIsOpen(false)}
                    testID="files-worktree-sheet"
                    theme={theme}
                >
                    {(dismiss) => (
                        <>
                            <SheetTitle
                                detail={canSwitch ? undefined : t('panels.worktreeNeedsControl')}
                                theme={theme}
                                title={t('panels.worktree')}
                            />
                            <View>
                                {roots.map((root, index) => (
                                    <SheetAction
                                        detail={
                                            root.projectId
                                                ? root.isMain
                                                    ? t('panels.worktreeMain')
                                                    : undefined
                                                : t('panels.worktreeNeedsAuthorization')
                                        }
                                        disabled={!canSwitch || !root.projectId}
                                        icon={FolderGit2}
                                        key={root.projectId ?? `unauthorized-${index}`}
                                        label={rootLabel(root)}
                                        onPress={() => {
                                            dismiss();
                                            void choose(root);
                                        }}
                                        selected={root.isCurrent}
                                        testID={`files-worktree-option-${root.isMain ? 'main' : index}`}
                                        theme={theme}
                                    />
                                ))}
                            </View>
                            <SheetCancel
                                onPress={dismiss}
                                testID="files-worktree-cancel"
                                theme={theme}
                            />
                        </>
                    )}
                </BottomSheet>
            ) : null}
        </>
    );
};
