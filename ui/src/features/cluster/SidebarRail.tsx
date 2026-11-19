import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NavLink, useLocation } from "react-router";
import { useNavItem } from "../../app/tabs/navigation";
import { IconButton, Spinner, Tooltip } from "../../design";
import { RefreshCw, X } from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { crdTree } from "../../kinds/crdTree";
import { NAV_SCREENS, type NavIcon, type NavSection } from "../../kinds/nav";
import styles from "./SidebarRail.module.css";
import {
  clusterPath,
  type FlyoutEntry,
  type FlyoutLinkEntry,
  flyoutEntries,
  itemPath,
  sectionActive,
  sidebarGroups,
} from "./sidebarModel";
import { NavItemLink, SectionIcon } from "./sidebarParts";

/** The flyout's least gap to the rail's top and bottom. */
const EDGE = 8;

/** Up and Down move between the rail's icons (spec Q §3). */
function moveOnRail(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  const target = event.target;
  if (
    !(target instanceof HTMLElement) ||
    !target.hasAttribute("data-rail-icon")
  ) {
    return;
  }
  const icons = [
    ...event.currentTarget.querySelectorAll<HTMLElement>("[data-rail-icon]"),
  ];
  const next =
    icons[icons.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}

/** A rail icon that navigates: a screen, or a section with one screen. */
function RailLink(props: {
  to: string;
  label: string;
  icon: NavIcon;
  testId: string;
  end?: boolean;
}) {
  return (
    <Tooltip content={props.label} side="right">
      <NavItemLink
        end={props.end}
        to={props.to}
        className={styles.railIcon}
        aria-label={props.label}
        data-testid={props.testId}
        data-rail-icon=""
      >
        <SectionIcon icon={props.icon} size={18} />
      </NavItemLink>
    </Tooltip>
  );
}

/** A rail icon that opens its section's flyout. */
function RailButton(props: {
  section: NavSection;
  active: boolean;
  open: boolean;
  onOpen(anchor: HTMLElement, toggle: boolean): void;
}) {
  const { section, onOpen } = props;
  return (
    <Tooltip content={section.label} side="right">
      <button
        type="button"
        className={styles.railIcon}
        aria-label={section.label}
        aria-haspopup="menu"
        aria-expanded={props.open}
        aria-current={props.active ? "page" : undefined}
        data-testid={`rail-${section.id}`}
        data-rail-icon=""
        onClick={(event) => onOpen(event.currentTarget, true)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          onOpen(event.currentTarget, false);
        }}
      >
        <SectionIcon icon={section.icon} size={18} />
      </button>
    </Tooltip>
  );
}

/** A failed load of the cluster's resources, while collapsed: an icon that retries. */
function RailRetry(props: { onRetry(): void }) {
  const label = "Could not load resources. Retry";
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        className={styles.railIcon}
        aria-label={label}
        data-testid="rail-retry"
        data-rail-icon=""
        onClick={props.onRetry}
      >
        <RefreshCw size={18} />
      </button>
    </Tooltip>
  );
}

/** A kind pill of a flyout: the sidebar's link handlers, and choosing it closes the flyout. */
function FlyoutLink(props: { entry: FlyoutLinkEntry; onChosen(): void }) {
  const { entry, onChosen } = props;
  const handlers = useNavItem(entry.path);
  return (
    <NavLink
      end={entry.end}
      to={entry.path}
      role="menuitem"
      className={styles.flyoutItem}
      data-testid={entry.testId}
      title={entry.label}
      onClick={(event) => {
        handlers.onClick(event);
        if (event.defaultPrevented) onChosen();
      }}
      onAuxClick={(event) => {
        handlers.onAuxClick(event);
        if (event.defaultPrevented) onChosen();
      }}
      onMouseDown={handlers.onMouseDown}
      onDoubleClick={handlers.onDoubleClick}
    >
      {entry.label}
    </NavLink>
  );
}

function menuItems(list: HTMLElement | null): HTMLElement[] {
  return list === null
    ? []
    : [...list.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

/** A section's flyout beside the rail, aligned to its icon (spec Q §3). */
function Flyout(props: {
  section: NavSection;
  entries: FlyoutEntry[];
  anchor: HTMLElement;
  onClose(): void;
}) {
  const { section, entries, anchor, onClose } = props;
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(EDGE);

  // Aligned to its icon, and kept inside the rail.
  useLayoutEffect(() => {
    const el = box.current;
    const rail = el?.parentElement;
    if (!el || !rail) return;
    const at =
      anchor.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    setTop(
      Math.max(EDGE, Math.min(at, rail.clientHeight - el.offsetHeight - EDGE)),
    );
  }, [anchor]);

  // It opens on its first item.
  useEffect(() => {
    menuItems(list.current)[0]?.focus();
  }, []);

  // A pointer down outside closes it. One on its own icon is left to the icon's
  // click, which closes it, so the press does not close it and the click reopen it.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (box.current?.contains(target) || anchor.contains(target))
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [anchor, onClose]);

  function back(): void {
    anchor.focus();
    onClose();
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const items = menuItems(list.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        back();
        return;
      case "ArrowDown":
        next = items[Math.min(at + 1, items.length - 1)];
        break;
      case "ArrowUp":
        next = items[Math.max(at - 1, 0)];
        break;
      case "Home":
        next = items[0];
        break;
      case "End":
        next = items.at(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  }

  return (
    <div
      ref={box}
      className={styles.flyout}
      style={{ top }}
      data-testid={`rail-flyout-${section.id}`}
    >
      <div className={styles.flyoutHead}>
        <span className={styles.flyoutTitle}>{section.label}</span>
        <IconButton
          label="Close"
          icon={<X size={14} />}
          tooltip={false}
          data-testid="rail-flyout-close"
          onClick={back}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            back();
          }}
        />
      </div>
      <div
        ref={list}
        role="menu"
        aria-label={section.label}
        className={styles.flyoutList}
        onKeyDown={onMenuKeyDown}
      >
        {entries.map((entry) =>
          entry.type === "caption" ? (
            <p key={entry.key} role="presentation" className={styles.caption}>
              {entry.label}
            </p>
          ) : (
            <FlyoutLink key={entry.key} entry={entry} onChosen={onClose} />
          ),
        )}
      </div>
    </div>
  );
}

interface OpenFlyout {
  id: string;
  anchor: HTMLElement;
  /** Counts the openings, so Right on an open icon mounts the flyout again on its first item. */
  seq: number;
}

/**
 * The collapsed cluster navigation (spec Q §3): the sidebar's screens and sections as
 * icons, groups between dividers. A section with several items opens a flyout of them.
 */
export function SidebarRail(props: {
  clusterId: string;
  resources: ApiResourceInfo[];
  loading: boolean;
  error: string | null;
  onRetry(): void;
}) {
  const { clusterId, resources } = props;
  const crds = useMemo(() => crdTree(resources), [resources]);
  const groups = useMemo(
    () => sidebarGroups(resources, crds),
    [resources, crds],
  );
  const { pathname } = useLocation();
  const [flyout, setFlyout] = useState<OpenFlyout | null>(null);
  const close = useCallback(() => setFlyout(null), []);
  const shown =
    flyout === null
      ? undefined
      : groups.flatMap((g) => g.sections).find((s) => s.id === flyout.id);

  function open(id: string, anchor: HTMLElement, toggle: boolean): void {
    setFlyout((before) =>
      toggle && before?.id === id
        ? null
        : { id, anchor, seq: (before?.seq ?? 0) + 1 },
    );
  }

  let body: ReactNode;
  if (props.loading && resources.length === 0) {
    body = (
      <div className={styles.state}>
        <Spinner />
      </div>
    );
  } else {
    body = groups.map(({ group, sections }) => (
      <Fragment key={group.id}>
        <hr
          className={styles.divider}
          data-testid={`rail-divider-${group.id}`}
        />
        {sections.map((s) => {
          const item = s.items[0];
          if (s.direct && item !== undefined) {
            return (
              <RailLink
                key={s.id}
                to={itemPath(clusterId, item)}
                label={s.label}
                icon={s.icon}
                testId={`rail-${s.id}`}
              />
            );
          }
          return (
            <RailButton
              key={s.id}
              section={s}
              active={sectionActive(pathname, clusterId, s, crds)}
              open={flyout?.id === s.id}
              onOpen={(anchor, toggle) => open(s.id, anchor, toggle)}
            />
          );
        })}
      </Fragment>
    ));
  }

  return (
    <div className={styles.rail} data-testid="cluster-rail">
      <nav
        className={styles.icons}
        aria-label="Cluster navigation"
        onKeyDown={moveOnRail}
      >
        {NAV_SCREENS.map((s) => (
          <RailLink
            key={s.id}
            end={s.id === "overview"}
            to={clusterPath(clusterId, s.path)}
            label={s.label}
            icon={s.icon}
            testId={`rail-${s.id}`}
          />
        ))}
        {props.error !== null ? <RailRetry onRetry={props.onRetry} /> : null}
        {body}
      </nav>
      {flyout !== null && shown !== undefined ? (
        <Flyout
          key={`${flyout.id}:${flyout.seq}`}
          section={shown}
          entries={flyoutEntries(clusterId, shown, crds)}
          anchor={flyout.anchor}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
