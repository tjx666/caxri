import { FilePlus, FolderPlus, SquareMinus } from 'lucide-react';

import { PanelHeader } from '../../../components/panel-header';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import type { ResourceExplorerController } from './use-resource-explorer-controller';

const captionActionClassName = 'shrink-0';

export function ResourceExplorerHeader({ controller }: { controller: ResourceExplorerController }) {
    const {
        collapseFolders,
        createRootFile,
        createRootFolder,
        fileCaptionRef,
        project,
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
