import type { SVGProps } from 'react';
import { useId } from 'react';

export type LinearStatusKind =
    'backlog' | 'canceled' | 'completed' | 'duplicate' | 'started' | 'triage' | 'unstarted';

type LinearStatusIconProperties = SVGProps<SVGSVGElement> & {
    size?: number;
};

/**
 * Caxri-owned workflow glyphs for Linear states.
 */
export function LinearStatusIcon({
    kind,
    size = 16,
    ...properties
}: LinearStatusIconProperties & { kind: LinearStatusKind }) {
    const maskId = `linear-${kind}-${useId()}-cutout`;
    const cutout =
        kind === 'triage' ? (
            <path d="M6.15 6.4C6.35 5.35 7.05 4.8 8.1 4.8c1.2 0 2 .65 2 1.65 0 .9-.55 1.35-1.2 1.75-.65.4-.9.75-.9 1.45M8 11.35h.01" />
        ) : kind === 'completed' ? (
            <path d="m4.75 8.15 2.25 2.1 4.4-4.55" />
        ) : kind === 'canceled' ? (
            <path d="m5.1 5.1 5.8 5.8M10.9 5.1l-5.8 5.8" />
        ) : kind === 'duplicate' ? (
            <path d="M6.25 5.25h4.5v4.5h-4.5zM5.25 6.25v4.5h4.5" />
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
                <>
                    <rect
                        x="2"
                        y="2"
                        width="12"
                        height="12"
                        rx="3.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    />
                    <path
                        d="M5 5.5h6M5 8h6M5 10.5h4"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinecap="round"
                    />
                </>
            )}
            {kind === 'unstarted' && (
                <rect
                    x="2"
                    y="2"
                    width="12"
                    height="12"
                    rx="3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                />
            )}
            {kind === 'started' && (
                <>
                    <rect
                        x="2"
                        y="2"
                        width="12"
                        height="12"
                        rx="3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    />
                    <path
                        d="M5 8h6M9 5.75 11.25 8 9 10.25"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
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
                    <rect
                        x="2"
                        y="2"
                        width="12"
                        height="12"
                        rx="3.5"
                        fill="currentColor"
                        mask={`url(#${maskId})`}
                    />
                </>
            )}
        </svg>
    );
}
