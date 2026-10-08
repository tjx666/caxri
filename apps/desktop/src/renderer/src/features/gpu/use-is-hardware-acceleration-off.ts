import { useCaxriQuery } from '../../queries/client';

/**
 * Whether Caxri launched with hardware acceleration turned off in `argv.jsonc`.
 *
 * The Renderer cannot observe this from a WebGL probe (a failed `getContext('webgl2')` looks identical whether the GPU
 * is briefly unavailable or the app declined it at boot) and the difference decides whether a retry can ever succeed.
 * `argv.jsonc` is written only by Settings and the crash card, both of which restart Caxri, so one read per window is
 * enough and the value cannot go stale under a live window.
 */
export function useIsHardwareAccelerationOff(): boolean {
    const { data } = useCaxriQuery('argv.get', undefined, { staleTime: Infinity });
    return data?.value.hardwareAcceleration === false;
}
