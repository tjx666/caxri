import type { HTMLAttributes, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useShouldReduceMotion } from '../lib/motion';
import { cn } from '../lib/utilities';

interface ChromeTabItem<Value extends string> {
    content: ReactNode;
    label: string;
    value: Value;
}

interface ChromeTabsProperties<Value extends string> {
    ariaLabel: string;
    className?: string;
    idPrefix: string;
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
Shared top-level chrome tabs with automatic activation and one measured moving indicator.
 */
export function ChromeTabs<Value extends string>({
    ariaLabel,
    className,
    idPrefix,
    items,
    onValueChange,
    renderTab,
    tabClassName,
    value,
}: ChromeTabsProperties<Value>) {
    const isReducedMotion = useShouldReduceMotion();
    const listReference = useRef<HTMLDivElement>(null);
    const tabReferences = useRef(new Map<Value, HTMLButtonElement>());
    const contentReferences = useRef(new Map<Value, HTMLSpanElement>());
    const [geometry, setGeometry] = useState<IndicatorGeometry>();
    const [motionReady, setMotionReady] = useState(false);

    const measureIndicator = useCallback((): void => {
        const list = listReference.current;
        const content = contentReferences.current.get(value);
        if (!list || !content) return;
        const listBox = list.getBoundingClientRect();
        const contentBox = content.getBoundingClientRect();
        /**
        Dialog enter motion scales client rects; normalize them back into this list's CSS pixels.
         */
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
        if (listReference.current) observer.observe(listReference.current);
        for (const content of contentReferences.current.values()) observer.observe(content);
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
                        aria-selected={isSelected}
                        className={cn(
                            'relative flex items-center justify-center border-0 bg-surface text-muted cursor-pointer hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-foreground',
                            isSelected && 'active text-foreground',
                            tabClassName,
                        )}
                        data-value={item.value}
                        tabIndex={isSelected ? 0 : -1}
                        onClick={() => onValueChange(item.value)}
                        onKeyDown={(event) => activateFromKeyboard(event, index)}
                    >
                        <span
                            ref={(element) => {
                                if (element) contentReferences.current.set(item.value, element);
                                else contentReferences.current.delete(item.value);
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
Mounted panel counterpart that keeps every tab's `aria-controls` target resolvable.
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
