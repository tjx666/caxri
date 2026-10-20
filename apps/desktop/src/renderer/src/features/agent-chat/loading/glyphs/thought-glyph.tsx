import type { CSSProperties } from 'react';

import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame, GooGroup } from '../glyph-frame';
import { pivotAt, staggerIndex } from '../glyph-geometry';

/**
 * Satellites at their own speeds and directions, each dipping in to merge with the core now and then.
 */
const SATELLITES = [
    { radius: 1.9, distance: 7, orbit: '1.8s', pull: '3.6px', pullPeriod: '2.6s', reverse: false },
    { radius: 1.3, distance: 8, orbit: '2.6s', pull: '4.6px', pullPeriod: '2.1s', reverse: true },
    {
        radius: 1.15,
        distance: 6.2,
        orbit: '1.3s',
        pull: '2.6px',
        pullPeriod: '3.1s',
        reverse: false,
    },
    { radius: 1.55, distance: 7.6, orbit: '3.4s', pull: '4px', pullPeriod: '1.7s', reverse: true },
] as const;

const SPECKS = [
    [3, 5],
    [21, 7],
    [19.5, 20],
] as const;

/**
 * Thinking: a spark cloud. Satellites orbit a breathing core and melt into it when they dip close, like ideas joining.
 */
export function ThoughtGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <GooGroup>
                <circle className="think-core" cx="12" cy="12" r="3.6" />
                {SATELLITES.map((satellite) => (
                    <g
                        className="think-orbit"
                        key={satellite.distance}
                        style={{
                            ...pivotAt(12, 12),
                            animationDuration: satellite.orbit,
                            animationDirection: satellite.reverse ? 'reverse' : 'normal',
                        }}
                    >
                        <g
                            className="think-pull"
                            style={
                                {
                                    'animationDuration': satellite.pullPeriod,
                                    '--pull': satellite.pull,
                                } as CSSProperties
                            }
                        >
                            <circle cx="12" cy={12 - satellite.distance} r={satellite.radius} />
                        </g>
                    </g>
                ))}
            </GooGroup>
            {SPECKS.map(([cx, cy], index) => (
                <circle
                    className="think-speck"
                    cx={cx}
                    cy={cy}
                    key={cx}
                    r=".7"
                    style={staggerIndex(index)}
                />
            ))}
        </GlyphFrame>
    );
}
