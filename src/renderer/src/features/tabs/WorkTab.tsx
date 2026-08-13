import { useIsPresent } from 'motion/react';
import * as m from 'motion/react-m';
import { X } from 'lucide-react';
import type { DragEvent, ReactElement, ReactNode } from 'react';
import { useState } from 'react';

import type { ProcessState } from '@shared/types';

import { AgentIdentityIcon } from '../../icons/agents/AgentIdentityIcon';
import type { AgentIconIdentity } from '../../icons/agents/agent-icon-registry';
import { FileTypeIcon } from '../../icons/files/FileTypeIcon';
import { ContextMenu, ContextMenuTrigger } from '../../components/ui/context-menu';
import { Tooltip } from '../../components/ui/tooltip';
import { motionDurationMs, usePrefersReducedMotion } from '../../lib/motion';
import { cn } from '../../lib/utils';

const processIndicatorClassName =
    'process-indicator w-1.5 h-1.5 flex-none m-0 rounded-full bg-muted';

interface WorkTabProps {
    active: boolean;
    accessory?: ReactNode;
    closeLabel: string;
    dirty?: boolean;
    fileIconName?: string;
    icon: 'file' | AgentIconIdentity;
    label: string;
    motionIdentity?: string;
    preview?: boolean;
    status?: ProcessState;
    terminalId?: string;
    contextMenu?: ReactNode;
    onClose: () => void;
    onDoubleClick?: () => void;
    onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
    onSelect: () => void;
}

/** Target width the tab grows to/from during its enter/exit width animation. */
const TAB_MAX_WIDTH = 180;

export function WorkTab({
    active,
    accessory,
    closeLabel,
    dirty = false,
    fileIconName,
    icon,
    label,
    motionIdentity,
    preview = false,
    status,
    terminalId,
    contextMenu,
    onClose,
    onDoubleClick,
    onDragStart,
    onSelect,
}: WorkTabProps) {
    const isPresent = useIsPresent();
    const reducedMotion = usePrefersReducedMotion();
    // Token values need a live DOM (`getComputedStyle`), so they can't be read at module scope;
    // a lazy `useState` initializer reads them once per mount instead of on every render.
    const [durations] = useState(() => ({
        enterS: motionDurationMs('--motion-tab-enter') / 1000,
        exitS: motionDurationMs('--motion-tab-exit') / 1000,
    }));
    const enterDuration = reducedMotion ? 0 : durations.enterS;
    const exitDuration = reducedMotion ? 0 : durations.exitS;
    // Exiting tabs must never look or behave active: force the non-active visual state and lock
    // out pointer/keyboard interaction while the exit animation plays out.
    const visuallyActive = active && isPresent;
    const tab = (
        <m.div
            className={cn(
                'work-tab group relative flex items-center border-r border-border bg-surface text-muted hover:bg-elevated hover:text-foreground [-webkit-app-region:no-drag]',
                !isPresent && 'pointer-events-none',
                visuallyActive &&
                    "active bg-background text-foreground after:content-[''] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-background",
            )}
            data-terminal-id={terminalId}
            data-motion-identity={motionIdentity}
            data-preview={preview || undefined}
            aria-hidden={!isPresent || undefined}
            inert={!isPresent ? true : undefined}
            draggable={Boolean(onDragStart)}
            // Motion's HTMLMotionProps redefines `onDragStart` for its own pointer-based drag
            // gesture (a different signature: `(event, info: PanInfo) => void`), which shadows
            // the native HTML5 dragstart handler this tab needs for terminal reordering. The
            // `drag` gesture prop is never set here, so Motion never wires a listener under that
            // name; the capture-phase prop name is untouched by Motion's typing and behaves
            // identically to a bubble-phase listener for this leaf element.
            onDragStartCapture={onDragStart}
            onDoubleClick={onDoubleClick}
            initial={{ maxWidth: 0, opacity: 0, overflow: 'hidden' }}
            animate={{
                maxWidth: TAB_MAX_WIDTH,
                opacity: 1,
                transitionEnd: { overflow: 'visible' },
                transition: { duration: enterDuration, ease: 'easeOut' },
            }}
            exit={{
                maxWidth: 0,
                opacity: 0,
                overflow: 'hidden',
                transition: { duration: exitDuration, ease: 'easeIn' },
            }}
        >
            <button
                type="button"
                role="tab"
                aria-selected={visuallyActive}
                className="tab-select flex h-full min-w-0 flex-1 items-center gap-2 border-0 bg-transparent px-2 text-left text-[11px] text-inherit cursor-pointer"
                onClick={onSelect}
            >
                {icon === 'file' ? (
                    <FileTypeIcon entry={{ kind: 'file', name: fileIconName ?? label }} />
                ) : (
                    <AgentIdentityIcon identity={icon} size={13} />
                )}
                <span
                    className={cn(
                        'tab-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap',
                        preview && 'italic',
                    )}
                >
                    {label}
                </span>
                {dirty && <b className="text-warning text-[10px]">●</b>}
                {accessory}
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
        </m.div>
    );
    if (!contextMenu) return tab;
    return (
        <ContextMenu>
            <ContextMenuTrigger render={tab as ReactElement} />
            {contextMenu}
        </ContextMenu>
    );
}
