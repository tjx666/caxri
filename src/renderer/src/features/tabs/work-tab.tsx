import type { DragEvent, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { useState } from 'react';

import type { ProcessState } from '@shared/types';
import { X } from 'lucide-react';
import { useIsPresent } from 'motion/react';
import * as m from 'motion/react-m';

import { ContextMenu, ContextMenuTrigger } from '../../components/ui/context-menu';
import { Tooltip } from '../../components/ui/tooltip';
import type { AgentIconIdentity } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { motionDurationMs, useShouldReduceMotion } from '../../lib/motion';
import { cn } from '../../lib/utilities';
import { processStateDescription } from './work-tab-accessibility';

const processIndicatorClassName =
    'process-indicator w-1.5 h-1.5 flex-none m-0 rounded-full bg-muted';

interface WorkTabProperties {
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
    tabId: string;
    terminalId?: string;
    contextMenu?: ReactNode;
    onClose: () => void;
    onDoubleClick?: () => void;
    onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
    onSelect: () => void;
}

/**
 * Target width the tab grows to/from during its enter/exit width animation.
 */
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
    tabId,
    terminalId,
    contextMenu,
    onClose,
    onDoubleClick,
    onDragStart,
    onKeyDown,
    onSelect,
}: WorkTabProperties) {
    const isPresent = useIsPresent();
    const isReducedMotion = useShouldReduceMotion();
    // Token values need a live DOM (`getComputedStyle`), so they can't be read at module scope;
    // a lazy `useState` initializer reads them once per mount instead of on every render.
    const [durations] = useState(() => ({
        enterS: motionDurationMs('--motion-tab-enter') / 1000,
        exitS: motionDurationMs('--motion-tab-exit') / 1000,
    }));
    const enterDuration = isReducedMotion ? 0 : durations.enterS;
    const exitDuration = isReducedMotion ? 0 : durations.exitS;
    // Exiting tabs must never look or behave active: force the non-active visual state and lock
    // out pointer/keyboard interaction while the exit animation plays out.
    const isVisuallyActive = active && isPresent;
    const dirtyDescriptionId = `${tabId}-dirty`;
    const statusDescriptionId = `${tabId}-status`;
    const descriptions = [
        ...(isPresent && dirty ? [dirtyDescriptionId] : []),
        ...(isPresent && status ? [statusDescriptionId] : []),
    ];
    const tab = (
        <m.div
            className={cn(
                'work-tab group relative flex items-center border-r border-border bg-surface text-muted [-webkit-app-region:no-drag] hover:bg-elevated hover:text-foreground',
                !isPresent && 'pointer-events-none',
                isVisuallyActive &&
                    "active bg-background text-foreground after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-background after:content-['']",
            )}
            data-terminal-id={terminalId}
            data-motion-identity={motionIdentity}
            data-preview={preview || undefined}
            data-tab-active={isVisuallyActive || undefined}
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
            // Middle-click closes the tab, matching the VS Code norm; `auxclick`'s `button`
            // still needs the explicit check because some platforms also fire it for the
            // secondary (right) button when `contextmenu` is not prevented.
            onAuxClick={(event) => {
                if (event.button === 1) onClose();
            }}
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
                id={isPresent ? tabId : undefined}
                aria-controls={isVisuallyActive ? `${tabId}-panel` : undefined}
                aria-describedby={descriptions.length > 0 ? descriptions.join(' ') : undefined}
                aria-selected={isVisuallyActive}
                tabIndex={isVisuallyActive ? 0 : -1}
                className="tab-select flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-2 text-left text-[11px] text-inherit"
                onBlur={(event) => delete event.currentTarget.dataset.preserveTerminalFocus}
                onClick={onSelect}
                onKeyDown={onKeyDown}
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
                {accessory}
            </button>
            {isPresent && dirty && (
                <span id={dirtyDescriptionId} className="sr-only">
                    Unsaved changes.
                </span>
            )}
            {isPresent && status && (
                <span id={statusDescriptionId} className="sr-only">
                    {processStateDescription(status)}
                </span>
            )}
            {/* DESIGN.md's tab-strip redline: "Dirty dot replaces the close button until
                hover/focus" — one slot, not two. The dirty dot and the Terminal status dot both
                live here (mutually exclusive: dirty only applies to editor tabs, status only to
                Terminal tabs) and fade out in favor of the close button on hover/focus. */}
            <span className="tab-tail relative h-6 w-6 flex-none">
                {dirty && (
                    <b
                        aria-hidden="true"
                        className="dirty-dot absolute inset-0 m-auto grid h-fit place-items-center text-[10px] text-warning group-focus-within:opacity-0 group-hover:opacity-0"
                    >
                        ●
                    </b>
                )}
                {!dirty && status && (
                    <i
                        aria-hidden="true"
                        className={cn(
                            processIndicatorClassName,
                            'absolute inset-0 m-auto',
                            'group-focus-within:opacity-0 group-hover:opacity-0',
                            `process-${status}`,
                            status === 'running'
                                ? 'bg-success'
                                : ['dead', 'failed', 'interrupted'].includes(status) && 'bg-danger',
                        )}
                    />
                )}
                <Tooltip content={closeLabel}>
                    <button
                        type="button"
                        className="tab-close pointer-events-none absolute inset-0 m-auto grid h-5 w-5 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-inherit opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-[var(--selection)]"
                        aria-label={closeLabel}
                        tabIndex={-1}
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
