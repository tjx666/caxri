import { X } from 'lucide-react';
import type { DragEvent, ReactElement, ReactNode } from 'react';

import type { ProcessState } from '@shared/types';

import { AgentIdentityIcon } from '../../icons/agents/AgentIdentityIcon';
import type { AgentIconIdentity } from '../../icons/agents/agent-icon-registry';
import { FileTypeIcon } from '../../icons/files/FileTypeIcon';
import { ContextMenu, ContextMenuTrigger } from '../../components/ui/context-menu';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';

const processIndicatorClassName =
    'process-indicator w-1.5 h-1.5 flex-none m-0 rounded-full bg-muted';

interface WorkTabProps {
    active: boolean;
    closeLabel: string;
    dirty?: boolean;
    fileIconName?: string;
    icon: 'file' | AgentIconIdentity;
    label: string;
    preview?: boolean;
    status?: ProcessState;
    terminalId?: string;
    contextMenu?: ReactNode;
    onClose: () => void;
    onDoubleClick?: () => void;
    onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
    onSelect: () => void;
}

export function WorkTab({
    active,
    closeLabel,
    dirty = false,
    fileIconName,
    icon,
    label,
    preview = false,
    status,
    terminalId,
    contextMenu,
    onClose,
    onDoubleClick,
    onDragStart,
    onSelect,
}: WorkTabProps) {
    const tab = (
        <div
            className={cn(
                'work-tab group relative flex max-w-[180px] items-center border-r border-border bg-surface text-muted hover:bg-elevated hover:text-foreground [-webkit-app-region:no-drag]',
                active &&
                    "active bg-background text-foreground after:content-[''] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-background",
            )}
            data-terminal-id={terminalId}
            data-preview={preview || undefined}
            draggable={Boolean(onDragStart)}
            onDragStart={onDragStart}
            onDoubleClick={onDoubleClick}
        >
            <button
                type="button"
                role="tab"
                aria-selected={active}
                className="tab-select flex h-full min-w-0 flex-1 items-center gap-2 border-0 bg-transparent px-2 text-left text-[11px] text-inherit cursor-pointer [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap"
                onClick={onSelect}
            >
                {icon === 'file' ? (
                    <FileTypeIcon entry={{ kind: 'file', name: fileIconName ?? label }} />
                ) : (
                    <AgentIdentityIcon identity={icon} size={13} />
                )}
                <span className={cn(preview && 'italic')}>{label}</span>
                {dirty && <b className="text-warning text-[10px]">●</b>}
            </button>
            <span className="tab-tail relative w-6 h-6 flex-none">
                {status && (
                    <i
                        className={cn(
                            processIndicatorClassName,
                            'absolute inset-0 m-auto',
                            'group-hover:opacity-0 group-focus-within:opacity-0',
                            `process-${status}`,
                            (status === 'running' && 'bg-success') ||
                                ((status === 'failed' ||
                                    status === 'dead' ||
                                    status === 'interrupted') &&
                                    'bg-danger'),
                        )}
                    />
                )}
                <Tooltip content={closeLabel}>
                    <button
                        type="button"
                        className="tab-close absolute inset-0 m-auto grid w-5 h-5 place-items-center p-0 border-0 rounded text-inherit bg-transparent cursor-pointer opacity-0 pointer-events-none hover:bg-[var(--selection)] group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                        aria-label={closeLabel}
                        onClick={onClose}
                    >
                        <X size={12} />
                    </button>
                </Tooltip>
            </span>
        </div>
    );
    if (!contextMenu) return tab;
    return (
        <ContextMenu>
            <ContextMenuTrigger render={tab as ReactElement} />
            {contextMenu}
        </ContextMenu>
    );
}
