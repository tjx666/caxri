import { FilePlus, FolderPlus, RefreshCw, SquareMinus } from 'lucide-react';

import { PanelHeader } from '../../../components/panel-header';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { ResourceExplorerController } from './hooks/use-resource-explorer-controller';

const captionActionClassName = 'shrink-0';

export function ResourceExplorerHeader({ controller }: { controller: ResourceExplorerController }) {
    const { t } = useTranslation();
    const {
        collapseFolders,
        createRootFile,
        createRootFolder,
        fileCaptionRef,
        isRefreshing,
        project,
        refreshFiles,
        rootPathCaption,
        session,
    } = controller;

    return (
        <PanelHeader
            ref={fileCaptionRef}
            className="group/file-caption"
            title={project?.title ?? rootPathCaption}
            titleAttribute={session.rootPath}
            actions={
                <>
                    <Tooltip content={t('viewContainers.files.newFile')}>
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label={t('viewContainers.files.newFile')}
                            onClick={createRootFile}
                        >
                            <FilePlus size={13} />
                        </Button>
                    </Tooltip>
                    <Tooltip content={t('viewContainers.files.newFolder')}>
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label={t('viewContainers.files.newFolder')}
                            onClick={createRootFolder}
                        >
                            <FolderPlus size={13} />
                        </Button>
                    </Tooltip>
                    {/*
                     * Between creation and collapse, the order VS Code's explorer uses. A tree can go stale without
                     * any gesture in Caxri (an Agent writing files in a Terminal, a branch switch, a script) so this
                     * is the action that says "read the disk again" without also throwing away where the user is.
                     */}
                    <Tooltip content={t('viewContainers.files.refresh')}>
                        <Button
                            aria-busy={isRefreshing || undefined}
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label={t('viewContainers.files.refresh')}
                            onClick={refreshFiles}
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={cn(isRefreshing && 'motion-safe:animate-spin')}
                                size={13}
                            />
                        </Button>
                    </Tooltip>
                    <Tooltip content={t('viewContainers.files.collapseFolders')}>
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label={t('viewContainers.files.collapseFolders')}
                            onClick={collapseFolders}
                        >
                            <SquareMinus size={13} />
                        </Button>
                    </Tooltip>
                </>
            }
        />
    );
}
