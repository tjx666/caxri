import { useId } from 'react';

import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT, svgId } from '../glyph-geometry';

/**
 * The plane's route: in from the left, a loop the loop, and out to the right.
 */
const ROUTE =
    'M-3 16C3 16 8 15.5 12 12.4 15 10 15 5.6 12.2 5.4 9.4 5.2 9 9 11.6 11.2 14.6 13.8 20 15 27 13.4';

/**
 * How far each contrail dot trails the plane, in seconds.
 */
const CONTRAIL_LAGS = [0.08, 0.16, 0.24, 0.32] as const;

/**
 * SMIL keeps the plane on the curve and nose first (`rotate="auto"`), which CSS motion paths cannot do for SVG
 * children. CSS media queries do not pause SMIL, so the glyph must never render under Reduce Motion
 * (`useLoadingStyle`).
 */
function FlightPath({ begin }: { begin: string }) {
    return (
        <animateMotion
            begin={begin}
            calcMode="spline"
            dur="2.6s"
            keyPoints="0;0.33;0.72;1"
            keySplines=".3 0 .6 1;.4 0 .6 1;.4 0 .7 1"
            keyTimes="0;0.3;0.78;1"
            path={ROUTE}
            repeatCount="indefinite"
            rotate="auto"
        />
    );
}

/**
 * Fetching from the web: a paper plane loops the loop through the frame with a dotted contrail chasing it.
 */
export function WebGlyph({ size }: GlyphProperties) {
    const id = svgId(useId());
    return (
        <GlyphFrame size={size}>
            <defs>
                <clipPath id={id}>
                    <rect height="24" width="24" />
                </clipPath>
            </defs>
            <g clipPath={`url(#${id})`}>
                {CONTRAIL_LAGS.map((lag, index) => (
                    <circle key={lag} opacity={0.55 - index * 0.12} r={0.85 - index * 0.12}>
                        <FlightPath begin={`${-0.9 + lag}s`} />
                    </circle>
                ))}
                <g>
                    <FlightPath begin="-0.9s" />
                    <path d="M-4.6 -3.8 5.4 0-4.6 3.8-2.6 0Z" />
                    <path d="M-2.6 0H5.4" stroke={GLYPH_CUTOUT} strokeWidth=".8" />
                </g>
            </g>
        </GlyphFrame>
    );
}
