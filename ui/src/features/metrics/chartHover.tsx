import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

/** The sample every chart of a panel marks, and the chart that shows its readout. */
export interface ChartHover {
  /** The hovered sample's time in unix seconds; null when none is. */
  t: number | null;
  /** The stem of the chart under the pointer or with focus: only it shows the readout. */
  owner: string | null;
  set(t: number | null, owner: string | null): void;
}

export const ChartHoverContext = createContext<ChartHover | null>(null);

/** The panel's shared hover; null outside a provider, as in a drawer. */
export function useChartHover(): ChartHover | null {
  return useContext(ChartHoverContext);
}

/**
 * Shares one hovered time among the charts below it (spec §3.6). A time, not an index, so
 * two answers whose windows differ by a step still mark the same moment.
 */
export function ChartHoverProvider(props: { children: ReactNode }) {
  const [state, setState] = useState<{
    t: number | null;
    owner: string | null;
  }>({ t: null, owner: null });
  const value = useMemo<ChartHover>(
    () => ({
      ...state,
      set: (t, owner) =>
        setState((s) => (s.t === t && s.owner === owner ? s : { t, owner })),
    }),
    [state],
  );
  return (
    <ChartHoverContext.Provider value={value}>
      {props.children}
    </ChartHoverContext.Provider>
  );
}
