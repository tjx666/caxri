import type { SVGProps } from 'react';
import { useId } from 'react';

export type LinearStatusKind =
    'backlog' | 'canceled' | 'completed' | 'duplicate' | 'started' | 'triage' | 'unstarted';

type LinearStatusIconProperties = SVGProps<SVGSVGElement> & {
    size?: number;
};

/**
 * Static Linear workflow glyphs adapted from the MIT-licensed vscode-fe-helper sidebar reference.
 *
 * Source: https://github.com/tjx666/vscode-fe-helper/blob/main/src/sidebar/linearStatusIcon.ts
 */
export function LinearStatusIcon({
    kind,
    size = 16,
    ...properties
}: LinearStatusIconProperties & { kind: LinearStatusKind }) {
    const maskId = `linear-${kind}-${useId()}-cutout`;
    const cutout =
        kind === 'triage' ? (
            <path d="M4.5 8h2.75M4.5 8l1.25-1.25M4.5 8l1.25 1.25M11.5 8H8.75M11.5 8l-1.25-1.25M11.5 8l-1.25 1.25" />
        ) : kind === 'completed' ? (
            <path d="m4.75 8 2.1 2.1 4.4-4.7" />
        ) : kind === 'canceled' ? (
            <path d="m5 5 6 6M11 5l-6 6" />
        ) : kind === 'duplicate' ? (
            // Linear separates Duplicate from Canceled by a single slash rather than a cross; mapping both onto the
            // cross made an issue closed as a duplicate look like one the team decided against.
            <path d="m5 11 6-6" />
        ) : undefined;

    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            {...properties}
        >
            {kind === 'backlog' && (
                <circle
                    cx="8"
                    cy="8"
                    r="6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="1.4 1.742"
                    strokeDashoffset="0.7"
                />
            )}
            {kind === 'unstarted' && (
                <circle
                    cx="8"
                    cy="8"
                    r="5.75"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                />
            )}
            {kind === 'started' && (
                <>
                    <path d="M8 8V4A4 4 0 0 1 8 12Z" fill="currentColor" />
                    <circle
                        cx="8"
                        cy="8"
                        r="5.75"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    />
                </>
            )}
            {cutout && (
                <>
                    <defs>
                        <mask
                            id={maskId}
                            maskUnits="userSpaceOnUse"
                            x="0"
                            y="0"
                            width="16"
                            height="16"
                        >
                            <rect width="16" height="16" fill="white" />
                            <g
                                fill="none"
                                stroke="black"
                                strokeWidth="1.65"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                {cutout}
                            </g>
                        </mask>
                    </defs>
                    <circle cx="8" cy="8" r="6" fill="currentColor" mask={`url(#${maskId})`} />
                </>
            )}
        </svg>
    );
}
