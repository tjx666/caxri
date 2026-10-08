import { FilePlus, FolderPlus, RefreshCw, SquareMinus } from 'lucide-react';

import { PanelHeader } from '../../../components/panel-header';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utilities';
import type { ResourceExplorerController } from './hooks/use-resource-explorer-controller';

const captionActionClassName = 'shrink-0';

export function ResourceExplorerHeader({ controller }: { controller: ResourceExplorerController }) {
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
            title={project?.displayTitle ?? rootPathCaption}
            titleAttribute={session.rootPath}
            actions={
                <>
                    <Tooltip content="New File">
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label="New File"
                            onClick={createRootFile}
                        >
                            <FilePlus size={13} />
                        </Button>
                    </Tooltip>
                    <Tooltip content="New Folder">
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label="New Folder"
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
                    <Tooltip content="Refresh Files">
                        <Button
                            aria-busy={isRefreshing || undefined}
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label="Refresh Files"
                            onClick={refreshFiles}
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={cn(isRefreshing && 'motion-safe:animate-spin')}
                                size={13}
                            />
                        </Button>
                    </Tooltip>
                    <Tooltip content="Collapse Folders">
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label="Collapse Folders"
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
