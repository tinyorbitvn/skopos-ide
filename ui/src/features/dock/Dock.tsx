import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { ConfirmDialog, IconButton, PickerMenu } from "../../design";
import {
  ChevronDown,
  ChevronUp,
  FilePlus,
  type IconComponent,
  PanelBottom,
  PanelRightOpen,
  Pen,
  Plug,
  Plus,
  ScrollText,
  Sparkles,
  SquareTerminal,
  Terminal,
  X,
} from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  type DetailsDockTab,
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  type DockTab,
  dockMaxHeight,
  newCreateTab,
  tabsForCluster,
  useDock,
} from "../../stores/dock";
import { agentsSupported } from "../agents/supported";
import { CreateResourceTab } from "../editor/CreateResourceTab";
import { EditResourceTab } from "../editor/EditResourceTab";
import { servedKinds } from "../editor/servedKinds";
import { templateSections } from "../editor/templates/pickerSections";
import { LogsTab } from "../logs/LogsTab";
import { TerminalTab } from "../terminal/TerminalTab";
import { isTerminalShortcut } from "../terminal/terminalKeys";
import { DetailsTab } from "./DetailsTab";
import styles from "./Dock.module.css";
import { useOpenAsDrawer } from "./openAsDrawer";
import { openAiDraft, openTemplate } from "./openTemplate";
import { newTerminal, openTerminal } from "./openTerminal";
import { shownDetailsEntry } from "./useDetailsHistory";

const KEYBOARD_RESIZE_STEP = 24;
/** A press that moves less than this is a click, so it still selects the tab. */
const DRAG_DISTANCE = 4;
const NO_RESOURCES: ApiResourceInfo[] = [];

const TAB_ICONS: Record<DockTab["kind"], IconComponent> = {
  edit: Pen,
  create: FilePlus,
  logs: ScrollText,
  terminal: SquareTerminal,
  shell: Terminal,
  attach: Plug,
  nodeShell: Terminal,
  details: PanelBottom,
};

function TabBody({
  tab,
  shown,
  resources,
}: {
  tab: DockTab;
  shown: boolean;
  resources: ApiResourceInfo[];
}) {
  switch (tab.kind) {
    case "edit":
      return <EditResourceTab tab={tab} resources={resources} />;
    case "create":
      return <CreateResourceTab tab={tab} resources={resources} />;
    case "logs":
      return <LogsTab tab={tab} shown={shown} />;
    case "terminal":
    case "shell":
    case "attach":
    case "nodeShell":
      return <TerminalTab tab={tab} shown={shown} />;
    case "details":
      return <DetailsTab tab={tab} resources={resources} />;
  }
}

/** Open as drawer on a details tab's strip entry, for the entry it shows (spec K7, K15). */
function DetailsPopButton({ tab }: { tab: DetailsDockTab }) {
  const openAsDrawer = useOpenAsDrawer();
  return (
    <IconButton
      className={styles.tabPop}
      label={`Open ${tab.title} as drawer`}
      icon={<PanelRightOpen size={12} aria-hidden="true" />}
      onClick={() => openAsDrawer(tab, shownDetailsEntry(tab))}
      data-testid={`dock-pop-${tab.id}`}
    />
  );
}

/** The drag handle on the dock's top edge. Up makes the dock taller. */
function ResizeHandle() {
  const height = useDock((s) => s.height);
  const setHeight = useDock((s) => s.setHeight);
  const drag = useRef<{ fromY: number; fromHeight: number } | null>(null);

  function start(event: PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { fromY: event.clientY, fromHeight: height };
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    setHeight(drag.current.fromHeight + drag.current.fromY - event.clientY);
  }

  function stop(): void {
    drag.current = null;
  }

  function key(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowUp") setHeight(height + KEYBOARD_RESIZE_STEP);
    if (event.key === "ArrowDown") setHeight(height - KEYBOARD_RESIZE_STEP);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: an hr cannot be dragged or focused.
    <div
      className={styles.resize}
      role="separator"
      aria-label="Resize dock"
      aria-orientation="horizontal"
      aria-valuenow={Math.round(height)}
      aria-valuemin={DOCK_MIN_HEIGHT}
      aria-valuemax={Math.round(dockMaxHeight())}
      title="Drag to resize, double-click to reset"
      tabIndex={0}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => setHeight(DOCK_DEFAULT_HEIGHT)}
      onKeyDown={key}
      data-testid="dock-resize"
    />
  );
}

/** One tab on the dock bar. It is sortable, and Ctrl+Shift+PageUp/PageDown move it. */
function DockTabItem(props: {
  tab: DockTab;
  /** Selected and shown. */
  active: boolean;
  selected: boolean;
  onSelect(): void;
  onClose(): void;
  onMove(delta: -1 | 1): void;
}) {
  const { tab } = props;
  const { listeners, setNodeRef, transform, transition } = useSortable({
    id: tab.id,
  });
  const Icon = TAB_ICONS[tab.kind];

  function key(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!event.ctrlKey || !event.shiftKey) return;
    if (event.key !== "PageUp" && event.key !== "PageDown") return;
    event.preventDefault();
    props.onMove(event.key === "PageUp" ? -1 : 1);
  }

  return (
    <div
      ref={setNodeRef}
      className={styles.tab}
      data-active={props.active}
      role="presentation"
      style={{
        // Along the bar only.
        transform: transform
          ? `translate3d(${Math.round(transform.x)}px, 0, 0)`
          : undefined,
        transition,
      }}
    >
      <button
        type="button"
        role="tab"
        id={`dock-tab-${tab.id}`}
        className={styles.tabLabel}
        aria-selected={props.selected}
        aria-controls={`dock-panel-${tab.id}`}
        title={tab.title}
        {...listeners}
        onClick={props.onSelect}
        onKeyDown={key}
        data-testid={`dock-tab-${tab.id}`}
        data-dirty={tab.dirty}
      >
        <Icon size={14} aria-hidden="true" className={styles.tabIcon} />
        {tab.dirty ? (
          <span className={styles.dirty} title="Unsaved changes">
            ●
          </span>
        ) : null}
        {tab.title}
      </button>
      {tab.kind === "details" ? <DetailsPopButton tab={tab} /> : null}
      <button
        type="button"
        className={styles.tabClose}
        aria-label={`Close ${tab.title}`}
        title="Close"
        onClick={props.onClose}
        data-testid={`dock-close-${tab.id}`}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The panel under a cluster's content that holds its editors, logs and details. */
export function Dock(props: {
  clusterId: string;
  /** The cluster's served resources, for details tabs. */
  resources?: ApiResourceInfo[];
}) {
  const { clusterId } = props;
  const resources = props.resources ?? NO_RESOURCES;
  const served = useMemo(() => servedKinds(resources), [resources]);
  const restored = useDock((s) => s.restored);
  const allTabs = useDock((s) => s.tabs);
  const activeId = useDock((s) => s.activeId);
  const height = useDock((s) => s.height);
  const minimized = useDock((s) => s.minimized);
  const [closing, setClosing] = useState<DockTab | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: DRAG_DISTANCE },
    }),
  );

  // Ctrl+` anywhere on the cluster's screen. xterm leaves it alone, so it also works
  // from inside a terminal.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent): void {
      if (!isTerminalShortcut(event)) return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      event.preventDefault();
      openTerminal(clusterId);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clusterId]);

  // The saved layout comes first, so its tabs do not appear after a moment.
  if (!restored) return null;

  const tabs = tabsForCluster(allTabs, clusterId);
  // The active tab may be another cluster's, which is not shown here.
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  const expanded = active !== null && !minimized;

  function select(tab: DockTab): void {
    const dock = useDock.getState();
    dock.activate(tab.id);
    dock.setMinimized(false);
  }

  function requestClose(tab: DockTab): void {
    if (tab.dirty) setClosing(tab);
    else useDock.getState().close(tab.id);
  }

  function moveBy(tab: DockTab, delta: -1 | 1): void {
    const at = tabs.findIndex((t) => t.id === tab.id);
    // Reordering moves the button in the DOM, which drops the focus: give it back.
    flushSync(() => useDock.getState().move(tab.id, at + delta));
    document.getElementById(`dock-tab-${tab.id}`)?.focus();
  }

  function onDragEnd({ active: dragged, over }: DragEndEvent): void {
    if (!over || dragged.id === over.id) return;
    const to = tabs.findIndex((t) => t.id === String(over.id));
    if (to !== -1) useDock.getState().move(String(dragged.id), to);
  }

  return (
    <section
      className={styles.dock}
      style={expanded ? { height } : undefined}
      aria-label="Dock"
      data-testid="dock"
    >
      {expanded ? <ResizeHandle /> : null}
      <div className={styles.bar}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div
              className={styles.tabs}
              role="tablist"
              aria-label="Open editors"
            >
              {tabs.map((tab) => (
                <DockTabItem
                  key={tab.id}
                  tab={tab}
                  active={expanded && tab.id === active?.id}
                  selected={tab.id === active?.id}
                  onSelect={() => select(tab)}
                  onClose={() => requestClose(tab)}
                  onMove={(delta) => moveBy(tab, delta)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <div className={styles.newTab}>
          <PickerMenu
            label="New tab"
            searchLabel="Search templates"
            side="top"
            align="start"
            width={300}
            testId="dock-new-picker"
            empty={(query) => `No template matches "${query}".`}
            sections={[
              {
                id: "start",
                items: [
                  {
                    id: "blank",
                    label: "Blank YAML",
                    icon: <FilePlus size={14} aria-hidden="true" />,
                    testId: "create-resource",
                    onSelect: () =>
                      useDock.getState().open(newCreateTab(clusterId)),
                  },
                  ...(agentsSupported()
                    ? [
                        {
                          id: "ai-draft",
                          label: "Draft with AI",
                          icon: <Sparkles size={14} aria-hidden="true" />,
                          testId: "dock-ai-draft",
                          onSelect: () => openAiDraft(clusterId),
                        },
                      ]
                    : []),
                  {
                    id: "terminal",
                    label: "Terminal session",
                    icon: <SquareTerminal size={14} aria-hidden="true" />,
                    testId: "dock-terminal",
                    onSelect: () => newTerminal(clusterId),
                  },
                ],
              },
              ...templateSections(served, (template) =>
                openTemplate(clusterId, template),
              ),
            ]}
            trigger={({ open, toggle }) => (
              <IconButton
                label="New tab"
                icon={<Plus size={14} aria-hidden="true" />}
                aria-expanded={open}
                onClick={toggle}
                data-testid="dock-new"
              />
            )}
          />
        </div>
        {tabs.length > 0 ? (
          <IconButton
            label={minimized ? "Restore dock" : "Minimize dock"}
            icon={
              minimized ? (
                <ChevronUp size={16} aria-hidden="true" />
              ) : (
                <ChevronDown size={16} aria-hidden="true" />
              )
            }
            aria-expanded={!minimized}
            onClick={() => useDock.getState().setMinimized(!minimized)}
            data-testid="dock-minimize"
          />
        ) : null}
      </div>
      {tabs.map((tab) => (
        // Hidden, not unmounted: another tab or minimizing must keep the editor,
        // and Logs and terminal tabs keep their sessions.
        <div
          key={tab.id}
          id={`dock-panel-${tab.id}`}
          className={styles.panel}
          role="tabpanel"
          aria-labelledby={`dock-tab-${tab.id}`}
          hidden={!expanded || tab.id !== active?.id}
          data-testid={`dock-panel-${tab.id}`}
        >
          <TabBody
            tab={tab}
            shown={expanded && tab.id === active?.id}
            resources={resources}
          />
        </div>
      ))}
      {closing ? (
        <ConfirmDialog
          open
          title="Discard unsaved changes?"
          body={`${closing.title} has changes that were not saved.`}
          confirmLabel="Discard"
          danger
          onConfirm={() => {
            useDock.getState().close(closing.id);
            setClosing(null);
          }}
          onCancel={() => setClosing(null)}
        />
      ) : null}
    </section>
  );
}
