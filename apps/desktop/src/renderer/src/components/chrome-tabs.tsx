import type { HTMLAttributes, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { cn } from '../lib/utilities';

interface ChromeTabItem<Value extends string> {
    content: ReactNode;
    label: string;
    description?: string;
    value: Value;
}

interface ChromeTabsProperties<Value extends string> {
    ariaLabel: string;
    className?: string;
    idPrefix: string;
    /**
     * Upper bound for the selected-tab mark. Only evenly divided rails need one: a slot that grows with the region
     * would otherwise stretch the mark into a bar. Natural-width tabs are already bounded by their own content.
     */
    indicatorMaxWidth?: number;
    items: ReadonlyArray<ChromeTabItem<Value>>;
    onValueChange: (value: Value) => void;
    renderTab?: (item: ChromeTabItem<Value>, tab: ReactElement) => ReactNode;
    tabClassName?: string;
    value: Value;
}

interface IndicatorGeometry {
    left: number;
    width: number;
}

/**
 * Trimmed off each side of the tab slot so the mark reads as belonging to the tab instead of butting against its
 * neighbours. Small enough that it never eats into the tab's own content.
 */
const INDICATOR_INSET = 8;

/**
 * Shared top-level chrome tabs with automatic activation and one measured moving indicator.
 */
export function ChromeTabs<Value extends string>({
    ariaLabel,
    className,
    idPrefix,
    indicatorMaxWidth = Infinity,
    items,
    onValueChange,
    renderTab,
    tabClassName,
    value,
}: ChromeTabsProperties<Value>) {
    const isReducedMotion = useShouldReduceMotion();
    const listReference = useRef<HTMLDivElement>(null);
    const tabReferences = useRef(new Map<Value, HTMLButtonElement>());
    const [geometry, setGeometry] = useState<IndicatorGeometry>();
    const [motionReady, setMotionReady] = useState(false);

    /**
     * The indicator is measured from the tab slot, not the label inside it, then inset and capped and centred in that
     * slot. In the SecondarySidebar's `auto-cols-fr` strip that makes every mark the same size, so it reads as "this
     * region is selected" rather than tracking a word whose length is incidental, and a responsive tab that drops its
     * label keeps its mark unchanged. The inset and cap keep an even division from looking like a segmented control.
     */
    const measureIndicator = useCallback((): void => {
        const list = listReference.current;
        const tab = tabReferences.current.get(value);
        if (!list || !tab) return;
        const listBox = list.getBoundingClientRect();
        const tabBox = tab.getBoundingClientRect();
        /**
         * Dialog enter motion scales client rects; normalize them back into this list's CSS pixels.
         */
        const scaleX = list.offsetWidth > 0 ? listBox.width / list.offsetWidth : 1;
        const slotLeft = (tabBox.left - listBox.left) / scaleX;
        const slotWidth = tabBox.width / scaleX;
        const width = Math.min(Math.max(slotWidth - INDICATOR_INSET * 2, 0), indicatorMaxWidth);
        const next = {
            left: slotLeft + (slotWidth - width) / 2,
            width,
        };
        setGeometry((current) =>
            current &&
            Math.abs(current.left - next.left) < 0.25 &&
            Math.abs(current.width - next.width) < 0.25
                ? current
                : next,
        );
    }, [indicatorMaxWidth, value]);

    useLayoutEffect(() => {
        measureIndicator();
        const observer = new ResizeObserver(measureIndicator);
        if (listReference.current) observer.observe(listReference.current);
        for (const tab of tabReferences.current.values()) observer.observe(tab);
        return () => observer.disconnect();
    }, [items, measureIndicator]);

    useEffect(() => {
        const frame = requestAnimationFrame(() => setMotionReady(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    const activateFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
        let nextIndex: number | undefined;
        switch (event.key) {
            case 'ArrowLeft': {
                nextIndex = (at - 1 + items.length) % items.length;
                break;
            }
            case 'ArrowRight': {
                nextIndex = (at + 1) % items.length;
                break;
            }
            case 'Home': {
                nextIndex = 0;
                break;
            }
            case 'End': {
                nextIndex = items.length - 1;
                // No default
                break;
            }
        }
        if (nextIndex === undefined) return;
        event.preventDefault();
        const next = items[nextIndex];
        onValueChange(next.value);
        tabReferences.current.get(next.value)?.focus();
    };

    return (
        <div
            ref={listReference}
            role="tablist"
            aria-label={ariaLabel}
            aria-orientation="horizontal"
            className={cn('relative', className)}
            data-slot="chrome-tabs"
        >
            {items.map((item, index) => {
                const isSelected = item.value === value;
                const tab = (
                    <button
                        ref={(element) => {
                            if (element) tabReferences.current.set(item.value, element);
                            else tabReferences.current.delete(item.value);
                        }}
                        id={`${idPrefix}-tab-${item.value}`}
                        role="tab"
                        type="button"
                        aria-controls={`${idPrefix}-panel-${item.value}`}
                        aria-label={item.label}
                        aria-description={item.description}
                        aria-selected={isSelected}
                        className={cn(
                            'relative flex cursor-pointer items-center justify-center border-0 bg-surface text-muted hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-foreground',
                            isSelected && 'active text-foreground',
                            tabClassName,
                        )}
                        data-value={item.value}
                        tabIndex={isSelected ? 0 : -1}
                        onClick={() => onValueChange(item.value)}
                        onKeyDown={(event) => activateFromKeyboard(event, index)}
                    >
                        <span
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
                className="pointer-events-none absolute bottom-0 left-0 z-1 h-0.5 rounded-full bg-indicator transition-[transform,width]"
                data-slot="chrome-tab-indicator"
                style={{
                    opacity: geometry ? 1 : 0,
                    transform: `translate3d(${geometry?.left ?? 0}px, 0, 0)`,
                    transitionDuration:
                        motionReady && !isReducedMotion ? 'var(--motion-chrome-switch)' : '0ms',
                    transitionTimingFunction: 'var(--motion-ease-emphasized)',
                    width: geometry?.width ?? 0,
                }}
            />
        </div>
    );
}

interface ChromeTabPanelProperties<Value extends string> extends HTMLAttributes<HTMLDivElement> {
    active: boolean;
    idPrefix: string;
    value: Value;
}

/**
 * Mounted panel counterpart that keeps every tab's `aria-controls` target resolvable.
 */
export function ChromeTabPanel<Value extends string>({
    active,
    className,
    idPrefix,
    value,
    ...properties
}: ChromeTabPanelProperties<Value>) {
    return (
        <div
            {...properties}
            id={`${idPrefix}-panel-${value}`}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-${value}`}
            className={className}
            hidden={!active}
        />
    );
}
