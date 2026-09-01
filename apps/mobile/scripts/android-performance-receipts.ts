export interface AndroidActivityStartReceipt {
    launchState: string;
    totalTimeMs?: number;
    waitTimeMs: number;
}

export interface AndroidFrameReceipt {
    droppedFrameRatio: number;
    jankyFrames: number;
    percentile50Ms: number;
    percentile90Ms: number;
    percentile95Ms: number;
    percentile99Ms: number;
    totalFrames: number;
}

const requiredInteger = (source: string, pattern: RegExp, field: string): number => {
    const value = pattern.exec(source)?.[1];
    if (!value) throw new Error(`Android performance output is missing ${field}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new Error(`Android performance output has invalid ${field}`);
    return parsed;
};

export const parseAndroidActivityStart = (source: string): AndroidActivityStartReceipt => {
    if (!/^Status:[ \t]*ok\r?$/mu.test(source))
        throw new Error('Android Activity launch did not report success');
    const launchState = /^LaunchState:[ \t]*([A-Z]+)(?:[ \t]+\(\d+\))?\r?$/mu.exec(source)?.[1];
    if (!launchState) throw new Error('Android performance output is missing launchState');
    const totalTime = /^TotalTime:[ \t]*(\d+)\r?$/mu.exec(source)?.[1];
    return {
        launchState,
        ...(totalTime && { totalTimeMs: Number(totalTime) }),
        waitTimeMs: requiredInteger(source, /^WaitTime:[ \t]*(\d+)\r?$/mu, 'waitTimeMs'),
    };
};

export const parseAndroidFrameStats = (source: string): AndroidFrameReceipt => {
    const totalFrames = requiredInteger(
        source,
        /^Total frames rendered:[ \t]*(\d+)\r?$/mu,
        'totalFrames',
    );
    const jankyFrames = requiredInteger(
        source,
        /^Janky frames:[ \t]*(\d+)[ \t]*\(/mu,
        'jankyFrames',
    );
    return {
        droppedFrameRatio:
            totalFrames === 0 ? 0 : Math.round((jankyFrames / totalFrames) * 10_000) / 10_000,
        jankyFrames,
        percentile50Ms: requiredInteger(source, /^50th percentile:[ \t]*(\d+)ms\r?$/mu, 'p50'),
        percentile90Ms: requiredInteger(source, /^90th percentile:[ \t]*(\d+)ms\r?$/mu, 'p90'),
        percentile95Ms: requiredInteger(source, /^95th percentile:[ \t]*(\d+)ms\r?$/mu, 'p95'),
        percentile99Ms: requiredInteger(source, /^99th percentile:[ \t]*(\d+)ms\r?$/mu, 'p99'),
        totalFrames,
    };
};
