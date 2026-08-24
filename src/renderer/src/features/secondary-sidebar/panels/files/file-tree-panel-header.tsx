import { FilePlus, FolderPlus, Search, SquareMinus } from 'lucide-react';

import { PanelHeader } from '../../../../components/panel-header';
import { Button } from '../../../../components/ui/button';
import { CommandTooltip, Tooltip } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utilities';
import type { FileTreePanelController } from './use-file-tree-panel-controller';

const captionActionClassName =
    'pointer-events-none shrink-0 opacity-0 transition-opacity group-hover/file-caption:pointer-events-auto group-hover/file-caption:opacity-100 group-focus-within/file-caption:pointer-events-auto group-focus-within/file-caption:opacity-100';

export function FileTreePanelHeader({ controller }: { controller: FileTreePanelController }) {
    const {
        collapseFolders,
        createRootFile,
        createRootFolder,
        fileCaptionRef,
        isSearchVisible,
        project,
        rootPathCaption,
        session,
        toggleSearch,
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
                    <CommandTooltip commandId="secondarySidebar.searchFiles">
                        <Button
                            className={cn(
                                isSearchVisible
                                    ? 'pointer-events-auto shrink-0 bg-elevated text-foreground opacity-100'
                                    : captionActionClassName,
                            )}
                            size="icon"
                            variant="ghost"
                            aria-label="Search Files"
                            aria-pressed={isSearchVisible}
                            onClick={toggleSearch}
                        >
                            <Search size={13} />
                        </Button>
                    </CommandTooltip>
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
