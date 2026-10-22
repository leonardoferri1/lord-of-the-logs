import { create } from 'zustand';
import type { BuildingKind, Point, Snapshot } from '@logs/shared';
type UiState = {
  snapshot: Snapshot | null;
  connected: boolean;
  entered: boolean;
  selected: string | null;
  buildKind: BuildingKind | null;
  menu: boolean;
  help: boolean;
  notices: { id: number; text: string; error: boolean }[];
  hover: Point | null;
  focus: number;
  set: (patch: Partial<UiState>) => void;
  notify: (text: string, error?: boolean) => void;
};
let sequence = 0;
export const useWorld = create<UiState>((set) => ({
  snapshot: null,
  connected: false,
  entered: false,
  selected: null,
  buildKind: null,
  menu: false,
  help: false,
  notices: [],
  hover: null,
  focus: 0,
  set: (patch) => set(patch),
  notify: (text, error = false) => {
    const id = ++sequence;
    set((state) => ({
      notices: [...state.notices.filter((n) => n.text !== text).slice(-3), { id, text, error }],
    }));
    setTimeout(() => set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })), 9000);
  },
}));
