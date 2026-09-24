import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

import type { MobileClientContextValue } from './use-mobile-client-controller';
import { useMobileClientController } from './use-mobile-client-controller';

const MobileClientContext = createContext<MobileClientContextValue | null>(null);

export const MobileClientProvider = ({ children }: { children: ReactNode }) => {
    const value = useMobileClientController();
    return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components -- The provider and its required context hook form one boundary.
export const useMobileClient = (): MobileClientContextValue => {
    const value = useContext(MobileClientContext);
    if (!value) throw new Error('MobileClientProvider is missing');
    return value;
};
