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
import { Button, ContextMenu, IconButton, Tooltip } from "../../design";
import type { ContextMenuItem } from "../../design/ContextMenu";
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
import { focusTabElement, tabElementId } from "./tabKeys";
import { type TabMenuId, type TabMenuItem, tabMenu } from "./tabMenu";

/** One Left or Right press moves a splitter by 2% of the width. */
const KEY_STEP = 0.02;
/** Pixels per line of a wheel that counts in lines. */
const WHEEL_LINE_PX = 16;

function dispatch(action: LayoutAction): void {
  useWindowLayout.getState().dispatch(action);
}

/** The items that start a group in the tab menu: the moves, then the closes. */
const MENU_GROUPS: ReadonlySet<TabMenuId> = new Set(["left", "close"]);

function menuItems(items: TabMenuItem[]): ContextMenuItem[] {
  return items.map((it) => ({
    id: it.id,
    label: it.label,
    // An item that cannot apply says why, beside it and as its tooltip (P15).
    hint: it.reason ?? it.hint,
    tooltip: it.reason ?? undefined,
    disabled: it.reason !== null,
    separated: MENU_GROUPS.has(it.id),
    testId: `tab-menu-${it.id}`,
    onSelect: () => {
      if (it.action !== null) dispatch(it.action);
    },
  }));
}

/** Shift+F10 and the context-menu key open the menu under the tab, as a right-click does. */
function openMenuAt(button: HTMLElement): void {
  const box = button.getBoundingClientRect();
  button.dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.bottom,
    }),
  );
}

/**
 * The strip's keys on a tab: Left and Right move the focus along the strip, wrapping,
 * Home and End to its ends; Enter or Space then select. Shift+F10 and the
 * context-menu key open the tab menu (P15).
 */
function onTabKey(
  event: KeyboardEvent<HTMLButtonElement>,
  tabs: TabState[],
  index: number,
): void {
  if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
    event.preventDefault();
    openMenuAt(event.currentTarget);
    return;
  }
  // Alt+Left and Alt+Right are Back and Forward.
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const last = tabs.length - 1;
  const moves: Record<string, number> = {
    ArrowLeft: index === 0 ? last : index - 1,
    ArrowRight: index === last ? 0 : index + 1,
    Home: 0,
    End: last,
  };
  const to = moves[event.key];
  if (to === undefined) return;
  event.preventDefault();
  focusTabElement(tabs[to]?.id);
}

/**
 * A tab in a pane's strip: its icon, screen and cluster chip; pinned tabs show a pin
 * and no Close (P9, P14). A double-click pins or unpins it, a middle-click closes it,
 * and a right-click opens its menu (P13 to P15).
 */
function TabItem(props: {
  tabs: TabState[];
  index: number;
  selected: boolean;
}) {
  const { tabs, index, selected } = props;
  const tab = tabs[index];
  const clusters = useCatalog((s) => s.clusters);
  const layout = useWindowLayout((s) => s.layout);
  const path = tabPath(tab);
  const info = useMemo(() => tabInfo(path, clusters), [path, clusters]);
  const items = menuItems(tabMenu(layout, tab.id, crypto.randomUUID()));
  const Icon = info.icon;
  return (
    <ContextMenu label={`Actions for ${info.title}`} items={items}>
      <div
        className={styles.tab}
        role="presentation"
        data-selected={selected}
        data-pinned={tab.pinned}
      >
        <button
          type="button"
          role="tab"
          id={tabElementId(tab.id)}
          className={styles.tabButton}
          aria-selected={selected}
          aria-label={info.title}
          title={info.title}
          tabIndex={selected ? 0 : -1}
          data-testid={`tab-${tab.id}`}
          onClick={() => dispatch({ type: "select", tabId: tab.id })}
          onDoubleClick={() =>
            dispatch({ type: tab.pinned ? "unpin" : "pin", tabId: tab.id })
          }
          onMouseDown={(event) => {
            // A middle press would start the browser's autoscroll.
            if (event.button === 1) event.preventDefault();
          }}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            dispatch({ type: "close", tabId: tab.id });
          }}
          onKeyDown={(event) => onTabKey(event, tabs, index)}
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
    </ContextMenu>
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
          {pane.tabs.map((tab, at) => (
            <TabItem
              key={tab.id}
              tabs={pane.tabs}
              index={at}
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
