import { useEffect, useRef } from 'react';

import { PERFORMANCE_MONITOR_FRAME_CAPACITY } from '@desktop-shared/performance-monitor';

import { frameTone } from './format';

/**
 * Frame time that fills the graph's full height: four 60 Hz frames. Longer frames are clipped, which still reads as the
 * worst color; the exact number is in the readout above.
 */
const GRAPH_CEILING_MS = 66.7;
const TARGET_FRAME_MS = 16.7;

const TONE_VARIABLE = {
    bad: '--danger',
    good: '--success',
    idle: '--muted',
    warn: '--warning',
} as const;

function cssColor(style: CSSStyleDeclaration, name: string): string {
    return style.getPropertyValue(name).trim() || 'currentColor';
}

/**
 * One bar per recent frame, newest at the right, colored by how long the frame took, with a hairline at the 60 Hz
 * budget. Drawn on a canvas straight from the snapshot so a 240-bar graph is one paint, not 240 elements.
 */
export function FrameGraph({ frameMs, label }: { frameMs: readonly number[]; label: string }) {
    const canvasReference = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const canvas = canvasReference.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;
        const ratio = globalThis.devicePixelRatio || 1;
        const width = Math.round(canvas.clientWidth * ratio);
        const height = Math.round(canvas.clientHeight * ratio);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        context.clearRect(0, 0, width, height);
        const style = getComputedStyle(canvas);
        const barWidth = width / PERFORMANCE_MONITOR_FRAME_CAPACITY;
        const offset = width - frameMs.length * barWidth;
        for (const [index, ms] of frameMs.entries()) {
            const barHeight = Math.max(1, Math.min(1, ms / GRAPH_CEILING_MS) * height);
            context.fillStyle = cssColor(style, TONE_VARIABLE[frameTone(ms)]);
            context.fillRect(
                offset + index * barWidth,
                height - barHeight,
                Math.max(1, barWidth - ratio * 0.5),
                barHeight,
            );
        }
        context.fillStyle = cssColor(style, '--border');
        context.fillRect(0, height - (TARGET_FRAME_MS / GRAPH_CEILING_MS) * height, width, ratio);
    }, [frameMs]);
    return (
        <canvas
            ref={canvasReference}
            aria-label={label}
            className="block h-10 w-full rounded bg-background"
            data-frame-count={frameMs.length}
            role="img"
        />
    );
}
