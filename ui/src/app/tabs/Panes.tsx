import {
  Fragment,
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { Button, ContextMenu, IconButton, Tooltip } from "../../design";
import type { ContextMenuItem } from "../../design/ContextMenu";
import { Columns2, Ellipsis, LayoutGrid, Pin, X } from "../../design/icons";
import type { PaneState } from "../../ipc/generated/PaneState";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import { MAIN_WINDOW } from "../../ipc/window";
import { useCatalog } from "../../stores/catalog";
import { useWindowLayout } from "../../stores/windowLayout";
import { clusterColor } from "../clusterVisual";
import {
  type DropOver,
  dropLabel,
  dropZones,
  markIndex,
  type ZoneKind,
} from "./drag";
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
import { startTabDrag, useTabDrag } from "./tabDrag";
import { focusTabElement, tabElementId } from "./tabKeys";
import {
  type TabMenuId,
  type TabMenuItem,
  type TabMenuWindow,
  tabMenu,
} from "./tabMenu";
import {
  moveTabToWindow,
  openInNewWindow,
  refreshWindowList,
  useWindowList,
  windowChoices,
} from "./windowMoves";

/** One Left or Right press moves a splitter by 2% of the width. */
const KEY_STEP = 0.02;
/** Pixels per line of a wheel that counts in lines. */
const WHEEL_LINE_PX = 16;

function dispatch(action: LayoutAction): void {
  useWindowLayout.getState().dispatch(action);
}

/** The items that start a group in the tab menu: the moves, then the closes. */
const MENU_GROUPS: ReadonlySet<TabMenuId> = new Set(["left", "close"]);

/** "Move to window ▸" goes through the core, which sends the new layouts (P31, P33). */
function windowItems(tabId: string, items: TabMenuWindow[]): ContextMenuItem[] {
  return items.map((w) => ({
    id: w.id,
    label: w.label,
    hint: w.hint,
    testId: `tab-menu-${w.id}`,
    onSelect: () => {
      if (w.target.kind === "window")
        void moveTabToWindow(tabId, w.target.label);
      else void openInNewWindow(tabId);
    },
  }));
}

function menuItems(tabId: string, items: TabMenuItem[]): ContextMenuItem[] {
  return items.map((it) => ({
    id: it.id,
    label: it.label,
    // An item that cannot apply says why, beside it and as its tooltip (P15).
    hint: it.reason ?? it.hint,
    tooltip: it.reason ?? undefined,
    disabled: it.reason !== null,
    separated: MENU_GROUPS.has(it.id),
    testId: `tab-menu-${it.id}`,
    sub: it.windows ? windowItems(tabId, it.windows) : undefined,
    onSelect: () => {
      if (it.action !== null) dispatch(it.action);
    },
  }));
}

/**
 * The tab menu's items, built from the layout and the other windows while the menu is
 * open, so the windows read as it opens show up. Closed, the tab follows neither, and
 * a layout change does not redraw it.
 */
function useMenuItems(tabId: string, open: boolean): ContextMenuItem[] {
  const layout = useWindowLayout((s) => (open ? s.layout : null));
  const layouts = useWindowList((s) => (open ? s.layouts : null));
  const clusters = useCatalog((s) => s.clusters);
  // The pane "Move to a new pane on the right" makes, named once per opening.
  const newPaneId = useMemo(() => (open ? crypto.randomUUID() : ""), [open]);
  return useMemo(() => {
    if (layout === null) return [];
    const windows = windowChoices(layouts ?? [], layout.label, clusters);
    return menuItems(tabId, tabMenu(layout, tabId, newPaneId, { windows }));
  }, [layout, layouts, clusters, tabId, newPaneId]);
}

/** The tabs of a pane as they are now, for a key pressed on one of them. */
function paneTabs(paneId: string): TabState[] {
  const { layout } = useWindowLayout.getState();
  return layout.panes.find((p) => p.id === paneId)?.tabs ?? [];
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
 * and no Close (P9, P14). The selected tab has a Tab actions button that opens its
 * menu (spec Q §5). A double-click pins or unpins it, a middle-click closes it,
 * a right-click opens its menu (P13 to P15), and a press drags it (P22). It takes only
 * the values it shows, so a change elsewhere in the layout, such as a splitter drag,
 * does not redraw it.
 */
const TabItem = memo(function TabItem(props: {
  paneId: string;
  tabId: string;
  path: string;
  pinned: boolean;
  index: number;
  selected: boolean;
}) {
  const { paneId, tabId, path, pinned, index, selected } = props;
  const dragging = useTabDrag((s) => s.drag?.tabId === tabId);
  const clusters = useCatalog((s) => s.clusters);
  const info = useMemo(() => tabInfo(path, clusters), [path, clusters]);
  const [menuOpen, setMenuOpen] = useState(false);
  const items = useMenuItems(tabId, menuOpen);
  const Icon = info.icon;
  return (
    <ContextMenu
      label={`Actions for ${info.title}`}
      items={items}
      // The other windows are read when the menu opens (P15).
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (open) void refreshWindowList();
      }}
    >
      <div
        className={styles.tab}
        role="presentation"
        data-selected={selected}
        data-pinned={pinned}
        data-dragging={dragging}
        data-drop-pane={paneId}
        data-drop-index={index}
      >
        <button
          type="button"
          role="tab"
          id={tabElementId(tabId)}
          className={styles.tabButton}
          aria-selected={selected}
          aria-label={info.title}
          title={info.title}
          tabIndex={selected ? 0 : -1}
          data-testid={`tab-${tabId}`}
          onClick={() => dispatch({ type: "select", tabId })}
          onPointerDown={(event) =>
            startTabDrag(event.nativeEvent, tabId, info.title)
          }
          onDoubleClick={() =>
            dispatch({ type: pinned ? "unpin" : "pin", tabId })
          }
          onMouseDown={(event) => {
            // A middle press would start the browser's autoscroll.
            if (event.button === 1) event.preventDefault();
          }}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            dispatch({ type: "close", tabId });
          }}
          onKeyDown={(event) => onTabKey(event, paneTabs(paneId), index)}
        >
          {pinned ? (
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
        {selected ? (
          <button
            type="button"
            className={styles.tabControl}
            aria-label="Tab actions"
            aria-haspopup="menu"
            title="Tab actions"
            tabIndex={-1}
            data-testid={`tab-actions-${tabId}`}
            // The same menu as a right-click or Shift+F10, under the button.
            onClick={(event) => openMenuAt(event.currentTarget)}
          >
            <Ellipsis size={12} aria-hidden="true" />
          </button>
        ) : null}
        {pinned ? null : (
          <button
            type="button"
            className={styles.tabControl}
            aria-label={`Close ${info.title}`}
            title="Close tab"
            tabIndex={-1}
            data-testid={`tab-close-${tabId}`}
            onClick={() => dispatch({ type: "close", tabId })}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </ContextMenu>
  );
});

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

/** What a body zone says while a tab is dragged (P22). */
const ZONE_LABELS: Record<ZoneKind, string> = {
  left: "New pane on the left",
  right: "New pane on the right",
  here: "Move to this pane (3 panes at most)",
};

function zoneIsOver(
  over: DropOver | null,
  paneId: string,
  zone: ZoneKind,
): boolean {
  return (
    over?.kind === "inside" &&
    over.target.kind === "body" &&
    over.target.paneId === paneId &&
    (zone === "here" || over.target.side === zone)
  );
}

/** The line in a strip where a dragged tab would land (P22). */
function DropMark() {
  return (
    <span
      className={styles.mark}
      aria-hidden="true"
      data-testid="tab-drop-mark"
    />
  );
}

/** The width the drag label keeps from the right edge of the window. */
const DRAG_LABEL_ROOM = 260;

/**
 * The dragged tab's title and what letting go does, beside the pointer (P22). Over a
 * pane body that offers no zone it shows the drop is refused (spec Q §5).
 */
function DragLabel() {
  const drag = useTabDrag((s) => s.drag);
  if (drag === null) return null;
  const left = Math.max(
    0,
    Math.min(drag.x + 14, window.innerWidth - DRAG_LABEL_ROOM),
  );
  const top = Math.max(0, Math.min(drag.y + 16, window.innerHeight - 64));
  return createPortal(
    <div
      className={styles.dragLabel}
      style={{ left, top }}
      aria-hidden="true"
      data-drop={drag.over !== null}
      data-refused={drag.refused}
      data-testid="tab-drag-label"
    >
      <span className={styles.dragTitle}>{drag.title}</span>
      <span className={styles.dragHint}>{dropLabel(drag.over)}</span>
    </div>,
    document.body,
  );
}

function Pane(props: {
  layout: WindowLayout;
  pane: PaneState;
  index: number;
  focused: boolean;
  count: number;
  label: string;
}) {
  const { layout, pane, index, focused, count } = props;
  const draggedId = useTabDrag((s) => s.drag?.tabId ?? null);
  const over = useTabDrag((s) => s.drag?.over ?? null);
  const zones = draggedId === null ? [] : dropZones(layout, draggedId, pane.id);
  const mark =
    draggedId !== null &&
    over?.kind === "inside" &&
    over.target.kind === "strip" &&
    over.target.paneId === pane.id
      ? markIndex(layout, draggedId, over.target)
      : null;
  const selected = pane.tabs.find((t) => t.id === pane.selected) ?? null;
  const selectedId = selected?.id ?? null;
  const selectedAt = selected === null ? -1 : pane.tabs.indexOf(selected);
  const strip = useRef<HTMLDivElement>(null);
  // The selected tab stays in sight in a strip too long for the pane, wherever it
  // came from (a click, a new tab at the end, a move, a restore, a close that slides
  // the next tab into its place); focus stays put.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `selectedId` scrolls a new tab at the same index.
  useEffect(() => {
    if (selectedAt < 0) return;
    strip.current
      ?.querySelector(':scope > [data-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedAt, selectedId]);
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
      <div
        className={styles.strip}
        data-drop-pane={pane.id}
        data-drop-count={pane.tabs.length}
      >
        <div
          ref={strip}
          className={styles.tabs}
          role="tablist"
          aria-label={`Tabs of pane ${index + 1}`}
          onWheel={scrollStrip}
        >
          {pane.tabs.map((tab, at) => (
            <Fragment key={tab.id}>
              {mark === at ? <DropMark /> : null}
              <TabItem
                paneId={pane.id}
                tabId={tab.id}
                path={tabPath(tab)}
                pinned={tab.pinned}
                index={at}
                selected={tab.id === pane.selected}
              />
            </Fragment>
          ))}
          {mark === pane.tabs.length ? <DropMark /> : null}
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
        className={styles.bodyArea}
        // A body that offers no zone refuses the dragged tab (spec Q §5).
        data-drop-refused={draggedId !== null && zones.length === 0}
      >
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
        {zones.length > 0 ? (
          <div className={styles.zones}>
            {zones.map((zone) => (
              <div
                key={zone}
                className={styles.zone}
                data-drop-zone={zone}
                data-drop-pane={pane.id}
                data-over={zoneIsOver(over, pane.id, zone)}
                data-testid={`pane-drop-${zone}-${index}`}
              >
                {ZONE_LABELS[zone]}
              </div>
            ))}
          </div>
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
  // Drawn 2 px wide in the accent while it is dragged (spec Q §5).
  const [active, setActive] = useState(false);

  function start(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const total =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    if (total <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { fromX: event.clientX, from: share, total };
    setActive(true);
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
    setActive(false);
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
        data-active={active}
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
            layout={layout}
            pane={pane}
            index={index}
            focused={index === layout.focusedPane}
            count={count}
            label={label}
          />
        </Fragment>
      ))}
      <DragLabel />
    </div>
  );
}
