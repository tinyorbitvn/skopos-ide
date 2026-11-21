import type { IconComponent } from "../../design/icons";
import { StatTile, TileRow, type TileTone } from "../overview";
import type { ListView } from "../workloads/counts";

const DASH = "—";

/** A tile of a section page, as its model builds it: the props of a `StatTile`. */
export interface SectionTile {
  /** The test id's stem: `overview-tile-<id>`. */
  id: string;
  icon: IconComponent;
  number: string;
  label: string;
  sub: string;
  tone: TileTone;
  /** The list it opens; null draws a disabled tile. */
  to: string | null;
}

/**
 * The tile of a list that is not ready (spec §3.1): `—` in the neutral tone, its sub-line
 * from the cause (R1), never from the reason's text. A list the account may not list, or
 * that the cluster does not serve, gives a disabled tile; a list that loads or failed still
 * opens. `plural` names the kind as its list does: "PersistentVolumes".
 */
export function waitingTile(
  view: Exclude<ListView, { state: "ready" }>,
  base: {
    id: string;
    icon: IconComponent;
    label: string;
    plural: string;
    to: string;
  },
): SectionTile {
  const tile = {
    id: base.id,
    icon: base.icon,
    label: base.label,
    number: DASH,
    tone: "neutral" as const,
  };
  if (view.state === "loading") return { ...tile, sub: "Loading", to: base.to };
  if (view.cause === "forbidden") {
    return { ...tile, sub: `You may not list ${base.plural}`, to: null };
  }
  if (view.cause === "notServed") {
    return {
      ...tile,
      sub: `This cluster does not serve ${base.plural}`,
      to: null,
    };
  }
  return { ...tile, sub: `Could not list ${base.plural}`, to: base.to };
}

/** A card's tiles in a `TileRow` (spec §3.1), each a `StatTile` that opens its list. */
export function TileGrid(props: { tiles: SectionTile[] }) {
  return (
    <TileRow>
      {props.tiles.map((tile) => (
        <StatTile key={tile.id} {...tile} />
      ))}
    </TileRow>
  );
}
