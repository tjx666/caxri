import type { CommandId } from '@caxri/protocol';
import { FilePlus, FolderPlus, Search, SquareMinus } from 'lucide-react';

import { getRegisteredCommand } from '../../../commands/registry';
import { PanelHeader } from '../../../components/panel-header';
import { Button } from '../../../components/ui/button';
import { CommandTooltip, Tooltip } from '../../../components/ui/tooltip';
import { useCommandShortcut } from '../../../lib/keybindings';
import { cn } from '../../../lib/utilities';
import { useControlledViewActionCommand } from '../controlled-view-context';
import type { ResourceExplorerController } from './use-resource-explorer-controller';

const captionActionClassName =
    'pointer-events-none shrink-0 opacity-0 transition-opacity group-hover/file-caption:pointer-events-auto group-hover/file-caption:opacity-100 group-focus-within/file-caption:pointer-events-auto group-focus-within/file-caption:opacity-100';

export function ResourceExplorerHeader({ controller }: { controller: ResourceExplorerController }) {
    const searchCommand = useControlledViewActionCommand('resource.search');
    const searchShortcut = useCommandShortcut((searchCommand ?? '') as CommandId);
    const isBuiltinSearchCommand =
        searchCommand !== undefined && getRegisteredCommand(searchCommand) !== undefined;
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
                    {isBuiltinSearchCommand ? (
                        <CommandTooltip commandId={searchCommand as CommandId}>
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
                    ) : (
                        <Tooltip content="Search Files" shortcut={searchShortcut}>
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
                        </Tooltip>
                    )}
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
