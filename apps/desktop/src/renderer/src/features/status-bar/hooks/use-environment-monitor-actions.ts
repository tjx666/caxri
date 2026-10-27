import { useState } from 'react';

import {
    acceptEnvironmentMonitorBaseline,
    refreshEnvironmentMonitor,
} from '../environment-monitor-commands';

export function useEnvironmentMonitorActions() {
    const [isRefreshing, setRefreshing] = useState(false);
    return {
        acceptBaseline: acceptEnvironmentMonitorBaseline,
        isRefreshing,
        refresh: async () => {
            if (isRefreshing) return;
            setRefreshing(true);
            try {
                await refreshEnvironmentMonitor();
            } catch (error) {
                setRefreshing(false);
                throw error;
            }
            setRefreshing(false);
        },
    };
}
