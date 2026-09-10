import type {
    DragEvent,
    KeyboardEvent,
    MouseEvent as ReactMouseEvent,
    ReactElement,
    ReactNode,
} from 'react';
import { useEffect, useRef, useState } from 'react';

import { X } from 'lucide-react';
import { useIsPresent } from 'motion/react';
import * as m from 'motion/react-m';

import { useIsOverflowing } from '@/hooks/use-is-overflowing';
import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { ContextMenu, ContextMenuTrigger } from '../../components/ui/context-menu';
import { Tooltip } from '../../components/ui/tooltip';
import type { AgentIconIdentity } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { motionDurationMs } from '../../lib/motion';
import { cn } from '../../lib/utilities';

/**
 * Wraps the tab in the shared `Tooltip` only when there is an untruncated title to reveal, so an Editor tab keeps its
 * current tooltip-free behavior. The tooltip hangs off the `role="tab"` button rather than the label span because that
 * is the focusable element — a native `title` attribute would be pointer-only.
 *
 * `disabled` (rather than unmounting the wrapper) is what suppresses a redundant tooltip: Base UI's trigger owns the
 * tab's DOM `id` whenever this wrapper renders, so mounting and unmounting it as the label's measured overflow changes
 * would make that id blink in and out from under `aria-controls` and roving focus.
 */
function MaybeTooltip({
    children,
    content,
    disabled,
    triggerId,
}: {
    children: ReactElement;
    content?: string;
    disabled?: boolean;
    triggerId?: string;
}) {
    if (!content) return children;
    return (
        <Tooltip content={content} disabled={disabled} triggerId={triggerId}>
            {children}
        </Tooltip>
    );
}

interface WorkTabProperties {
    active: boolean;
    accessory?: ReactNode;
    closeLabel: string;
    dirty?: boolean;
    fileIconName?: string;
    /**
     * Whether this tab grows to fill the remaining pane bar (a Terminal) or sizes to its label (a document).
     */
    fill: boolean;
    icon: 'file' | AgentIconIdentity;
    label: string;
    /**
     * Hover/focus detail shown alongside `label`. For a Terminal this is the untruncated title behind an abbreviated
     * `label` (see `terminalTabLabel`), so it also replaces `label` in the accessible tree — the compression is a real
     * loss of information a screen reader user needs back. A Document tab's `labelTooltip` is its full path, a
     * different (not fuller) representation of the same file, so `keepLabelAsAccessibleName` stops it from overriding
     * the filename a screen reader announces.
     */
    labelTooltip?: string;
    keepLabelAsAccessibleName?: boolean;
    motionIdentity?: string;
    /**
     * Whether the active tab wears its accent bar. A lone tab in the whole Workbench has no sibling to be distinguished
     * from, so the bar would be marking a choice the user never made; the active pane's own accent ring (`PaneBox`)
     * already says where focus is. Mirrors iTerm2, which hides its tab chrome at one tab.
     */
    showActiveAccent?: boolean;
    preview?: boolean;
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
 * Animated `maxWidth` ceiling shared by every tab kind. It only has to exceed any realistic pane width: it exists to
 * give the enter/exit width animation a numeric value to travel between, and must stay numeric — Motion cannot
 * interpolate `'none'`, so a settled tab holding that string would make the exit animation collapse in one frame.
 */
const TAB_MAX_WIDTH = 2000;

/**
 * Floor for an evenly divided Terminal tab. Its displayed title and accessories stay readable as content changes; the
 * bar's `overflow-x-auto` takes over once every tab reaches its own intrinsic width.
 */
const TERMINAL_TAB_MIN_WIDTH = 'max-content';

/**
 * Document tabs keep their intrinsic filename width, matching VS Code's default `tabSizing: fit`. Overflow scrolls the
 * rail instead of abbreviating filenames while adjacent Terminal tabs still have unused room.
 */
const DOCUMENT_TAB_MIN_WIDTH = 50;

function useWorkTabMotion(shouldFill: boolean) {
    const isPresent = useIsPresent();
    const isReducedMotion = useShouldReduceMotion();
    // Tokens require a live DOM; capture each tab's durations once instead of reading styles on every render.
    const [durations] = useState(() => ({
        enterS: motionDurationMs('--motion-tab-enter') / 1000,
        exitS: motionDurationMs('--motion-tab-exit') / 1000,
    }));
    const enterDuration = isReducedMotion ? 0 : durations.enterS;
    const exitDuration = isReducedMotion ? 0 : durations.exitS;
    const targetMinWidth = shouldFill ? TERMINAL_TAB_MIN_WIDTH : DOCUMENT_TAB_MIN_WIDTH;
    /**
     * Keep the settled floor outside Motion's managed keys: sibling mounts can make Motion reapply its initial 0 even
     * after a transitionEnd update. Exiting tabs release the floor immediately so their width can collapse.
     */
    const [hasSettled, setHasSettled] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setHasSettled(true), enterDuration * 1_000);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for this tab's own enter animation; enterDuration is fixed for its lifetime
    }, []);
    const isSettled = isPresent && hasSettled;
    return {
        enterDuration,
        exitDuration,
        isPresent,
        style: {
            minWidth: isSettled ? targetMinWidth : 0,
            overflow: isSettled ? 'visible' : 'hidden',
        },
    } as const;
}

function WorkTabSelect({
    accessory,
    active,
    dirty,
    dirtyDescriptionId,
    fileIconName,
    icon,
    isPresent,
    keepLabelAsAccessibleName,
    label,
    labelTooltip,
    onKeyDown,
    onSelect,
    preview,
    tabId,
}: Pick<
    WorkTabProperties,
    | 'accessory'
    | 'active'
    | 'dirty'
    | 'fileIconName'
    | 'icon'
    | 'keepLabelAsAccessibleName'
    | 'label'
    | 'labelTooltip'
    | 'onKeyDown'
    | 'onSelect'
    | 'preview'
    | 'tabId'
> & {
    dirtyDescriptionId: string;
    isPresent: boolean;
}) {
    /**
     * Path abbreviation is visual only; keep the full title accessible without replacing a Document's filename with its
     * path. Content sizing preserves the displayed label but does not undo title abbreviation.
     */
    const isLabelAbbreviated =
        Boolean(labelTooltip) && labelTooltip !== label && !keepLabelAsAccessibleName;
    const labelReference = useRef<HTMLSpanElement>(null);
    const isLabelClipped = useIsOverflowing(labelReference, label);
    const isTooltipRedundant = labelTooltip === label && !isLabelClipped;
    /**
     * Omit the key while Tooltip owns it: Base UI merges child props last, so even `id={undefined}` would erase its
     * trigger id and break aria-controls and roving focus. Keep the same ownership during tab exit.
     */
    const tabIdProperty = labelTooltip || !isPresent ? {} : { id: tabId };
    return (
        <MaybeTooltip
            content={labelTooltip}
            disabled={isTooltipRedundant}
            triggerId={isPresent ? tabId : undefined}
        >
            <button
                {...tabIdProperty}
                type="button"
                role="tab"
                aria-controls={active ? `${tabId}-panel` : undefined}
                aria-describedby={isPresent && dirty ? dirtyDescriptionId : undefined}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="tab-select flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-2 text-left text-[11px] text-inherit focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
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
                    ref={labelReference}
                    aria-hidden={isLabelAbbreviated}
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
    );
}

export function WorkTab({
    active,
    accessory,
    closeLabel,
    dirty,
    fileIconName,
    fill,
    icon,
    label,
    labelTooltip,
    keepLabelAsAccessibleName,
    motionIdentity,
    showActiveAccent,
    preview,
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
    const { enterDuration, exitDuration, isPresent, style } = useWorkTabMotion(fill);
    // Exiting tabs must never look or behave active: force the non-active visual state and lock
    // out pointer/keyboard interaction while the exit animation plays out.
    const isVisuallyActive = active && isPresent;
    const dirtyDescriptionId = `${tabId}-dirty`;
    const tab = (
        <m.div
            style={style}
            className={cn(
                'work-tab group relative flex items-center border-r border-border bg-surface text-muted [-webkit-app-region:no-drag] hover:bg-elevated hover:text-foreground',
                'min-w-0',
                fill
                    ? // `basis-0` is what makes the division even: without it flex distributes only the
                      // leftover space, so a long label would still win a wider slot than a short one.
                      'flex-1 basis-0'
                    : // Keep the full label; the surrounding rail owns overflow once Terminal tabs reach their floor.
                      'flex-none',
                !isPresent && 'pointer-events-none',
                isVisuallyActive &&
                    "active bg-background text-foreground after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-background after:content-['']",
                isVisuallyActive &&
                    showActiveAccent !== false &&
                    "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent before:content-['']",
            )}
            data-pane-tab-id={paneTabId}
            data-terminal-id={terminalId}
            data-motion-identity={motionIdentity}
            data-preview={preview ? true : undefined}
            data-tab-active={isVisuallyActive || undefined}
            aria-hidden={!isPresent}
            inert={!isPresent}
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
            onAuxClick={(event: ReactMouseEvent<HTMLDivElement>) => {
                if (event.button === 1) onClose();
            }}
            // `maxWidth` is animated from 0 (rather than set as static CSS) because CSS resolves `min-width` above
            // `max-width`: a static floor would override the `maxWidth: 0` enter keyframe and the enter/exit width
            // animation would never play. `minWidth`/`overflow` are deliberately absent here — see the `style` prop
            // above and the comment on `hasSettled`.
            initial={{ maxWidth: 0, opacity: 0 }}
            animate={{
                maxWidth: TAB_MAX_WIDTH,
                opacity: 1,
                transition: { duration: enterDuration, ease: 'easeOut' },
            }}
            exit={{
                maxWidth: 0,
                opacity: 0,
                transition: { duration: exitDuration, ease: 'easeIn' },
            }}
        >
            <WorkTabSelect
                accessory={accessory}
                active={isVisuallyActive}
                dirty={dirty}
                dirtyDescriptionId={dirtyDescriptionId}
                fileIconName={fileIconName}
                icon={icon}
                isPresent={isPresent}
                keepLabelAsAccessibleName={keepLabelAsAccessibleName}
                label={label}
                labelTooltip={labelTooltip}
                onKeyDown={onKeyDown}
                onSelect={onSelect}
                preview={preview}
                tabId={tabId}
            />
            {isPresent && dirty && (
                <span id={dirtyDescriptionId} className="sr-only">
                    Unsaved changes.
                </span>
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
