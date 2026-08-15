import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type HTMLAttributes,
    type KeyboardEvent,
    type ReactElement,
    type ReactNode,
} from 'react';

import { usePrefersReducedMotion } from '../lib/motion';
import { cn } from '../lib/utils';

interface ChromeTabItem<Value extends string> {
    content: ReactNode;
    label: string;
    value: Value;
}

interface ChromeTabsProps<Value extends string> {
    ariaLabel: string;
    className?: string;
    idPrefix: string;
    items: readonly ChromeTabItem<Value>[];
    onValueChange: (value: Value) => void;
    renderTab?: (item: ChromeTabItem<Value>, tab: ReactElement) => ReactNode;
    tabClassName?: string;
    value: Value;
}

interface IndicatorGeometry {
    left: number;
    width: number;
}

/** Shared top-level chrome tabs with automatic activation and one measured moving indicator. */
export function ChromeTabs<Value extends string>({
    ariaLabel,
    className,
    idPrefix,
    items,
    onValueChange,
    renderTab,
    tabClassName,
    value,
}: ChromeTabsProps<Value>) {
    const reducedMotion = usePrefersReducedMotion();
    const listRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef(new Map<Value, HTMLButtonElement>());
    const contentRefs = useRef(new Map<Value, HTMLSpanElement>());
    const [geometry, setGeometry] = useState<IndicatorGeometry>();
    const [motionReady, setMotionReady] = useState(false);

    const measureIndicator = useCallback((): void => {
        const list = listRef.current;
        const content = contentRefs.current.get(value);
        if (!list || !content) return;
        const listBox = list.getBoundingClientRect();
        const contentBox = content.getBoundingClientRect();
        /** Dialog enter motion scales client rects; normalize them back into this list's CSS pixels. */
        const scaleX = list.offsetWidth > 0 ? listBox.width / list.offsetWidth : 1;
        const next = {
            left: (contentBox.left - listBox.left) / scaleX,
            width: contentBox.width / scaleX,
        };
        setGeometry((current) =>
            current &&
            Math.abs(current.left - next.left) < 0.25 &&
            Math.abs(current.width - next.width) < 0.25
                ? current
                : next,
        );
    }, [value]);

    useLayoutEffect(() => {
        measureIndicator();
        const observer = new ResizeObserver(measureIndicator);
        if (listRef.current) observer.observe(listRef.current);
        for (const content of contentRefs.current.values()) observer.observe(content);
        return () => observer.disconnect();
    }, [items, measureIndicator]);

    useEffect(() => {
        const frame = requestAnimationFrame(() => setMotionReady(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    const activateFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
        let nextIndex: number | undefined;
        if (event.key === 'ArrowLeft') nextIndex = (at - 1 + items.length) % items.length;
        else if (event.key === 'ArrowRight') nextIndex = (at + 1) % items.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = items.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault();
        const next = items[nextIndex];
        onValueChange(next.value);
        tabRefs.current.get(next.value)?.focus();
    };

    return (
        <div
            ref={listRef}
            role="tablist"
            aria-label={ariaLabel}
            aria-orientation="horizontal"
            className={cn('relative', className)}
            data-slot="chrome-tabs"
        >
            {items.map((item, index) => {
                const selected = item.value === value;
                const tab = (
                    <button
                        ref={(element) => {
                            if (element) tabRefs.current.set(item.value, element);
                            else tabRefs.current.delete(item.value);
                        }}
                        id={`${idPrefix}-tab-${item.value}`}
                        role="tab"
                        type="button"
                        aria-controls={`${idPrefix}-panel-${item.value}`}
                        aria-label={item.label}
                        aria-selected={selected}
                        className={cn(
                            'relative flex items-center justify-center border-0 bg-surface text-muted cursor-pointer hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-foreground',
                            selected && 'active text-foreground',
                            tabClassName,
                        )}
                        data-value={item.value}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onValueChange(item.value)}
                        onKeyDown={(event) => activateFromKeyboard(event, index)}
                    >
                        <span
                            ref={(element) => {
                                if (element) contentRefs.current.set(item.value, element);
                                else contentRefs.current.delete(item.value);
                            }}
                            className="inline-flex items-center justify-center gap-1"
                            data-slot="chrome-tab-content"
                        >
                            {item.content}
                        </span>
                    </button>
                );
                return (
                    <Fragment key={item.value}>{renderTab ? renderTab(item, tab) : tab}</Fragment>
                );
            })}
            <span
                aria-hidden="true"
                className="absolute bottom-0 left-0 z-1 h-0.5 rounded-full bg-indicator pointer-events-none transition-[transform,width]"
                data-slot="chrome-tab-indicator"
                style={{
                    opacity: geometry ? 1 : 0,
                    transform: `translate3d(${geometry?.left ?? 0}px, 0, 0)`,
                    transitionDuration:
                        motionReady && !reducedMotion ? 'var(--motion-chrome-switch)' : '0ms',
                    transitionTimingFunction: 'var(--motion-ease-emphasized)',
                    width: geometry?.width ?? 0,
                }}
            />
        </div>
    );
}

interface ChromeTabPanelProps<Value extends string> extends HTMLAttributes<HTMLDivElement> {
    active: boolean;
    idPrefix: string;
    value: Value;
}

/** Mounted panel counterpart that keeps every tab's `aria-controls` target resolvable. */
export function ChromeTabPanel<Value extends string>({
    active,
    className,
    idPrefix,
    value,
    ...props
}: ChromeTabPanelProps<Value>) {
    return (
        <div
            {...props}
            id={`${idPrefix}-panel-${value}`}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-${value}`}
            className={className}
            hidden={!active}
        />
    );
}
