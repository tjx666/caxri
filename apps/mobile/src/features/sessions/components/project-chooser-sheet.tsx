import { ScrollView } from 'react-native';

import { Folder } from 'lucide-react-native';

import { BottomSheet, SheetAction, SheetTitle } from '../../../components/bottom-sheet';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';

/**
 * Every Project the device may see, in the order Desktop's sidebar shows, opened from the Project strip's More chip.
 * Choosing one filters the Session list to it, and its chip joins the strip while it stays chosen.
 */
export const ProjectChooserSheet = ({
    activeProjectId,
    onChoose,
    onClose,
    projects,
    theme,
}: {
    activeProjectId: string | null;
    onChoose: (projectId: string) => void;
    onClose: () => void;
    projects: ReadonlyArray<{ id: string; title: string }>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <BottomSheet
            closeLabel={t('sessions.home.closeProjects')}
            maxHeight="80%"
            onClose={onClose}
            testID="project-chooser-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    <SheetTitle theme={theme} title={t('sessions.home.projectsTitle')} />
                    <ScrollView>
                        {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A device sees at most 128 Projects, each one short row. */}
                        {projects.map((project) => (
                            <SheetAction
                                icon={Folder}
                                key={project.id}
                                label={project.title}
                                onPress={() => {
                                    onChoose(project.id);
                                    dismiss();
                                }}
                                selected={project.id === activeProjectId}
                                testID={`project-chooser-${project.id}`}
                                theme={theme}
                            />
                        ))}
                    </ScrollView>
                </>
            )}
        </BottomSheet>
    );
};
