import { usePreviousExitReport } from './use-previous-exit-report';

/**
 * Renders nothing; mounted once under `MobileClientProvider` so the report waits for the first connection.
 */
export const PreviousExitReporter = () => {
    usePreviousExitReport();
    return null;
};
