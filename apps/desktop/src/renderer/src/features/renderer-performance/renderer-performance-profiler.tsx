import type { ReactNode } from 'react';
import { Profiler } from 'react';

import type { RendererPerformanceSurface } from './aggregation';
import { recordReactProfile } from './controller';

interface RendererPerformanceProfilerProperties {
    children: ReactNode;
    surface: RendererPerformanceSurface;
}

export function RendererPerformanceProfiler({
    children,
    surface,
}: RendererPerformanceProfilerProperties) {
    return (
        <Profiler
            id={surface}
            onRender={(_id, phase, actualDuration, baseDuration, _startTime, commitTime) =>
                recordReactProfile(surface, phase, actualDuration, baseDuration, commitTime)
            }
        >
            {children}
        </Profiler>
    );
}
