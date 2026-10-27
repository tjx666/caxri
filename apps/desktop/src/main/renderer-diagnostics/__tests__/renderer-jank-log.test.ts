import type { RendererJankDiagnostic } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { rendererJankLogFields, rendererJankLogLevel } from '../renderer-jank-log';

const diagnostic: RendererJankDiagnostic = {
    kind: 'renderer-jank',
    diagnosticId: 'd66947a8-0da0-4a4b-8629-a7694116d8e5',
    documentVisible: true,
    omittedFrameCount: 1,
    omittedSwitchCount: 0,
    switches: [
        { totalMs: 150, requestMs: 100, convergeMs: 30, paintMs: 20, endedAgoMs: 50 },
        {
            totalMs: 400,
            requestMs: 300,
            convergeMs: 60,
            snapshotMs: 45,
            applyMs: 15,
            paintMs: 40,
            endedAgoMs: 900,
        },
    ],
    frames: [
        {
            durationMs: 180,
            endedAgoMs: 20,
            blockingMs: 130,
            styleLayoutMs: 40,
            isDuringSessionSwitch: true,
            scriptCount: 2,
            topScript: {
                invokerType: 'user-callback',
                durationMs: 95,
                forcedStyleLayoutMs: 30,
                file: 'index-ab12.js',
                functionName: null,
            },
        },
    ],
};

describe('Renderer jank log', () => {
    it('flattens samples slowest first into queryable scalar fields', () => {
        const fields = rendererJankLogFields(diagnostic);

        expect(fields).toMatchObject({
            code: 'RENDERER_JANK',
            switchCount: 2,
            frameCount: 1,
            omittedFrameCount: 1,
        });
        expect(String(fields.switches).split(';', 1)[0]).toBe(
            'total=400,request=300,converge=60,snapshot=45,apply=15,paint=40,endedAgo=900',
        );
        expect(String(fields.switches).split(';', 2)[1]).toBe(
            'total=150,request=100,converge=30,paint=20,endedAgo=50',
        );
        expect(fields.frames).toBe(
            'duration=180,blocking=130,styleLayout=40,scripts=2,duringSwitch=true,endedAgo=20,topInvoker=user-callback,topMs=95,topForcedLayoutMs=30,topFile=index-ab12.js,topFunction=-',
        );
    });

    it('escalates to warn only when a sample reached one second', () => {
        expect(rendererJankLogLevel(diagnostic)).toBe('info');
        expect(
            rendererJankLogLevel({
                ...diagnostic,
                switches: [{ ...diagnostic.switches[0], totalMs: 1_000 }],
            }),
        ).toBe('warn');
    });
});
