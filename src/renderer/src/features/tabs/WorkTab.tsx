import { FileCode2, X } from 'lucide-react';
import type { DragEvent } from 'react';

import type { ProcessState } from '@shared/types';

import { AgentIdentityIcon } from '../../agent-icons/AgentIdentityIcon';
import type { AgentIconIdentity } from '../../agent-icons/agent-icon-registry';
import { cn } from '../../lib/utils';

const processIndicatorClassName =
    'process-indicator w-1.5 h-1.5 flex-none m-0 rounded-full bg-muted';

interface WorkTabProps {
    active: boolean;
    closeLabel: string;
    dirty?: boolean;
    icon: 'file' | AgentIconIdentity;
    label: string;
    status?: ProcessState;
    terminalId?: string;
    onClose: () => void;
    onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
    onSelect: () => void;
}

export function WorkTab({
    active,
    closeLabel,
    dirty = false,
    icon,
    label,
    status,
    terminalId,
    onClose,
    onDragStart,
    onSelect,
}: WorkTabProps) {
    return (
        <div
            className={cn(
                'work-tab group relative flex max-w-[180px] items-center border-r border-border bg-surface text-muted hover:bg-elevated hover:text-foreground',
                active &&
                    "active bg-background text-foreground after:content-[''] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-background",
            )}
            data-terminal-id={terminalId}
            draggable={Boolean(onDragStart)}
            onDragStart={onDragStart}
        >
            <button
                type="button"
                role="tab"
                aria-selected={active}
                className="tab-select flex h-full min-w-0 flex-1 items-center gap-2 border-0 bg-transparent px-2 text-left text-[11px] text-inherit cursor-pointer [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap"
                onClick={onSelect}
            >
                {icon === 'file' ? (
                    <FileCode2 size={13} />
                ) : (
                    <AgentIdentityIcon identity={icon} size={13} />
                )}
                <span>{label}</span>
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
                                ((status === 'failed' || status === 'dead') && 'bg-danger'),
                        )}
                    />
                )}
                <button
                    type="button"
                    className="tab-close absolute inset-0 m-auto grid w-5 h-5 place-items-center p-0 border-0 rounded text-inherit bg-transparent cursor-pointer opacity-0 pointer-events-none hover:bg-[var(--selection)] group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                    aria-label={closeLabel}
                    title={closeLabel}
                    onClick={onClose}
                >
                    <X size={12} />
                </button>
            </span>
        </div>
    );
}
