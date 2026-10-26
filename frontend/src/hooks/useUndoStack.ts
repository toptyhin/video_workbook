import { useAnnotationsStore } from '../state/annotationsStore';

/** Доступ к undo/redo-стеку меток для кнопок панели/тулбара. */
export interface UndoStackApi {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export function useUndoStack(): UndoStackApi {
  const canUndo = useAnnotationsStore((state) => state.undoCount > 0);
  const canRedo = useAnnotationsStore((state) => state.redoCount > 0);
  const undo = useAnnotationsStore((state) => state.undo);
  const redo = useAnnotationsStore((state) => state.redo);
  return { canUndo, canRedo, undo, redo };
}
