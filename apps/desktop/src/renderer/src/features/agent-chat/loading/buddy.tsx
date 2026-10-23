import './loading.css';

import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utilities';

import { GLYPH_CUTOUT, staggerIndex } from './glyph-geometry';
import type { BuddyMood } from './presentation';

const SWEAT_DROP = 'M19.6 5.2c.9 1.2 1.3 2 1.3 2.6a1.3 1.3 0 0 1-2.6 0c0-.6.4-1.4 1.3-2.6z';

interface EyeShape {
    cy: number;
    rx: number;
    ry: number;
}

/**
 * Eye shapes for the moods that look around: reading squints, searching widens the eye behind the lens.
 */
const LOOKING_EYES: Record<
    Exclude<BuddyMood, 'compact' | 'wait' | 'tired' | 'run'>,
    [EyeShape, EyeShape]
> = {
    think: [
        { cy: 12.6, rx: 1.6, ry: 2.2 },
        { cy: 12.6, rx: 1.6, ry: 2.2 },
    ],
    read: [
        { cy: 13, rx: 1.7, ry: 1.25 },
        { cy: 13, rx: 1.7, ry: 1.25 },
    ],
    search: [
        { cy: 12.6, rx: 1.6, ry: 2.2 },
        { cy: 12.6, rx: 2, ry: 2.6 },
    ],
};

/**
 * One drawing in Buddy's 24-unit view box. Every part shares that box, so the parts stack into the same picture the
 * single SVG used to draw.
 */
function Art({ children }: { children: ReactNode }) {
    return (
        <svg className="buddy-art" height="24" viewBox="0 0 24 24" width="24">
            {children}
        </svg>
    );
}

/**
 * A part that moves. Each one is an HTML box over the whole view box rather than an SVG group: a transform on an SVG
 * child restyles and re-layerizes on the main thread every frame, while one on an HTML box runs on the compositor.
 * `transformOrigin` is in view-box units, since the box is the view box.
 */
function Layer({
    children,
    className,
    style,
}: {
    children: ReactNode;
    className: string;
    style?: CSSProperties;
}) {
    return (
        <span className={cn('buddy-layer', className)} style={style}>
            {children}
        </span>
    );
}

/**
 * Buddy's eyes and mouth for a mood. Moods that look around (`think`, `read`, `search`) move their eyes as one group.
 */
function BuddyFace({ mood }: { mood: BuddyMood }) {
    switch (mood) {
        case 'compact': {
            return (
                <Art>
                    <g
                        fill="none"
                        stroke={GLYPH_CUTOUT}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                    >
                        <path d="m6.6 11.6 2 1.4-2 1.4" />
                        <path d="m15.4 11.6-2 1.4 2 1.4" />
                    </g>
                </Art>
            );
        }
        case 'wait': {
            return (
                <Art>
                    <g fill="none" stroke={GLYPH_CUTOUT} strokeLinecap="round" strokeWidth="1.5">
                        <path d="M6.6 13.2q1.4 1.2 2.8 0" />
                        <path d="M12.6 13.2q1.4 1.2 2.8 0" />
                    </g>
                </Art>
            );
        }
        case 'tired': {
            return (
                <>
                    <Art>
                        <g
                            fill="none"
                            stroke={GLYPH_CUTOUT}
                            strokeLinecap="round"
                            strokeWidth="1.5"
                        >
                            <path d="M6.6 12.4h2.8" />
                            <path d="M12.6 12.4h2.8" />
                        </g>
                    </Art>
                    <Layer className="buddy-yawn">
                        <Art>
                            <ellipse cx="11" cy="16" fill={GLYPH_CUTOUT} rx="1.4" ry="1.8" />
                        </Art>
                    </Layer>
                </>
            );
        }
        case 'run': {
            return (
                <Art>
                    <ellipse cx="8" cy="13" fill={GLYPH_CUTOUT} rx="1.6" ry="1.9" />
                    <ellipse cx="14" cy="13" fill={GLYPH_CUTOUT} rx="1.6" ry="1.9" />
                    <g fill="none" stroke={GLYPH_CUTOUT} strokeLinecap="round" strokeWidth="1.3">
                        <path d="M6.2 9.9 9.6 10.9" />
                        <path d="M15.8 9.9 12.4 10.9" />
                    </g>
                </Art>
            );
        }
        default: {
            const [left, right] = LOOKING_EYES[mood];
            return (
                <Layer className="buddy-look">
                    {/* Blinks around the eyes' vertical middle; the left eye spans both eyes' height in every mood. */}
                    <Layer className="buddy-blink" style={{ transformOrigin: `11px ${left.cy}px` }}>
                        <Art>
                            <ellipse cx="8" fill={GLYPH_CUTOUT} {...left} />
                            <ellipse cx="14" fill={GLYPH_CUTOUT} {...right} />
                        </Art>
                    </Layer>
                    {mood === 'search' && (
                        <Art>
                            <g
                                fill="none"
                                stroke="var(--merged)"
                                strokeLinecap="round"
                                strokeWidth="1.3"
                            >
                                <circle cx="14" cy="12.6" r="3.6" />
                                <path d="m16.6 15.2 2.4 2.4" />
                            </g>
                        </Art>
                    )}
                </Layer>
            );
        }
    }
}

/**
 * The rare party hat (`isBuddyPartyTurn`), drawn above the head past the view box.
 */
function PartyHat() {
    return (
        <Layer className="buddy-hat">
            <Art>
                <path d="M6.4 6.6 11.4-3.4 15.8 6.6Z" fill="var(--merged)" />
                <path
                    d="M8.2 3.4 14.2 2.6M9.8.2l3.2-.5"
                    stroke="var(--accent)"
                    strokeLinecap="round"
                    strokeWidth="1.1"
                />
                <circle cx="11.4" cy="-3.6" fill="var(--warning)" r="1.5" />
            </Art>
        </Layer>
    );
}

const THOUGHT_BUBBLES = [
    { cx: 18.6, cy: 5.6, r: 1 },
    { cx: 21.2, cy: 2.6, r: 1.5 },
] as const;

/**
 * Buddy: a small round character that acts out what the Agent is doing (see `BuddyMood`). Pointing at it boops it: it
 * squishes, its eyes turn into happy arcs, and a heart floats up. It is decoration, so assistive technology never sees
 * it; the status line names the activity.
 *
 * The parts are drawn at the 24-unit view box and the stage scales them to `size`, so the keyframes in `loading.css`
 * move them in view-box units at every size.
 */
export function Buddy({
    isParty = false,
    mood,
    size = 20,
}: {
    isParty?: boolean;
    mood: BuddyMood;
    size?: number;
}) {
    return (
        <span
            aria-hidden="true"
            className="agent-chat-buddy relative inline-flex shrink-0"
            data-mood={mood}
            style={{ 'width': size, 'height': size, '--buddy-scale': size / 24 } as CSSProperties}
        >
            {/* Keyed so a new mood or hat restarts every loop together, keeping them on the shared tick. */}
            <span className="buddy-stage" key={`${mood}-${isParty}`}>
                <span className="buddy-idle buddy-layer">
                    <Layer className="buddy-body">
                        <Art>
                            <circle cx="11" cy="13" fill="var(--foreground)" r="8" />
                        </Art>
                        <BuddyFace mood={mood} />
                    </Layer>
                    {mood === 'think' &&
                        THOUGHT_BUBBLES.map(({ cx, cy, r }, index) => (
                            <Layer
                                className="buddy-bubble"
                                key={cx}
                                style={{
                                    ...staggerIndex(index),
                                    transformOrigin: `${cx}px ${cy}px`,
                                }}
                            >
                                <Art>
                                    <circle cx={cx} cy={cy} fill="var(--foreground)" r={r} />
                                </Art>
                            </Layer>
                        ))}
                    {(mood === 'run' || mood === 'tired') && (
                        <Layer className="buddy-sweat">
                            <Art>
                                <path d={SWEAT_DROP} fill="var(--git-modified)" />
                            </Art>
                        </Layer>
                    )}
                    {mood === 'wait' &&
                        [0, 1].map((index) => (
                            <Layer className="buddy-z" key={index} style={staggerIndex(index)}>
                                <Art>
                                    <path
                                        d="M18 4h2.6L18 7h2.6"
                                        fill="none"
                                        stroke="var(--muted)"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="1.1"
                                    />
                                </Art>
                            </Layer>
                        ))}
                    {isParty && <PartyHat />}
                </span>
                <span className="buddy-booped buddy-layer">
                    <Layer className="buddy-squish">
                        <Art>
                            <circle cx="11" cy="13" fill="var(--foreground)" r="8" />
                            <g
                                fill="none"
                                stroke={GLYPH_CUTOUT}
                                strokeLinecap="round"
                                strokeWidth="1.5"
                            >
                                <path d="M6.6 13q1.4-1.6 2.8 0" />
                                <path d="M12.6 13q1.4-1.6 2.8 0" />
                            </g>
                            <circle cx="6" cy="15.6" fill="var(--accent)" opacity=".6" r="1.3" />
                            <circle cx="16" cy="15.6" fill="var(--accent)" opacity=".6" r="1.3" />
                        </Art>
                    </Layer>
                    <Layer className="buddy-heart">
                        <Art>
                            <path
                                d="M20 6.2c-1-.9-2.2-1.4-2.2-2.5a1.1 1.1 0 0 1 2.2-.2 1.1 1.1 0 0 1 2.2.2c0 1.1-1.2 1.6-2.2 2.5z"
                                fill="var(--accent)"
                            />
                        </Art>
                    </Layer>
                    {isParty && <PartyHat />}
                </span>
            </span>
        </span>
    );
}
