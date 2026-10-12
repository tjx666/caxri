import type {
    DragEvent,
    KeyboardEvent,
    MouseEvent as ReactMouseEvent,
    ReactElement,
    ReactNode,
    RefObject,
} from 'react';
import { useEffect, useRef, useState } from 'react';

import { Bot, ChartColumn, Gauge, Settings, SquareTerminal, X } from 'lucide-react';
import { useIsPresent } from 'motion/react';
import * as m from 'motion/react-m';

import { useIsOverflowing } from '@/hooks/use-is-overflowing';
import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { ContextMenuTrigger } from '../../components/context-menu-trigger';
import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import type { AgentIconIdentity } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import type { ContextMenuEntries } from '../../lib/context-menu';
import type { GitDecoration } from '../../lib/git-decorations';
import { gitDecorationClassName } from '../../lib/git-decorations';
import { motionDurationMs, motionEasing } from '../../lib/motion';
import { cn } from '../../lib/utilities';
import { workTabDescription } from './work-tab-accessibility';

/**
 * Wraps the tab in the shared `Tooltip` only when there is an untruncated title to reveal, so an Editor tab keeps its
 * current tooltip-free behavior. The tooltip hangs off the `role="tab"` button rather than the label span because that
 * is the focusable element: a native `title` attribute would be pointer-only.
 *
 * `disabled` (rather than unmounting the wrapper) is what suppresses a redundant tooltip: Base UI's trigger owns the
 * tab's DOM `id` whenever this wrapper renders, so mounting and unmounting it as the label's measured overflow changes
 * would make that id blink in and out from under `aria-controls` and roving focus.
 *
 * `hoverOnly` because a tab is routinely focused by the app rather than by the user: `useTabFocusRecovery` hands the
 * active tab keyboard focus whenever a layout edit leaves focus on `document.body` (including after `Cmd+P` opens a
 * Document) and a focus-opened path tooltip then parks itself over the top of the Editor with nothing to dismiss it.
 * The path is in the tab's accessible name either way (`WorkTabLabel`'s `sr-only` span), so nothing is lost.
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
        <Tooltip content={content} disabled={disabled} hoverOnly triggerId={triggerId}>
            {children}
        </Tooltip>
    );
}

interface WorkTabProperties {
    active: boolean;
    accessory?: ReactNode;
    /**
     * Whether the tab offers its own close affordance: the button and the middle-click shortcut. The Workbench's lone
     * tab sets `false`: closing it leaves an empty pane whose only content is the "New Terminal" button it just
     * replaced, so the X is an invitation to undo the workspace rather than to tidy it. This is the same threshold that
     * already drops the active accent and the bar's "+" (see `PaneTabBar`), and `cmd+w` plus the tab's context menu
     * keep the command reachable.
     */
    closable?: boolean;
    closeLabel: string;
    /**
     * Muted text after the label that tells same-named tabs apart, such as the parent directory of an external file
     * whose filename repeats (VS Code's tab description). It is also spoken through the tab's accessible description.
     */
    detail?: string;
    /**
     * A fact spoken through the tab's accessible description but not drawn, such as "Outside every Project".
     */
    accessibleDetail?: string;
    dirty?: boolean;
    fileIconName?: string;
    /**
     * Whether this tab grows to fill the remaining pane bar (a Terminal) or sizes to its label (a document).
     */
    fill: boolean;
    /**
     * Working-tree state of the file this tab holds, when it holds one. Mirrors VS Code, which paints the same
     * `gitDecoration.*` color and status letter on a tab as on its file tree row, so a modified file is recognizable
     * whichever of the two the user is looking at. Terminal tabs never set it.
     */
    gitDecoration?: GitDecoration;
    /**
     * `'file'` resolves a file type icon from `fileIconName`; `'settings'` is the Settings tab's own glyph, matching VS
     * Code, whose Settings editor tab shows a settings icon rather than the JSON file it is stored in. `'agent-task'`
     * and `'shell-task'` mark an Agent Chat's subagent and background shell tabs with the glyphs their timeline rows
     * use.
     */
    icon:
        | 'file'
        | 'settings'
        | 'usage'
        | 'agent-task'
        | 'shell-task'
        | 'agent-status'
        | AgentIconIdentity;
    label: string;
    /**
     * Hover/focus detail shown alongside `label`. For a Terminal this is the untruncated title behind an abbreviated
     * `label` (see `terminalTabLabel`), so it also replaces `label` in the accessible tree: the compression is a real
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
    /**
     * Whether the tab draws the 1px rule on its right edge. The rail's last tab has nothing to its right to be
     * separated from, so the rule would only paint a stray dark line down the pane's top-right corner.
     */
    showTrailingSeparator?: boolean;
    preview?: boolean;
    tabId: string;
    /**
     * Raw pane-tab occurrence id, distinct from {@link tabId} (its DOM-safe, prefixed form): read back off
     * `data-pane-tab-id` at drop time to resolve where in the tab order a drag landed.
     */
    paneTabId: string;
    terminalId?: string;
    /**
     * Builds the tab's native right-click menu when it opens.
     */
    contextMenu?: () => ContextMenuEntries | Promise<ContextMenuEntries>;
    onClose: () => void;
    onDoubleClick?: () => void;
    onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
    onSelect: () => void;
}

/**
 * Animated `maxWidth` ceiling shared by every tab kind. It only has to exceed any realistic pane width: it exists to
 * give the enter/exit width animation a numeric value to travel between, and must stay numeric; Motion cannot
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
    // Tokens require a live DOM; capture each tab's timing once instead of reading styles on every render.
    const [durations] = useState(() => ({
        enterEase: motionEasing('--motion-ease-enter'),
        enterS: motionDurationMs('--motion-tab-enter') / 1000,
        exitEase: motionEasing('--motion-ease-exit'),
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
        enterEase: durations.enterEase,
        exitDuration,
        exitEase: durations.exitEase,
        isPresent,
        style: {
            minWidth: isSettled ? targetMinWidth : 0,
            overflow: isSettled ? 'visible' : 'hidden',
        },
    } as const;
}

/**
 * Built-in glyphs for tabs that show neither a file nor an Agent. Settings takes the gear: the sliders glyph is the
 * Settings page's own "UI" view toggle, and one glyph meaning two things on one screen read as a duplicate.
 */
const WORK_TAB_GLYPHS = {
    'settings': Settings,
    'usage': ChartColumn,
    'agent-task': Bot,
    'shell-task': SquareTerminal,
    'agent-status': Gauge,
} as const;

function isWorkTabGlyph(icon: WorkTabProperties['icon']): icon is keyof typeof WORK_TAB_GLYPHS {
    return Object.hasOwn(WORK_TAB_GLYPHS, icon);
}

function WorkTabIcon({
    fileIconName,
    icon,
    label,
}: Pick<WorkTabProperties, 'fileIconName' | 'icon' | 'label'>) {
    if (icon === 'file')
        return <FileTypeIcon entry={{ kind: 'file', name: fileIconName ?? label }} />;
    if (isWorkTabGlyph(icon)) {
        const Glyph = WORK_TAB_GLYPHS[icon];
        return <Glyph aria-hidden="true" className="h-4 w-4 flex-none" size={14} />;
    }
    return <AgentIdentityIcon identity={icon} size={13} />;
}

/**
 * What the tab shows to identify its content: the type or Agent icon, the label, and the Git state VS Code paints over
 * that label. Split out of {@link WorkTabSelect}, which is left owning the button's tooltip and aria wiring.
 */
function WorkTabLabel({
    detail,
    fileIconName,
    gitDecoration,
    icon,
    isLabelAbbreviated,
    label,
    labelReference,
    labelTooltip,
    preview,
}: Pick<
    WorkTabProperties,
    'detail' | 'fileIconName' | 'gitDecoration' | 'icon' | 'label' | 'labelTooltip' | 'preview'
> & {
    /**
     * Whether `labelTooltip` holds information the displayed `label` dropped, and so must be spoken in its place.
     */
    isLabelAbbreviated: boolean;
    /**
     * Measured by the caller's `useIsOverflowing` to decide whether the tooltip would be redundant.
     */
    labelReference: RefObject<HTMLSpanElement | null>;
}) {
    return (
        <>
            <WorkTabIcon fileIconName={fileIconName} icon={icon} label={label} />
            <span
                ref={labelReference}
                aria-hidden={isLabelAbbreviated}
                className={cn(
                    /*
                     * Crowded rails scroll rather than truncate, but one document label longer than the whole rail
                     * would push its own close button out of reach, so it stops 6rem short of the scrolling rail's
                     * `@container` (icon, padding, close). Terminal labels keep their full width. Only the scrolling
                     * rail is a container: the sticky rail sizes to its own tabs, and inline-size containment would
                     * collapse it to nothing. The 8rem floor keeps a narrow editor group from cutting every title to a
                     * few letters ("Cla", "s"): below it the rail scrolls, as DESIGN.md asks, instead of crushing labels.
                     */
                    'tab-label max-w-[max(calc(100cqw-6rem),8rem)] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap group-data-[fill=true]:max-w-none',
                    preview && 'italic',
                    /*
                     * Overrides the tab's own muted/foreground color, including on the inactive tabs: the point of
                     * the decoration is to be readable across the whole rail without selecting each tab.
                     */
                    gitDecoration && gitDecorationClassName(gitDecoration.kind),
                )}
            >
                {label}
            </span>
            {isLabelAbbreviated && <span className="sr-only">{labelTooltip}</span>}
            {detail && (
                // Spoken through the tab's description instead, so the accessible name stays the bare filename.
                <span
                    aria-hidden="true"
                    className="tab-detail max-w-40 min-w-0 shrink overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted"
                >
                    {detail}
                </span>
            )}
            {gitDecoration && (
                <GitFileStatusLetter className="text-[10px]" decoration={gitDecoration} />
            )}
        </>
    );
}

/**
 * The tab's trailing affordance: the unsaved-changes dot, and the close button that takes its place under the pointer
 * or keyboard focus.
 */
function WorkTabTail({
    closable,
    closeLabel,
    dirty,
    isVisuallyActive,
    onClose,
}: Pick<WorkTabProperties, 'closeLabel' | 'dirty' | 'onClose'> & {
    closable: boolean;
    isVisuallyActive: boolean;
}) {
    // Nothing left to reserve the trailing slot for: no close button to reveal and no unsaved state to report.
    if (!closable && !dirty) return null;
    return (
        <span className="tab-tail relative h-6 w-6 flex-none">
            {dirty && (
                <b
                    aria-hidden="true"
                    className={cn(
                        'dirty-dot absolute inset-0 m-auto grid h-fit place-items-center text-[10px] text-warning',
                        // The dot only yields to the close button when there is one to swap in.
                        closable && 'group-focus-within:opacity-0 group-hover:opacity-0',
                    )}
                >
                    ●
                </b>
            )}
            {closable && (
                <Tooltip content={closeLabel}>
                    <button
                        type="button"
                        className={cn(
                            'tab-close absolute inset-0 m-auto grid h-5 w-5 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 hover:bg-[var(--selection)] hover:text-foreground',
                            /*
                             * VS Code's rule: the active tab always offers its close button, and an inactive tab reveals a
                             * dimmer one only under the pointer or keyboard focus. Hunting for a control that is always
                             * there on the tab you are actually working in is the friction this removes; keeping the
                             * inactive ones muted is what stops a crowded rail from reading as a row of X's.
                             */
                            'pointer-events-none text-muted opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
                            // A dirty tab still shows its dot instead, and swaps to the button on hover/focus above.
                            isVisuallyActive &&
                                !dirty &&
                                'pointer-events-auto text-inherit opacity-100',
                        )}
                        aria-label={closeLabel}
                        tabIndex={-1}
                        onClick={onClose}
                    >
                        <X size={12} />
                    </button>
                </Tooltip>
            )}
        </span>
    );
}

function WorkTabSelect({
    accessory,
    active,
    description,
    detail,
    tabDescriptionId,
    fileIconName,
    gitDecoration,
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
    | 'detail'
    | 'fileIconName'
    | 'gitDecoration'
    | 'icon'
    | 'keepLabelAsAccessibleName'
    | 'label'
    | 'labelTooltip'
    | 'onKeyDown'
    | 'onSelect'
    | 'preview'
    | 'tabId'
> & {
    /**
     * Everything the tab shows but its name cannot say: its location detail, unsaved state, and Git state. Empty when
     * none apply.
     */
    description: string;
    tabDescriptionId: string;
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
                aria-describedby={isPresent && description ? tabDescriptionId : undefined}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="tab-select flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-2 text-left text-[11px] text-inherit focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
                onBlur={(event) => delete event.currentTarget.dataset.preserveTerminalFocus}
                onClick={onSelect}
                onKeyDown={onKeyDown}
            >
                <WorkTabLabel
                    detail={detail}
                    fileIconName={fileIconName}
                    gitDecoration={gitDecoration}
                    icon={icon}
                    isLabelAbbreviated={isLabelAbbreviated}
                    label={label}
                    labelReference={labelReference}
                    labelTooltip={labelTooltip}
                    preview={preview}
                />
                {accessory}
            </button>
        </MaybeTooltip>
    );
}

export function WorkTab({
    active,
    accessory,
    closable = true,
    closeLabel,
    detail,
    accessibleDetail,
    dirty,
    fileIconName,
    fill,
    gitDecoration,
    icon,
    label,
    labelTooltip,
    keepLabelAsAccessibleName,
    motionIdentity,
    showActiveAccent,
    showTrailingSeparator = true,
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
    const { t } = useTranslation();
    const { enterDuration, enterEase, exitDuration, exitEase, isPresent, style } =
        useWorkTabMotion(fill);
    // Exiting tabs must never look or behave active: force the non-active visual state and lock
    // out pointer/keyboard interaction while the exit animation plays out.
    const isVisuallyActive = active && isPresent;
    const tabDescriptionId = `${tabId}-description`;
    // Rendered outside the `role="tab"` button below, so the tab's accessible name stays the bare filename.
    const description = workTabDescription({ accessibleDetail, detail, dirty, gitDecoration }, t);
    const tab = (
        <m.div
            style={style}
            className={cn(
                'work-tab group relative flex items-center bg-tab-inactive-background text-tab-inactive-foreground [-webkit-app-region:no-drag] hover:bg-tab-hover-background hover:text-tab-hover-foreground',
                // Balances `tab-select`'s own leading `px-2` around the trailing slot, so the close button's hover fill
                // stops short of the tab's separator instead of running into it the way VS Code's never does.
                'min-w-0 pr-1.5',
                showTrailingSeparator && 'border-r border-border',
                fill
                    ? // `basis-0` is what makes the division even: without it flex distributes only the
                      // leftover space, so a long label would still win a wider slot than a short one.
                      'flex-1 basis-0'
                    : // Keep the full label; the surrounding rail owns overflow once Terminal tabs reach their floor.
                      'flex-none',
                !isPresent && 'pointer-events-none',
                isVisuallyActive &&
                    // The `after` hairline erases the seam between the active tab and the editor below it, so it
                    // tracks the tab's own fill rather than the canvas: a theme may give them different colors.
                    "active bg-tab-active-background text-tab-active-foreground after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-tab-active-background after:content-['']",
                isVisuallyActive &&
                    showActiveAccent !== false &&
                    "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent before:content-['']",
            )}
            data-fill={fill}
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
                if (closable && event.button === 1) onClose();
            }}
            // `maxWidth` is animated from 0 (rather than set as static CSS) because CSS resolves `min-width` above
            // `max-width`: a static floor would override the `maxWidth: 0` enter keyframe and the enter/exit width
            // animation would never play. `minWidth`/`overflow` are deliberately absent here; see the `style` prop
            // above and the comment on `hasSettled`.
            initial={{ maxWidth: 0, opacity: 0 }}
            animate={{
                maxWidth: TAB_MAX_WIDTH,
                opacity: 1,
                transition: { duration: enterDuration, ease: enterEase },
            }}
            exit={{
                maxWidth: 0,
                opacity: 0,
                transition: { duration: exitDuration, ease: exitEase },
            }}
        >
            <WorkTabSelect
                accessory={accessory}
                active={isVisuallyActive}
                description={description}
                detail={detail}
                tabDescriptionId={tabDescriptionId}
                fileIconName={fileIconName}
                gitDecoration={gitDecoration}
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
            {isPresent && description && (
                <span id={tabDescriptionId} className="sr-only">
                    {description}
                </span>
            )}
            <WorkTabTail
                closable={closable}
                closeLabel={closeLabel}
                dirty={dirty}
                isVisuallyActive={isVisuallyActive}
                onClose={onClose}
            />
        </m.div>
    );
    if (!contextMenu) return tab;
    return <ContextMenuTrigger menu={contextMenu}>{tab}</ContextMenuTrigger>;
}
