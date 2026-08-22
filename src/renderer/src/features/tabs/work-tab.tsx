import type { DragEvent, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';

import type { ProcessState } from '@shared/types';
import { X } from 'lucide-react';
import { useIsPresent } from 'motion/react';
import * as m from 'motion/react-m';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { ContextMenu, ContextMenuTrigger } from '../../components/ui/context-menu';
import { Tooltip } from '../../components/ui/tooltip';
import type { AgentIconIdentity } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { motionDurationMs } from '../../lib/motion';
import { cn } from '../../lib/utilities';
import { processStateDescription } from './work-tab-accessibility';

const processIndicatorClassName =
    'process-indicator w-1.5 h-1.5 flex-none m-0 rounded-full bg-muted';

/**
 * Wraps the tab in the shared `Tooltip` only when there is an untruncated title to reveal, so an Editor tab keeps its
 * current tooltip-free behavior. The tooltip hangs off the `role="tab"` button rather than the label span because that
 * is the focusable element — a native `title` attribute would be pointer-only.
 */
function MaybeTooltip({
    children,
    content,
    triggerId,
}: {
    children: ReactElement;
    content?: string;
    triggerId?: string;
}) {
    if (!content) return children;
    return (
        <Tooltip content={content} triggerId={triggerId}>
            {children}
        </Tooltip>
    );
}

function statusToneClassName(status: ProcessState): string | false {
    if (status === 'running') return 'bg-success';
    return ['dead', 'failed', 'interrupted'].includes(status) && 'bg-danger';
}

interface WorkTabProperties {
    active: boolean;
    accessory?: ReactNode;
    closeLabel: string;
    dirty?: boolean;
    fileIconName?: string;
    /**
     * Whether this tab grows to fill its pane's bar alongside its siblings (a Terminal) or is sized to its own content
     * up to a fixed cap (a document). The one place a tab's kind is allowed to reach past its own content into layout —
     * see `TERMINAL_TAB_MAX_WIDTH` / `DOCUMENT_TAB_MAX_WIDTH`.
     */
    fill: boolean;
    icon: 'file' | AgentIconIdentity;
    label: string;
    /**
     * Untruncated title behind an abbreviated `label`; see `terminalTabLabel`.
     */
    labelTooltip?: string;
    motionIdentity?: string;
    preview?: boolean;
    status?: ProcessState;
    /**
     * Agent activity for the Terminal that owns its Session's title, replacing raw process state on the status dot.
     * "The PTY is alive" and "the Agent is waiting for you" are different questions, and only the second one is worth
     * interrupting for; see `agentStatusDot`.
     */
    statusActivity?: { className: string; description: string };
    tabId: string;
    /**
     * Raw pane-tab occurrence id, distinct from {@link tabId} (its DOM-safe, prefixed form): read back off
     * `data-pane-tab-id` at drop time to resolve where in the tab order a drag landed.
     */
    paneTabId: string;
    terminalId?: string;
    contextMenu?: ReactNode;
    onClose: () => void;
    onDoubleClick?: () => void;
    onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
    onSelect: () => void;
}

/**
 * A Terminal tab divides its pane's bar equally with its Terminal siblings, with no maximum width: Caxri is
 * terminal-first — most Sessions never open an editor — and a Terminal tab's title is the only thing that tells two
 * Agents apart, so the room goes to the title. This bound only has to exceed any realistic pane width, since it exists
 * to give the enter/exit width animation something to travel to.
 */
const TERMINAL_TAB_MAX_WIDTH = 2000;

/**
 * Floor for an evenly divided Terminal tab. Once enough Terminal tabs are open to push past it, flex stops shrinking
 * and the bar's `overflow-x-auto` takes over — even division degrades to scrolling rather than to unreadable slivers.
 */
const TERMINAL_TAB_MIN_WIDTH = 80;

/**
 * An Editor tab never competes with Terminal tabs for the bar's width: it is sized to its filename, capped so one long
 * path cannot crowd out every Terminal tab next to it. Mirrors VS Code's `workbench.editor.tabSizingFixedMaxWidth` /
 * `tabSizingFixedMinWidth` defaults (`competitors/vscode/.../workbench.contribution.ts`).
 */
const DOCUMENT_TAB_MAX_WIDTH = 160;
const DOCUMENT_TAB_MIN_WIDTH = 50;

export function WorkTab({
    active,
    accessory,
    closeLabel,
    dirty = false,
    fileIconName,
    fill,
    icon,
    label,
    labelTooltip,
    motionIdentity,
    preview = false,
    status,
    statusActivity,
    tabId,
    paneTabId,
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
    /**
     * `terminalTabLabel` compresses a PTY title to fit the tab, and CSS truncates whatever still overflows. Both losses
     * are visual only: the untouched title stays the tab's accessible name (below) and its tooltip, so a keyboard user
     * reaches it the same way a pointer user does.
     */
    const isLabelAbbreviated = Boolean(labelTooltip) && labelTooltip !== label;
    /**
     * Spread rather than written inline because the key has to be _absent_, not `undefined`, whenever the tooltip owns
     * it: Base UI merges the rendered element's own props last, so `id={undefined}` erases the trigger id it writes and
     * leaves the tab with no id for `aria-controls`/roving focus to target. See `Tooltip`'s `triggerId`.
     */
    const tabIdProperty = labelTooltip || !isPresent ? {} : { id: tabId };
    const targetMinWidth = fill ? TERMINAL_TAB_MIN_WIDTH : DOCUMENT_TAB_MIN_WIDTH;
    // Motion keeps re-applying whatever value it last resolved for a key present in `initial`/`animate`/`exit` on
    // every re-render of the component, even to a plain DOM mutation made outside Motion — so `minWidth` and
    // `overflow` cannot be Motion-managed keys landed via `transitionEnd` or an animation-complete callback: when
    // several tabs mount together (e.g. opening many Terminals back to back), a later sibling's mount re-renders
    // every already-mounted tab, and Motion stomps an already-landed floor back to its stale `initial` value of 0.
    // Tracking "has this tab's enter animation finished" as plain React state instead keeps the floor entirely
    // outside Motion's reach.
    const [hasSettled, setHasSettled] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setHasSettled(true), enterDuration * 1_000);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for this tab's own enter animation; enterDuration is fixed for its lifetime
    }, []);
    const isSettled = isPresent && hasSettled;
    const tab = (
        <m.div
            style={{
                minWidth: isSettled ? targetMinWidth : 0,
                overflow: isSettled ? 'visible' : 'hidden',
            }}
            className={cn(
                'work-tab group relative flex items-center border-r border-border bg-surface text-muted [-webkit-app-region:no-drag] hover:bg-elevated hover:text-foreground',
                'min-w-0',
                fill
                    ? // `basis-0` is what makes the division even: without it flex distributes only the
                      // leftover space, so a long label would still win a wider slot than a short one.
                      'flex-1 basis-0'
                    : // A document tab never grows or shrinks with its siblings; `min-w-0` above still lets its own
                      // label ellipsis-truncate once the animated `maxWidth` below clamps it.
                      'flex-none',
                !isPresent && 'pointer-events-none',
                isVisuallyActive &&
                    "active bg-background text-foreground before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent before:content-[''] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-background after:content-['']",
            )}
            data-pane-tab-id={paneTabId}
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
            // `maxWidth` is animated from 0 (rather than set as static CSS) because CSS resolves `min-width` above
            // `max-width`: a static floor would override the `maxWidth: 0` enter keyframe and the enter/exit width
            // animation would never play. `minWidth`/`overflow` are deliberately absent here — see the `style` prop
            // above and the comment on `hasSettled`.
            initial={{ maxWidth: 0, opacity: 0 }}
            animate={{
                maxWidth: fill ? TERMINAL_TAB_MAX_WIDTH : DOCUMENT_TAB_MAX_WIDTH,
                opacity: 1,
                transition: { duration: enterDuration, ease: 'easeOut' },
            }}
            exit={{
                maxWidth: 0,
                opacity: 0,
                transition: { duration: exitDuration, ease: 'easeIn' },
            }}
        >
            <MaybeTooltip content={labelTooltip} triggerId={isPresent ? tabId : undefined}>
                <button
                    {...tabIdProperty}
                    type="button"
                    role="tab"
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
                        // Hiding visible text is normally wrong, but here the sr-only sibling carries the
                        // same string in full, so the accessible name gains the elided part instead of
                        // losing anything — and the badge in `accessory` still contributes to it.
                        aria-hidden={isLabelAbbreviated || undefined}
                        className={cn(
                            'tab-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap',
                            preview && 'italic',
                        )}
                    >
                        {label}
                    </span>
                    {isLabelAbbreviated && <span className="sr-only">{labelTooltip}</span>}
                    {accessory}
                </button>
            </MaybeTooltip>
            {isPresent && dirty && (
                <span id={dirtyDescriptionId} className="sr-only">
                    Unsaved changes.
                </span>
            )}
            {isPresent && status && (
                <span id={statusDescriptionId} className="sr-only">
                    {statusActivity?.description ?? processStateDescription(status)}
                </span>
            )}
            {/* An evenly divided tab has room a natural-width one never had, so process state stops trading places with
                the close button: pointing at a Terminal to close it is exactly when hiding its state is least
                helpful. */}
            {status && (
                <i
                    aria-hidden="true"
                    title={statusActivity?.description}
                    className={cn(
                        processIndicatorClassName,
                        'mr-0.5',
                        `process-${status}`,
                        statusActivity?.className ?? statusToneClassName(status),
                    )}
                />
            )}
            <span className="tab-tail relative h-6 w-6 flex-none">
                {dirty && (
                    <b
                        aria-hidden="true"
                        className="dirty-dot absolute inset-0 m-auto grid h-fit place-items-center text-[10px] text-warning group-focus-within:opacity-0 group-hover:opacity-0"
                    >
                        ●
                    </b>
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
