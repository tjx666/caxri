export interface MobilePerformanceReceipt {
    coldStartMs: number;
    droppedFrameRatio: number;
    firstInteractiveMs: number;
    hotStartMs: number;
}

const MOBILE_PERFORMANCE_BUDGET = {
    coldStartMs: 2_500,
    droppedFrameRatio: 0.03,
    firstInteractiveMs: 1_500,
    hotStartMs: 900,
} as const;

export const performanceBudgetFailures = (receipt: MobilePerformanceReceipt): string[] => {
    const failures: string[] = [];
    for (const metric of Object.keys(MOBILE_PERFORMANCE_BUDGET) as Array<
        keyof MobilePerformanceReceipt
    >)
        if (receipt[metric] > MOBILE_PERFORMANCE_BUDGET[metric]) failures.push(metric);
    return failures;
};
