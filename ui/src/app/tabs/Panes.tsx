import { Columns2, LayoutGrid, Pin, X } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  type WheelEvent,
} from "react";
import { Button, IconButton, Tooltip } from "../../design";
import type { PaneState } from "../../ipc/generated/PaneState";
import type { TabState } from "../../ipc/generated/TabState";
import { MAIN_WINDOW } from "../../ipc/window";
import { useCatalog } from "../../stores/catalog";
import { useWindowLayout } from "../../stores/windowLayout";
import { clusterColor } from "../clusterVisual";
import {
  type LayoutAction,
  MAX_PANES,
  MIN_PANE_SHARE,
  tabPath,
} from "./layout";
import { openPath, screenLinkHandlers } from "./navigation";
import styles from "./Panes.module.css";
import { tabInfo } from "./routes";
import { TabView } from "./TabView";

/** One Left or Right press moves a splitter by 2% of the width. */
const KEY_STEP = 0.02;
/** Pixels per line of a wheel that counts in lines. */
const WHEEL_LINE_PX = 16;

function dispatch(action: LayoutAction): void {
  useWindowLayout.getState().dispatch(action);
}

/** A tab in a pane's strip: its icon, screen and cluster chip; pinned tabs show a pin and no Close (P9, P14). */
function TabItem(props: { tab: TabState; selected: boolean }) {
  const { tab, selected } = props;
  const clusters = useCatalog((s) => s.clusters);
  const path = tabPath(tab);
  const info = useMemo(() => tabInfo(path, clusters), [path, clusters]);
  const Icon = info.icon;
  return (
    <div
      className={styles.tab}
      role="presentation"
      data-selected={selected}
      data-pinned={tab.pinned}
    >
      <button
        type="button"
        role="tab"
        className={styles.tabButton}
        aria-selected={selected}
        aria-label={info.title}
        title={info.title}
        tabIndex={selected ? 0 : -1}
        data-testid={`tab-${tab.id}`}
        onClick={() => dispatch({ type: "select", tabId: tab.id })}
      >
        {tab.pinned ? (
          <Pin size={12} aria-hidden="true" className={styles.pin} />
        ) : null}
        <Icon size={14} aria-hidden="true" className={styles.icon} />
        <span className={styles.label}>{info.screen}</span>
        {info.clusterId !== null ? (
          <span className={styles.chip}>
            <span
              className={styles.chipDot}
              style={{ backgroundColor: clusterColor(info.clusterId) }}
            />
            <span className={styles.label}>{info.clusterName}</span>
          </span>
        ) : null}
      </button>
      {tab.pinned ? null : (
        <button
          type="button"
          className={styles.close}
          aria-label={`Close ${info.title}`}
          title="Close tab"
          tabIndex={-1}
          data-testid={`tab-close-${tab.id}`}
          onClick={() => dispatch({ type: "close", tabId: tab.id })}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** A vertical wheel over a strip too long for its pane scrolls it sideways. */
function scrollStrip(event: WheelEvent<HTMLDivElement>): void {
  const strip = event.currentTarget;
  if (event.deltaX !== 0 || strip.scrollWidth <= strip.clientWidth) return;
  const lines = event.deltaMode === 1;
  strip.scrollLeft += lines ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
}

/** The main window without tabs (P21). */
function EmptyPane() {
  return (
    <div className={styles.empty} data-testid="pane-empty">
      <p className={styles.emptyTitle}>No tabs open</p>
      <p className={styles.emptyBody}>
        Pick a screen in the sidebar, or start from the Catalog.
      </p>
      <Button
        variant="primary"
        data-testid="pane-empty-catalog"
        onClick={() => openPath("/catalog", "current")}
      >
        <LayoutGrid size={14} aria-hidden="true" />
        Open the Catalog
      </Button>
    </div>
  );
}

function Pane(props: {
  pane: PaneState;
  index: number;
  focused: boolean;
  count: number;
  label: string;
}) {
  const { pane, index, focused, count } = props;
  const selected = pane.tabs.find((t) => t.id === pane.selected) ?? null;
  const selectedId = selected?.id ?? null;
  const selectedAt = selected === null ? -1 : pane.tabs.indexOf(selected);
  const strip = useRef<HTMLDivElement>(null);
  // The selected tab stays in sight in a strip too long for the pane, wherever it
  // came from (a click, a new tab at the end, a move, a restore); focus stays put.
  useEffect(() => {
    if (selectedAt < 0) return;
    strip.current
      ?.querySelector(':scope > [data-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedAt]);
  // Ctrl/Cmd and middle clicks on links inside the screen (P11, P12).
  const links = useMemo(
    () => (selectedId === null ? {} : screenLinkHandlers(selectedId)),
    [selectedId],
  );
  const focus = () => {
    if (!focused) dispatch({ type: "focusPane", paneId: pane.id });
  };
  return (
    <section
      className={styles.pane}
      style={{ flexGrow: pane.width }}
      aria-label={`Pane ${index + 1}`}
      data-testid={`pane-${index}`}
      data-pane-id={pane.id}
      data-focused={focused && count > 1}
      data-current={focused}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      <div className={styles.strip}>
        <div
          ref={strip}
          className={styles.tabs}
          role="tablist"
          aria-label={`Tabs of pane ${index + 1}`}
          onWheel={scrollStrip}
        >
          {pane.tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              selected={tab.id === pane.selected}
            />
          ))}
        </div>
        <IconButton
          label={
            count >= MAX_PANES ? "Split right: 3 panes at most" : "Split right"
          }
          icon={<Columns2 size={14} aria-hidden="true" />}
          className={styles.split}
          disabled={count >= MAX_PANES || selected === null}
          data-testid={`pane-split-${index}`}
          onClick={() =>
            dispatch({
              type: "split",
              paneId: pane.id,
              newTabId: crypto.randomUUID(),
              newPaneId: crypto.randomUUID(),
            })
          }
        />
      </div>
      <div
        className={styles.body}
        data-testid={`pane-body-${index}`}
        {...links}
      >
        {selected !== null ? (
          <TabView key={selected.id} tab={selected} />
        ) : props.label === MAIN_WINDOW ? (
          <EmptyPane />
        ) : null}
      </div>
    </section>
  );
}

/**
 * The handle between pane `index` and the next (P18). Its value is the left pane's
 * share of the width, in percent; the arrow keys move it by 2%, and a double-click
 * makes the panes equal.
 */
function Splitter(props: { index: number; share: number }) {
  const { index, share } = props;
  const drag = useRef<{ fromX: number; from: number; total: number } | null>(
    null,
  );

  function start(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const total =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    if (total <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { fromX: event.clientX, from: share, total };
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    if (drag.current === null) return;
    const { fromX, from, total } = drag.current;
    dispatch({
      type: "resize",
      index,
      share: from + (event.clientX - fromX) / total,
    });
  }

  function stop(): void {
    drag.current = null;
  }

  function key(event: KeyboardEvent<HTMLDivElement>): void {
    const step =
      event.key === "ArrowLeft"
        ? -KEY_STEP
        : event.key === "ArrowRight"
          ? KEY_STEP
          : 0;
    if (step === 0) return;
    event.preventDefault();
    dispatch({ type: "resize", index, share: share + step });
  }

  return (
    <Tooltip content="Drag to resize, double-click to make the panes equal">
      {/* biome-ignore lint/a11y/useSemanticElements: an hr cannot be dragged or focused. */}
      <div
        className={styles.splitter}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize panes ${index + 1} and ${index + 2}`}
        aria-valuemin={Math.round(MIN_PANE_SHARE * 100)}
        aria-valuemax={Math.round((1 - MIN_PANE_SHARE) * 100)}
        aria-valuenow={Math.round(share * 100)}
        tabIndex={0}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onDoubleClick={() => dispatch({ type: "equalize" })}
        onKeyDown={key}
        data-testid={`pane-resize-${index}`}
      />
    </Tooltip>
  );
}

/** The window's panes side by side (spec P18 to P21), each with its strip and selected tab. */
export function Panes() {
  const layout = useWindowLayout((s) => s.layout);
  const label = useWindowLayout((s) => s.label);
  const count = layout.panes.length;
  return (
    <div className={styles.panes} data-testid="panes">
      {layout.panes.map((pane, index) => (
        <Fragment key={pane.id}>
          {index > 0 ? (
            <Splitter index={index - 1} share={layout.panes[index - 1].width} />
          ) : null}
          <Pane
            pane={pane}
            index={index}
            focused={index === layout.focusedPane}
            count={count}
            label={label}
          />
        </Fragment>
      ))}
    </div>
  );
}
