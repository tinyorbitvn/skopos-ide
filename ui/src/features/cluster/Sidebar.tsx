import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation } from "react-router";
import { ErrorNotice, Spinner } from "../../design";
import { ChevronDown, ChevronRight } from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  type CrdDomainRow,
  type CrdKindItem,
  crdTree,
} from "../../kinds/crdTree";
import {
  NAV_SCREENS,
  type NavBranch,
  type NavIcon,
  type NavSection,
  navItemKey,
  navLabel,
  resourcePath,
} from "../../kinds/nav";
import { useUiState } from "../../stores/uiState";
import { useWindowLayout } from "../../stores/windowLayout";
import styles from "./Sidebar.module.css";
import {
  clusterPath,
  isAt,
  itemPath,
  itemTestId,
  kindTestId,
  looseItems,
  openTabPaths,
  screenTestId,
  sectionActive,
  sidebarGroups,
} from "./sidebarModel";
import { NavItemLink, SectionIcon } from "./sidebarParts";

/** The locations open in this window's tabs, for the open-tab dots (spec Q §2). */
const OpenPaths = createContext<ReadonlySet<string>>(new Set());

function useOpenPaths(): ReadonlySet<string> {
  // A string, so the sidebar renders again only when the set of paths changes.
  const joined = useWindowLayout((s) => [...openTabPaths(s.layout)].join("\n"));
  return useMemo(
    () => new Set(joined === "" ? [] : joined.split("\n")),
    [joined],
  );
}

/** A link's open-tab dot: no copy, hidden from assistive technology. */
function OpenDot() {
  return (
    <span
      className={styles.openDot}
      aria-hidden="true"
      data-testid="nav-open-dot"
    />
  );
}

/** A kind or a route under an open section or branch: a pill on the tree lines. */
function Pill(props: {
  to: string;
  label: string;
  testId: string;
  end?: boolean;
}) {
  const open = useContext(OpenPaths);
  return (
    <li className={styles.leaf}>
      <NavItemLink
        end={props.end}
        to={props.to}
        className={styles.pill}
        data-testid={props.testId}
        title={props.label}
      >
        {({ isActive }) => (
          <>
            <span className={styles.text}>{props.label}</span>
            {!isActive && open.has(props.to) ? <OpenDot /> : null}
          </>
        )}
      </NavItemLink>
    </li>
  );
}

/** A section row that is a link: a screen, or a section with one screen. */
function DirectLink(props: {
  to: string;
  label: string;
  icon: NavIcon;
  testId: string;
  end?: boolean;
}) {
  const open = useContext(OpenPaths);
  return (
    <NavItemLink
      end={props.end}
      to={props.to}
      className={styles.row}
      data-testid={props.testId}
      title={props.label}
    >
      {({ isActive }) => (
        <>
          <SectionIcon icon={props.icon} size={16} className={styles.rowIcon} />
          <span className={styles.text}>{props.label}</span>
          {!isActive && open.has(props.to) ? <OpenDot /> : null}
        </>
      )}
    </NavItemLink>
  );
}

/** The saved open state of a tree row (spec H §4.2). */
function rowKey(clusterId: string, level: "domain" | "group", name: string) {
  return `cluster.${clusterId}.nav.custom.${level}.${name}`;
}

/** The API group whose kind's list is on screen, or null. */
function activeCrdGroup(
  rows: CrdDomainRow[],
  clusterId: string,
  pathname: string,
): string | null {
  for (const row of rows) {
    for (const item of [...row.items, ...row.groups.flatMap((g) => g.items)]) {
      if (isAt(pathname, resourcePath(clusterId, item.group, item.plural))) {
        return item.group;
      }
    }
  }
  return null;
}

/**
 * A row's open state, kept per cluster. It opens when the page on screen comes under
 * it. The effect runs when `active` changes (setOpen is stable for a key), not on every
 * render, so a row the user closes on its own page stays closed.
 */
function useRowOpen(
  key: string,
  active: boolean,
  initial = false,
): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useUiState<boolean>(key, initial);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active, setOpen]);
  return [open, setOpen];
}

/** A sub-branch row: Argo CD, or a Custom Resources domain or API group. */
function RowToggle(props: {
  open: boolean;
  active: boolean;
  panel: string;
  title: string;
  label: string;
  count: number;
  testId: string;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className={styles.branchRow}
      data-active={props.active ? "true" : undefined}
      aria-expanded={props.open}
      aria-controls={props.panel}
      title={props.title}
      data-testid={props.testId}
      onClick={props.onToggle}
    >
      <span aria-hidden="true" className={styles.branchChevron}>
        {props.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </span>
      <span className={styles.text}>{props.label}</span>
      <span className={styles.count}>{props.count}</span>
    </button>
  );
}

function KindLinks(props: { clusterId: string; items: CrdKindItem[] }) {
  return (
    <>
      {props.items.map((i) => (
        <Pill
          key={`${i.group}/${i.plural}`}
          to={resourcePath(props.clusterId, i.group, i.plural)}
          label={i.label}
          testId={kindTestId(i.group, i.plural)}
        />
      ))}
    </>
  );
}

/** A "group" row (level 1) or a level-2 row: an API group that opens to its kinds. */
function GroupRow(props: {
  clusterId: string;
  group: string;
  label: string;
  title: string;
  items: CrdKindItem[];
  storageKey: string;
  activeGroup: string | null;
}) {
  const active = props.activeGroup === props.group;
  const [open, setOpen] = useRowOpen(props.storageKey, active);
  const panel = `nav-crd-panel-${props.group}`;
  return (
    <li className={styles.leaf} data-testid={`nav-crd-group-${props.group}`}>
      <RowToggle
        open={open}
        active={active}
        panel={panel}
        title={props.title}
        label={props.label}
        count={props.items.length}
        testId={`nav-crd-toggle-${props.group}`}
        onToggle={() => setOpen(!open)}
      />
      {/* A closed row keeps its panel for aria-controls and mounts nothing in it. */}
      <ul
        id={panel}
        data-testid={panel}
        className={`${styles.tree} ${styles.subTree}`}
        hidden={!open}
      >
        {open ? (
          <KindLinks clusterId={props.clusterId} items={props.items} />
        ) : null}
      </ul>
    </li>
  );
}

/** A domain with several API groups: its own kinds first, then its level-2 rows. */
function DomainRow(props: {
  clusterId: string;
  row: CrdDomainRow;
  activeGroup: string | null;
}) {
  const { clusterId, row, activeGroup } = props;
  const active =
    activeGroup !== null &&
    (row.items.some((i) => i.group === activeGroup) ||
      row.groups.some((g) => g.group === activeGroup));
  const [open, setOpen] = useRowOpen(
    rowKey(clusterId, "domain", row.domain),
    active,
  );
  const panel = `nav-crd-domain-panel-${row.domain}`;
  return (
    <li className={styles.leaf} data-testid={`nav-crd-domain-${row.domain}`}>
      <RowToggle
        open={open}
        active={active}
        panel={panel}
        title={row.title}
        label={row.label}
        count={row.count}
        testId={`nav-crd-domain-toggle-${row.domain}`}
        onToggle={() => setOpen(!open)}
      />
      <ul
        id={panel}
        data-testid={panel}
        className={`${styles.tree} ${styles.subTree}`}
        hidden={!open}
      >
        {open ? (
          <>
            <KindLinks clusterId={clusterId} items={row.items} />
            {row.groups.map((g) => (
              <GroupRow
                key={g.group}
                clusterId={clusterId}
                group={g.group}
                label={g.label}
                title={g.group}
                items={g.items}
                storageKey={rowKey(clusterId, "group", g.group)}
                activeGroup={activeGroup}
              />
            ))}
          </>
        ) : null}
      </ul>
    </li>
  );
}

/** One level-1 row of the tree. A "group" row uses its domain's key (spec H7). */
function CrdRow(props: {
  clusterId: string;
  row: CrdDomainRow;
  activeGroup: string | null;
}) {
  const { clusterId, row, activeGroup } = props;
  if (row.type === "domain") {
    return (
      <DomainRow clusterId={clusterId} row={row} activeGroup={activeGroup} />
    );
  }
  return (
    <GroupRow
      clusterId={clusterId}
      group={row.label}
      label={row.label}
      title={row.title}
      items={row.items}
      storageKey={rowKey(clusterId, "domain", row.domain)}
      activeGroup={activeGroup}
    />
  );
}

/** A section's sub-branch, such as Argo's "Argo CD": open by default, kept per cluster. */
function BranchRow(props: { clusterId: string; branch: NavBranch }) {
  const { clusterId, branch } = props;
  const { pathname } = useLocation();
  const active = branch.items.some((i) =>
    isAt(pathname, itemPath(clusterId, i)),
  );
  const [open, setOpen] = useRowOpen(
    `cluster.${clusterId}.nav.${branch.id}`,
    active,
  );
  const panel = `nav-branch-panel-${branch.id}`;
  return (
    <li className={styles.leaf} data-testid={`nav-branch-${branch.id}`}>
      <RowToggle
        open={open}
        active={active}
        panel={panel}
        title={branch.label}
        label={branch.label}
        count={branch.items.length}
        testId={`nav-branch-toggle-${branch.id}`}
        onToggle={() => setOpen(!open)}
      />
      <ul
        id={panel}
        data-testid={panel}
        className={`${styles.tree} ${styles.subTree}`}
        hidden={!open}
      >
        {open ? <KindLinks clusterId={clusterId} items={branch.items} /> : null}
      </ul>
    </li>
  );
}

/** An expandable section: its row, then its items on tree lines. */
function Section(props: {
  clusterId: string;
  section: NavSection;
  active: boolean;
  children: ReactNode;
}) {
  const { clusterId, section, active } = props;
  const [open, setOpen] = useRowOpen(
    `cluster.${clusterId}.nav.${section.id}`,
    active,
  );
  const panel = `nav-panel-${section.id}`;
  return (
    <section
      data-testid={`nav-section-${section.id}`}
      className={styles.section}
    >
      <button
        type="button"
        className={styles.row}
        data-active={active ? "true" : undefined}
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
      >
        <SectionIcon icon={section.icon} size={16} className={styles.rowIcon} />
        <span className={styles.text}>{section.label}</span>
        <span aria-hidden="true" className={styles.rowChevron}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      <ul id={panel} className={styles.tree} hidden={!open}>
        {props.children}
      </ul>
    </section>
  );
}

/** A section with one screen (Namespaces, Events): a direct link to it. */
function DirectSection(props: { clusterId: string; section: NavSection }) {
  const { clusterId, section } = props;
  const item = section.items[0];
  if (item === undefined) return null;
  return (
    <div className={styles.section} data-testid={`nav-section-${section.id}`}>
      <DirectLink
        to={itemPath(clusterId, item)}
        label={section.label}
        icon={section.icon}
        testId={itemTestId(item)}
      />
    </div>
  );
}

function SectionItems(props: {
  clusterId: string;
  section: NavSection;
  crds: CrdDomainRow[];
  activeGroup: string | null;
}) {
  const { clusterId, section, crds, activeGroup } = props;
  return (
    <>
      {section.overview === undefined ? null : (
        <Pill
          end
          to={clusterPath(clusterId, section.overview)}
          label="Overview"
          testId={`nav-overview-${section.overview}`}
        />
      )}
      {looseItems(section).map((i) => (
        <Pill
          key={navItemKey(i)}
          to={itemPath(clusterId, i)}
          label={navLabel(i)}
          testId={itemTestId(i)}
        />
      ))}
      {(section.branches ?? []).map((b) => (
        <BranchRow key={b.id} clusterId={clusterId} branch={b} />
      ))}
      {section.id === "custom"
        ? crds.map((row) => (
            <CrdRow
              key={row.domain}
              clusterId={clusterId}
              row={row}
              activeGroup={activeGroup}
            />
          ))
        : null}
    </>
  );
}

/**
 * The cluster navigation (spec Q §2): Overview and Resource map, then the Apps, Cluster
 * and Resources groups with the sections the user can see.
 */
export function Sidebar(props: {
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
  const activeGroup = useMemo(
    () => activeCrdGroup(crds, clusterId, pathname),
    [crds, clusterId, pathname],
  );
  const openPaths = useOpenPaths();
  // Scrolled away from the top: a hairline under the switcher marks where the rows go.
  const [scrolled, setScrolled] = useState(false);

  let body: ReactNode;
  if (props.loading && resources.length === 0) {
    body = (
      <div className={styles.state}>
        <Spinner label="Loading resources" />
      </div>
    );
  } else {
    body = groups.map(({ group, sections }) => (
      <div
        key={group.id}
        className={styles.group}
        data-testid={`nav-group-${group.id}`}
      >
        <p className={styles.groupLabel}>{group.label}</p>
        {sections.map((s) =>
          s.direct ? (
            <DirectSection key={s.id} clusterId={clusterId} section={s} />
          ) : (
            <Section
              key={s.id}
              clusterId={clusterId}
              section={s}
              active={sectionActive(pathname, clusterId, s, crds)}
            >
              <SectionItems
                clusterId={clusterId}
                section={s}
                crds={crds}
                activeGroup={activeGroup}
              />
            </Section>
          ),
        )}
      </div>
    ));
  }

  return (
    <OpenPaths.Provider value={openPaths}>
      <nav
        className={styles.sidebar}
        aria-label="Cluster navigation"
        data-testid="cluster-sidebar"
        data-scrolled={scrolled ? "true" : undefined}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <div className={styles.group} data-testid="nav-group-top">
          {NAV_SCREENS.map((s) => (
            <DirectLink
              key={s.id}
              end={s.id === "overview"}
              to={clusterPath(clusterId, s.path)}
              label={s.label}
              icon={s.icon}
              testId={screenTestId(s)}
            />
          ))}
        </div>
        {/* A failed refresh keeps the last resources, so the error sits above them. */}
        {props.error !== null ? (
          <div className={styles.state}>
            <ErrorNotice
              title="Could not load resources"
              message={props.error}
              onRetry={props.onRetry}
            />
          </div>
        ) : null}
        {body}
      </nav>
    </OpenPaths.Provider>
  );
}
