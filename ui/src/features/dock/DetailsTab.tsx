import { ChevronLeft, PanelRightOpen } from "lucide-react";
import type { ReactElement } from "react";
import { Button, IconButton } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { DetailsDockTab } from "../../stores/dock";
import { findResource } from "../../stores/resources";
import { DetailsContent, useDetailsEntry } from "../details/DetailsContent";
import { DrawerObjectActions } from "../resources/DrawerObjectActions";
import styles from "./DetailsTab.module.css";
import { useOpenAsDrawer } from "./openAsDrawer";
import { useDetailsHistory } from "./useDetailsHistory";

/**
 * A details tab's panel (spec K8–K11): a one-row header over the drawer's tab row and
 * tab bodies, read live as the drawer reads them. Links step within the tab, and Open
 * as drawer puts the shown entry back over its own list.
 */
export function DetailsTab(props: {
  tab: DetailsDockTab;
  resources: ApiResourceInfo[];
}): ReactElement | null {
  const { tab, resources } = props;
  const history = useDetailsHistory(tab);
  const entry = useDetailsEntry({
    clusterId: tab.clusterId,
    history,
    resources,
    known: tab.resource,
  });
  const openAsDrawer = useOpenAsDrawer();
  const shown = history.shown;
  if (entry === null || shown === null) return null;

  const { target, read, kind, name } = entry;
  const object = read.object;
  // The actions need the served resource's verbs, which the root's fallback lacks.
  const served = findResource(resources, target.group, target.plural);
  const live = read.status === "live" || read.status === "fetched";
  const fullName = target.namespace ? `${target.namespace}/${name}` : name;

  return (
    <div className={styles.root}>
      <header className={styles.band}>
        {history.previous ? (
          <IconButton
            className={styles.back}
            label={`Back to ${history.previous.target.name}`}
            icon={<ChevronLeft size={16} aria-hidden="true" />}
            onClick={history.back}
            data-testid="dock-details-back"
          />
        ) : null}
        <h3
          className={styles.title}
          title={fullName}
          data-testid="dock-details-title"
        >
          {name}
        </h3>
        <span className={styles.kind} data-testid="dock-details-kind">
          {kind}
        </span>
        <div className={styles.grow} />
        {live && object && served ? (
          <DrawerObjectActions
            clusterId={tab.clusterId}
            info={served}
            object={object}
          />
        ) : null}
        <span className={styles.divider} aria-hidden="true" />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => openAsDrawer(tab, shown)}
          data-testid="dock-details-pop"
        >
          <PanelRightOpen size={14} aria-hidden="true" />
          Open as drawer
        </Button>
      </header>
      <DetailsContent
        clusterId={tab.clusterId}
        entry={entry}
        resources={resources}
        onOpen={history.open}
        onTabChange={history.setTab}
        wide
      />
    </div>
  );
}
