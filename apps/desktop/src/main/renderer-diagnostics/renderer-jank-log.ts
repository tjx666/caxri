import type { RendererJankDiagnostic } from '@caxri/protocol';

type LogFields = Record<string, boolean | number | string | null>;

/**
 * A batch whose slowest sample reaches this is a stall the user noticed, not a hitch, and is logged at `warn`.
 */
const WARN_AT_MS = 1_000;

export function rendererJankLogLevel(diagnostic: RendererJankDiagnostic): 'info' | 'warn' {
    const slowest = Math.max(
        0,
        ...diagnostic.switches.map((sample) => sample.totalMs),
        ...diagnostic.frames.map((frame) => frame.durationMs),
    );
    return slowest >= WARN_AT_MS ? 'warn' : 'info';
}

/**
 * Flattens a Renderer jank batch into scalar fields that `caxri logs query` can match. Each sample is one
 * `key=value,...;` segment so a single field still reads in order, slowest first, without nested JSON. Every value is a
 * number, a boolean, an invoker name, or a Caxri bundle identifier already validated by the protocol schema.
 */
export function rendererJankLogFields(diagnostic: RendererJankDiagnostic): LogFields {
    const switches = diagnostic.switches
        .toSorted((left, right) => right.totalMs - left.totalMs)
        .map(
            (sample) =>
                `total=${sample.totalMs},request=${sample.requestMs},converge=${sample.convergeMs},paint=${sample.paintMs},endedAgo=${sample.endedAgoMs}`,
        );
    const frames = diagnostic.frames
        .toSorted((left, right) => right.durationMs - left.durationMs)
        .map((frame) => {
            const script = frame.topScript;
            const top = script
                ? `,topInvoker=${script.invokerType},topMs=${script.durationMs},topForcedLayoutMs=${script.forcedStyleLayoutMs},topFile=${script.file ?? '-'},topFunction=${script.functionName ?? '-'}`
                : '';
            return `duration=${frame.durationMs},blocking=${frame.blockingMs},styleLayout=${frame.styleLayoutMs},scripts=${frame.scriptCount},duringSwitch=${frame.isDuringSessionSwitch},endedAgo=${frame.endedAgoMs}${top}`;
        });
    return {
        code: 'RENDERER_JANK',
        diagnosticId: diagnostic.diagnosticId,
        documentVisible: diagnostic.documentVisible,
        switchCount: diagnostic.switches.length,
        omittedSwitchCount: diagnostic.omittedSwitchCount,
        frameCount: diagnostic.frames.length,
        omittedFrameCount: diagnostic.omittedFrameCount,
        ...(switches.length > 0 && { switches: switches.join(';') }),
        ...(frames.length > 0 && { frames: frames.join(';') }),
    };
}
