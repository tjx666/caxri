import type { GitFileStatus, GitRepositorySummary } from '@shared/types';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { DiscardIcon } from '../../../../icons/codicons/discard-icon';
import { FileSubmoduleIcon } from '../../../../icons/codicons/file-submodule-icon';
import { FileTypeIcon } from '../../../../icons/files/file-type-icon';
import { cn } from '../../../../lib/utilities';
import { GitFileStatusLetter } from './git-file-status-letter';
import type { GitFileTreeNode } from './git-tree';

const gitRowClassName =
    'git-row flex w-full items-center gap-2 h-7 px-2 border-0 bg-surface text-left cursor-pointer';

export function GitTreeItems({
    depth = 0,
    expandedDirectories,
    nodes,
    onDiscardFile,
    onFocusRepository,
    onSelect,
    repositoryKey,
    selected,
    setDirectoryExpanded,
    submodulesByPath,
}: {
    depth?: number;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    nodes: GitFileTreeNode[];
    /**
     * Present only for working-tree rows; commit and pull-request files are history, not discardable state.
     */
    onDiscardFile?: (file: GitFileStatus) => void;
    onFocusRepository: (repoId: string) => void;
    onSelect: (path: string) => void;
    repositoryKey: string;
    selected?: string;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
    submodulesByPath: ReadonlyMap<string, GitRepositorySummary>;
}) {
    return nodes.map((node) => {
        if (node.kind === 'directory') {
            return (
                <GitTreeDirectory
                    key={node.path}
                    depth={depth}
                    expandedDirectories={expandedDirectories}
                    node={node}
                    onDiscardFile={onDiscardFile}
                    onFocusRepository={onFocusRepository}
                    onSelect={onSelect}
                    repositoryKey={repositoryKey}
                    selected={selected}
                    setDirectoryExpanded={setDirectoryExpanded}
                    submodulesByPath={submodulesByPath}
                />
            );
        }
        const file = node.file;
        const submodule = submodulesByPath.get(file.path);
        if (submodule) {
            // A submodule bump has no meaningful file diff; the row jumps to the submodule's own
            // repository section below instead of opening one.
            return (
                <button
                    key={file.path}
                    className={cn(gitRowClassName, 'git-submodule-row hover:bg-elevated')}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    title={`Toggle the ${submodule.name} submodule repository`}
                    onClick={() => onFocusRepository(submodule.id)}
                >
                    <FileSubmoduleIcon size={14} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    <small className="shrink-0 text-[11px] whitespace-nowrap text-muted">
                        submodule
                    </small>
                    <GitFileStatusLetter file={file} />
                </button>
            );
        }
        return (
            <div key={file.path} className="git-row-container group relative">
                <button
                    className={cn(
                        gitRowClassName,
                        'hover:bg-elevated',
                        selected === file.path && 'active bg-elevated',
                    )}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    title={file.path}
                    onClick={() => onSelect(file.path)}
                >
                    <FileTypeIcon entry={{ kind: 'file', name: node.name }} />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    {/* VS Code-style hover swap: the status letter yields its slot to the Discard
                        action, which is overlaid as a sibling so the row button never nests one. */}
                    <GitFileStatusLetter
                        file={file}
                        className={
                            onDiscardFile
                                ? 'group-focus-within:invisible group-hover:invisible'
                                : undefined
                        }
                    />
                </button>
                {onDiscardFile && (
                    <Tooltip
                        content={file.kind === 'untracked' ? 'Delete File' : 'Discard Changes'}
                    >
                        <Button
                            className="git-discard-file absolute top-1/2 right-1 hidden size-5 -translate-y-1/2 group-focus-within:flex group-hover:flex"
                            size="icon"
                            variant="ghost"
                            aria-label={
                                file.kind === 'untracked'
                                    ? `Delete ${node.name}`
                                    : `Discard changes in ${node.name}`
                            }
                            onClick={() => onDiscardFile(file)}
                        >
                            <DiscardIcon size={13} />
                        </Button>
                    </Tooltip>
                )}
            </div>
        );
    });
}

function GitTreeDirectory({
    depth,
    expandedDirectories,
    node,
    onDiscardFile,
    onFocusRepository,
    onSelect,
    repositoryKey,
    selected,
    setDirectoryExpanded,
    submodulesByPath,
}: {
    depth: number;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    node: Extract<GitFileTreeNode, { kind: 'directory' }>;
    onDiscardFile?: (file: GitFileStatus) => void;
    onFocusRepository: (repoId: string) => void;
    onSelect: (path: string) => void;
    repositoryKey: string;
    selected?: string;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
    submodulesByPath: ReadonlyMap<string, GitRepositorySummary>;
}) {
    const expansionKey = `${repositoryKey}:${node.path}`;
    const isExpanded = expandedDirectories[expansionKey] ?? true;
    return (
        <div>
            <button
                className="git-tree-directory flex h-7 w-full cursor-pointer items-center gap-1.5 border-0 bg-surface pr-2 text-left text-foreground hover:bg-elevated"
                style={{ paddingLeft: 8 + depth * 14 }}
                aria-expanded={isExpanded}
                title={node.path}
                onClick={() => setDirectoryExpanded(expansionKey, !isExpanded)}
            >
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <FileTypeIcon
                    entry={{ kind: 'directory', name: node.name }}
                    expanded={isExpanded}
                />
                <span className="truncate">{node.name}</span>
            </button>
            <DisclosureMotion animate expanded={isExpanded} kind="git-directory">
                {() => (
                    <GitTreeItems
                        depth={depth + 1}
                        expandedDirectories={expandedDirectories}
                        nodes={node.children}
                        onDiscardFile={onDiscardFile}
                        onFocusRepository={onFocusRepository}
                        onSelect={onSelect}
                        repositoryKey={repositoryKey}
                        selected={selected}
                        setDirectoryExpanded={setDirectoryExpanded}
                        submodulesByPath={submodulesByPath}
                    />
                )}
            </DisclosureMotion>
        </div>
    );
}
