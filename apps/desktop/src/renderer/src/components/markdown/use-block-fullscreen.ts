import { useState } from 'react';

/**
 * Open state for one block's full-screen view, so the block, its toolbar button, and the dialog share it.
 */
export function useBlockFullscreen() {
    const [isOpen, setOpen] = useState(false);
    return { isOpen, open: () => setOpen(true), setOpen };
}
