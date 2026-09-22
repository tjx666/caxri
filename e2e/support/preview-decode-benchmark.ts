import type { Page } from './fixtures.ts';

/**
 * Same-Renderer comparison at the asset byte ceiling; records only durations, counts, and byte integrity.
 */
export async function measurePreviewDecode(page: Page) {
    return page.evaluate(() => {
        const byteLength = 8 * 1024 * 1024;
        const source = btoa('a'.repeat(byteLength));
        const baselineMs: number[] = [];
        const nativeMs: number[] = [];
        let isValid = true;
        for (let sample = 0; sample < 3; sample += 1) {
            const baselineStart = performance.now();
            const binary = atob(source);
            const baseline = new Uint8Array(new ArrayBuffer(binary.length));
            for (let index = 0; index < binary.length; index += 1)
                baseline[index] = binary.codePointAt(index) ?? 0;
            baselineMs.push(performance.now() - baselineStart);
            const nativeStart = performance.now();
            const native = Uint8Array.fromBase64(source);
            nativeMs.push(performance.now() - nativeStart);
            isValid &&=
                native.byteLength === byteLength &&
                native[0] === baseline[0] &&
                native.at(-1) === baseline.at(-1);
        }
        return { byteLength, baselineMs, nativeMs, valid: isValid };
    });
}
