import { create } from 'zustand';

interface PendingFileOperation {
    id: string;
    label: string;
    projectId: string;
}

interface FileOperationState {
    operations: PendingFileOperation[];
    begin(operation: PendingFileOperation): boolean;
    finish(id: string): void;
    update(id: string, label: string): void;
    clear(): void;
}

/** Renderer lifecycle for long file mutations; Runtime remains the authority for every path. */
export const useFileOperationStore = create<FileOperationState>((set, get) => ({
    operations: [],
    begin(operation) {
        if (get().operations.some((current) => current.id === operation.id)) return false;
        set((state) => ({ operations: [...state.operations, operation] }));
        return true;
    },
    finish: (id) =>
        set((state) => ({
            operations: state.operations.filter((operation) => operation.id !== id),
        })),
    update: (id, label) =>
        set((state) => ({
            operations: state.operations.map((operation) =>
                operation.id === id ? { ...operation, label } : operation,
            ),
        })),
    clear: () => set({ operations: [] }),
}));
