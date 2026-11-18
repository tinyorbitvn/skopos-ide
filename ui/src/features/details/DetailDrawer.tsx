import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { IconButton, type TableColumn } from "../../design";
import { ChevronLeft, Minimize2, X } from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../../kinds/objects";
import { detailsTab, useDock } from "../../stores/dock";
import { DRAWER_PANE, usePaneSize } from "../../stores/paneSize";
import { DrawerObjectActions } from "../resources/DrawerObjectActions";
import styles from "./DetailDrawer.module.css";
import { DetailsContent, useDetailsEntry } from "./DetailsContent";
import { DrawerResize } from "./DrawerResize";
import type { DrawerHistoryApi } from "./useDrawerHistory";

export interface DetailDrawerProps {
  clusterId: string;
  /** The screen's resource. */
  resource: ResourceRef;
  history: DrawerHistoryApi;
  onClose(): void;
  resources?: ApiResourceInfo[];
  /** The screen's columns, for the Summary of its own objects. */
  columns?: readonly TableColumn<KubeObject>[];
  /** The header's actions for an object of the screen's resource. */
  actions?(object: KubeObject): ReactNode;
  /** Where focus goes on close when the element that had it is gone (spec H20). */
  fallbackFocus?(): HTMLElement | null;
}

/**
 * True when an Escape that reached the screen root should close the drawer (spec H19):
 * from inside the drawer or the list's grid, not from a portal (a menu or tooltip, whose
 * keys React bubbles here although its nodes sit elsewhere) and not from a text box.
 */
export function isDrawerEscape(e: React.KeyboardEvent<HTMLElement>): boolean {
  if (e.key !== "Escape") return false;
  const target = e.target;
  if (!(target instanceof Element) || !e.currentTarget.contains(target))
    return false;
  if (target instanceof HTMLTextAreaElement) return false;
  return target.closest('[data-drawer], [role="grid"]') !== null;
}

/**
 * The drawer of the object the history shows: the row the URL names, or an object a link
 * in it opened (spec H42–H53). It renders nothing while nothing is open. Links push onto
 * the history and Back pops it; both move focus into the drawer. The screen root closes it on Escape
 * (`isDrawerEscape`); closing hands focus back to what had it before.
 */
export function DetailDrawer(props: DetailDrawerProps): ReactElement | null {
  const { clusterId, resource, history, onClose } = props;
  const resources = props.resources ?? [];
  const drawerRef = useRef<HTMLElement>(null);
  const [drawerWidth, setDrawerWidth] = usePaneSize(DRAWER_PANE);
  const entry = useDetailsEntry({
    clusterId,
    history,
    resources,
    known: resource,
    ownColumns: props.columns ?? [],
  });
  const open = entry !== null;

  const fallback = useRef(props.fallbackFocus);
  fallback.current = props.fallbackFocus;
  // False once Minimize gave focus to the dock: closing then hands nothing back (spec K3).
  const restoreFocus = useRef(true);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    restoreFocus.current = true;
    drawerRef.current?.focus();
    return () => {
      if (!restoreFocus.current) return;
      // The body has focus when nothing does, such as after Open as drawer closed the
      // dock tab that had it (spec K17): the row is a better place.
      if (
        before instanceof HTMLElement &&
        before !== document.body &&
        before.isConnected
      ) {
        before.focus();
      } else fallback.current?.()?.focus();
    };
  }, [open]);

  // A link or Back removes the element that had focus (spec H20).
  const { step } = history;
  const firstStep = useRef(step);
  useEffect(() => {
    if (step !== firstStep.current) drawerRef.current?.focus();
  }, [step]);

  if (entry === null) return null;

  const { target, info, read, own, kind, name, tab } = entry;
  const object = read.object;
  // Hidden where the resource is unknown (spec K2).
  const canMinimize = info !== undefined && read.status !== "notServed";

  /** Moves the shown entry into the dock and closes the drawer (spec K3). */
  function minimize(): void {
    if (!info) return;
    const docked = detailsTab(
      clusterId,
      info.resource,
      target.namespace,
      target.name,
      tab,
    );
    // The tab's button has to be on screen before it can take focus.
    flushSync(() => useDock.getState().open(docked));
    restoreFocus.current = false;
    onClose();
    document.getElementById(`dock-tab-${docked.id}`)?.focus();
  }

  let actions: ReactNode = null;
  if ((read.status === "live" || read.status === "fetched") && object) {
    if (own) actions = props.actions?.(object) ?? null;
    else if (info) {
      actions = (
        <DrawerObjectActions
          clusterId={clusterId}
          info={info}
          object={object}
        />
      );
    }
  }

  return (
    <>
      <div className={styles.dim} aria-hidden="true" data-testid="detail-dim" />
      <aside
        ref={drawerRef}
        tabIndex={-1}
        className={styles.overlay}
        aria-label={`${kind} details`}
        data-testid="detail-drawer"
        data-drawer=""
        style={{ width: drawerWidth }}
      >
        <DrawerResize
          className={styles.handle}
          width={drawerWidth}
          onChange={setDrawerWidth}
        />
        <div className={styles.frame}>
          <header className={styles.band}>
            <div className={styles.bandRow}>
              {history.previous ? (
                <IconButton
                  className={styles.back}
                  label={`Back to ${history.previous.target.name}`}
                  icon={<ChevronLeft size={16} aria-hidden="true" />}
                  onClick={history.back}
                  data-testid="detail-back"
                />
              ) : null}
              <span className={styles.bandKind} data-testid="detail-kind">
                {kind}
              </span>
              <div className={styles.grow} />
              {actions ? (
                <>
                  {actions}
                  <span className={styles.divider} aria-hidden="true" />
                </>
              ) : null}
              {canMinimize ? (
                <IconButton
                  label="Minimize to the dock"
                  icon={<Minimize2 size={16} aria-hidden="true" />}
                  onClick={minimize}
                  data-testid="detail-minimize"
                />
              ) : null}
              <IconButton
                label="Close details"
                icon={<X size={14} aria-hidden="true" />}
                onClick={onClose}
                data-testid="detail-close"
              />
            </div>
            <h3
              className={styles.bandTitle}
              data-testid="detail-title"
              title={name}
            >
              {name}
            </h3>
          </header>
          <DetailsContent
            clusterId={clusterId}
            entry={entry}
            resources={resources}
            onOpen={history.open}
            onTabChange={history.setTab}
          />
        </div>
      </aside>
    </>
  );
}
