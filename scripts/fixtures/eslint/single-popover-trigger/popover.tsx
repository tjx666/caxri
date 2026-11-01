/** Stand-in for the Renderer popover module so the fixture stays out of the Renderer project. */
import type { ReactNode } from 'react';

export function Popover({ children }: { children?: ReactNode }) {
    return <div>{children}</div>;
}

export function PopoverTrigger({ children }: { children?: ReactNode }) {
    return <button type="button">{children}</button>;
}

export function PopoverContent({ children }: { children?: ReactNode }) {
    return <div>{children}</div>;
}
