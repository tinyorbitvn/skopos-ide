import { Spinner } from "../../design";
import { CapacityRow, OverviewCard } from "../overview";
import styles from "./OverviewCards.module.css";
import type { Capacity } from "./overviewModel";

/**
 * The Capacity card (spec §3.2): three donuts and the caption that names their source. The
 * cluster Overview keeps the `overview-capacity` test id; the Nodes overview passes its own.
 */
export function CapacityCard(props: {
  capacity: Capacity | null;
  testId?: string;
}) {
  const { capacity } = props;
  return (
    <OverviewCard title="Capacity" testId={props.testId ?? "overview-capacity"}>
      {capacity === null ? (
        <Spinner label="Loading capacity" />
      ) : (
        <>
          <CapacityRow items={capacity.items} />
          <p className={styles.caption} data-testid="overview-capacity-caption">
            {capacity.caption}
          </p>
        </>
      )}
    </OverviewCard>
  );
}
