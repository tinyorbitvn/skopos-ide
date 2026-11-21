import { Spinner } from "../../design";
import { CapacityRow, OverviewCard } from "../overview";
import styles from "./OverviewCards.module.css";
import type { Capacity } from "./overviewModel";

/** The Capacity card (spec §3.2): three donuts and the caption that names their source. */
export function CapacityCard(props: { capacity: Capacity | null }) {
  const { capacity } = props;
  return (
    <OverviewCard title="Capacity" testId="overview-capacity">
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
