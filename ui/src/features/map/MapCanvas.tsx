import {
  memo,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconButton } from "../../design/IconButton";
import { Info, Scan, ZoomIn, ZoomOut } from "../../design/icons";
import type { GraphStatus } from "../../ipc/generated/GraphStatus";
import { KindIcon } from "./icons/KindIcon";
import type { Flow, Positions } from "./layout/grouped";
import styles from "./MapCanvas.module.css";
import { levelSort, type MapModel, nodeOf, statusLine } from "./model";
import {
  arrange,
  buildScene,
  FIT_PAD,
  type LayoutName,
  type SceneBox,
  type SceneEdge,
  type SceneIcon,
  viaMark,
} from "./scene";

/** Positions moved by hand, per cluster, page and layout, for the session (spec E §8.2). */
const MOVED = new Map<string, Positions>();

export function resetMovedForTest(): void {
  MOVED.clear();
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const STEP = 1.25;
/** A pointer that moves less than this is a click, not a drag. */
const DRAG_SLOP = 3;

const clampZoom = (k: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k));

interface View {
  k: number;
  tx: number;
  ty: number;
}

export interface MapCanvasProps {
  model: MapModel;
  /** The ids to draw. */
  ids: readonly string[];
  layout: LayoutName;
  page: "cluster" | "object";
  flow?: Flow;
  focusId?: string;
  /** Where moved positions are kept: cluster, page and layout. */
  memoryKey: string;
  search?: string;
  selected: string | null;
  onSelect(id: string | null): void;
  /** Changing it forgets the moved positions and fits the view ("Reset layout"). */
  resetSignal?: number;
  /** Each new `n` centres the view on `id` at the current zoom (spec E §12.2). */
  centre?: { id: string; n: number };
  /**
   * The drawer tab's canvas (spec E §11): fitted to the width at most 100%, as tall
   * as the drawing so the drawer scrolls, with no zoom, no legend and no dragging.
   */
  compact?: boolean;
  /** Pointed at the `map-canvas` element, for the page's Export (spec O §6.2). */
  canvasRef?: RefObject<HTMLDivElement | null>;
}

const LEGEND_STATUS = [
  ["nominal", "Healthy"],
  ["warning", "Pending or degraded"],
  ["critical", "Failing"],
  ["neutral", "Config or completed"],
] as const;

const LEGEND_EDGES = [
  ["box", "Box holds what it owns"],
  ["outside", "Outside the cluster (load balancers)"],
  ["own", "Owns"],
  ["net", "Routes traffic: LB, Gateway, Route, Ingress, Service"],
  ["use", "Mounts or uses (config, GatewayClass)"],
  ["access", "Grants access: binding to ServiceAccount and role"],
] as const;

/** The icon in the head of a box that is not an owner (spec E §8.1, O §5.2). */
const BOX_ICON: Readonly<Record<string, string>> = {
  Namespace: "Namespace",
  External: "LoadBalancer",
  Access: "ClusterRole",
};

/** A name cut to the label's width; the full name is in the tooltip. */
function shortName(name: string): string {
  return name.length > 30 ? `${name.slice(0, 29)}…` : name;
}

/**
 * What the layout and the scene are made of: the drawn ids and the edges. A snapshot
 * that changes only statuses or facts has the same shape, and keeps the drawing.
 */
function shapeOf(model: MapModel, ids: readonly string[]): string {
  const edges = model.edges.map(
    (e) => `${e.from}>${e.rel}>${e.to}>${e.via?.join(",") ?? ""}`,
  );
  return `${ids.join("\n")}\n\n${edges.join("\n")}`;
}

/** True when the edge has the selected node at an end, or stands for it. */
function touches(e: SceneEdge, selected: string | null): boolean {
  return (
    selected !== null &&
    (e.from === selected || e.to === selected || e.ids.includes(selected))
  );
}

const classes = (...names: (string | false | undefined)[]) =>
  names.filter(Boolean).join(" ");

/**
 * The drawing's parts each redraw only when what they show changes: a pan or zoom
 * redraws none of them, and a selection only the parts it changes.
 */
const MapHull = memo(function MapHull({ namespace, rect }: SceneHullProps) {
  return (
    <g
      data-testid="map-namespace"
      data-namespace={namespace}
      data-hull={namespace}
      className={styles.hull}
    >
      <rect
        x={rect.x0}
        y={rect.y0}
        width={rect.x1 - rect.x0}
        height={rect.y1 - rect.y0}
      />
      <text x={rect.x0 + 12} y={rect.y0 + 20} className={styles.hullLabel}>
        {namespace}
      </text>
    </g>
  );
});

type SceneHullProps = { namespace: string; rect: SceneBox["rect"] };

const MapBox = memo(function MapBox(props: {
  box: SceneBox;
  status: GraphStatus | undefined;
  focus: boolean;
  selected: boolean;
  dim: boolean;
}) {
  const { box: b, status } = props;
  const r = b.rect;
  const node = b.node;
  const nodeProps = node
    ? {
        "data-testid": "map-node",
        "data-id": node.id,
        "data-kind": node.kind,
        "data-status": status,
        "aria-selected": props.selected,
      }
    : b.kind === "Namespace"
      ? { "data-testid": "map-namespace", "data-namespace": b.namespace }
      : b.kind === "Access"
        ? { "data-testid": "map-access" }
        : {};
  return (
    <g
      className={classes(
        styles.box,
        styles[`box${b.kind}`] ?? styles.boxOwner,
        props.focus && styles.focus,
        props.selected && styles.selected,
        props.dim && styles.dim,
      )}
      data-box={b.key}
      {...nodeProps}
    >
      <rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} />
      <KindIcon
        kind={node ? node.kind : BOX_ICON[b.kind]}
        size={28}
        x={r.x0 + 10}
        y={r.y0 + 9}
      />
      <text x={r.x0 + 46} y={r.y0 + 22} className={styles.boxTitle}>
        {b.title}
      </text>
      <text x={r.x0 + 46} y={r.y0 + 38} className={styles.boxSub}>
        {b.sub}
      </text>
    </g>
  );
});

const MapEdgeLine = memo(function MapEdgeLine(props: {
  edge: SceneEdge;
  dim: boolean;
}) {
  const e = props.edge;
  return (
    <g
      data-testid="map-edge"
      data-from={e.from}
      data-rel={e.rel}
      data-to={e.to}
      data-via={e.via?.join(",")}
      className={classes(styles.edge, styles[e.style], props.dim && styles.dim)}
    >
      <path d={e.d} className={styles.line} />
      {e.head ? <path d={e.head} className={styles.head} /> : null}
      {e.via ? (
        // A wide invisible stroke, so the hidden kinds show on hover.
        <path d={e.d} className={styles.hit}>
          <title>{`via ${e.via.join(", ")}`}</title>
        </path>
      ) : null}
    </g>
  );
});

/** The marks on bridges, which keep their size on screen as the view zooms. */
function ViaMarks(props: {
  edges: readonly SceneEdge[];
  k: number;
  dim(e: SceneEdge): boolean;
}) {
  const { r, width } = viaMark(props.k);
  return (
    <g>
      {props.edges.map((e) =>
        e.via && e.mid ? (
          <circle
            key={e.key}
            data-testid="map-via-mark"
            data-from={e.from}
            data-to={e.to}
            cx={e.mid.x}
            cy={e.mid.y}
            r={r}
            strokeWidth={width}
            className={classes(styles.viaMark, props.dim(e) && styles.dim)}
          />
        ) : null,
      )}
    </g>
  );
}

const MapIcon = memo(function MapIcon(props: {
  icon: SceneIcon;
  status: GraphStatus;
  selected: boolean;
  dim: boolean;
}) {
  const { icon: s, status } = props;
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: spec E §8.4 marks the selected node; the drawing is hidden from assistive technology and the live region announces the selection.
    <g
      data-testid="map-node"
      data-id={s.id}
      data-kind={s.node.kind}
      data-status={status}
      aria-selected={props.selected}
      className={classes(
        styles.node,
        props.selected && styles.selected,
        props.dim && styles.dim,
      )}
      transform={`translate(${s.x} ${s.y})`}
    >
      <title>{s.node.name}</title>
      <circle r={s.size / 2 + 4} className={styles[status]} />
      <KindIcon
        kind={s.node.kind}
        size={s.size}
        x={-s.size / 2}
        y={-s.size / 2}
      />
      <text y={s.size / 2 + 18} className={styles.label}>
        {shortName(s.node.name)}
      </text>
    </g>
  );
});

function matches(search: string, name: string, kind: string): boolean {
  const q = search.trim().toLowerCase();
  return (
    q === "" || name.toLowerCase().includes(q) || kind.toLowerCase().includes(q)
  );
}

type Drag =
  | { type: "pan"; x: number; y: number; view: View; moved: boolean }
  | {
      type: "move";
      x: number;
      y: number;
      ids: string[];
      start: Positions;
      moved: boolean;
    };

/**
 * One laid-out graph in an SVG (spec E §8): pan, zoom, drag, keyboard, legend and
 * a live region for the selection.
 */
export function MapCanvas({
  model,
  ids,
  layout,
  page,
  flow = "h",
  focusId = "",
  memoryKey,
  search = "",
  selected,
  onSelect,
  resetSignal = 0,
  centre,
  compact = false,
  canvasRef,
}: MapCanvasProps) {
  const options = useMemo(
    () => ({ layout, page, flow, focusId }),
    [layout, page, flow, focusId],
  );
  // The layout and the scene follow the shape alone, built from the newest model and ids.
  const shape = useMemo(() => shapeOf(model, ids), [model, ids]);
  const latest = useRef({ model, ids });
  latest.current = { model, ids };
  const lastBase = useRef<{
    options: typeof options;
    key: string;
    base: Positions;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new shape is what lays the drawing out again; the model and ids are read from `latest`.
  const base = useMemo(() => {
    // Force starts from the last drawing of the same view; any other options start cold.
    const prev =
      lastBase.current?.options === options &&
      lastBase.current.key === memoryKey
        ? lastBase.current.base
        : undefined;
    const out = arrange(
      latest.current.model,
      latest.current.ids,
      options,
      prev,
    );
    lastBase.current = { options, key: memoryKey, base: out };
    return out;
  }, [shape, options, memoryKey]);
  const [, setVersion] = useState(0);
  const moved = MOVED.get(memoryKey);
  const pos = useMemo<Positions>(() => {
    const out: Positions = { ...base };
    for (const [k, p] of Object.entries(moved ?? {})) if (k in out) out[k] = p;
    return out;
  }, [base, moved]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: as for `base`: the shape, not each snapshot, rebuilds the scene.
  const scene = useMemo(
    () => buildScene(latest.current.model, latest.current.ids, options, pos),
    [shape, options, pos],
  );

  const root = useRef<HTMLDivElement>(null);
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      if (canvasRef) canvasRef.current = el;
    },
    [canvasRef],
  );
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const userMoved = useRef(false);
  const drag = useRef<Drag | null>(null);
  const clickBlocked = useRef(false);
  const [legend, setLegend] = useState(false);

  const extent = scene.extent;
  const fitView = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const ew = Math.max(extent.x1 - extent.x0, 1);
    const eh = Math.max(extent.y1 - extent.y0, 1);
    if (compact) {
      if (!w) return;
      const k = clampZoom(Math.min((w - 2 * FIT_PAD) / ew, 1));
      setView({
        k,
        tx: (w - ew * k) / 2 - extent.x0 * k,
        ty: FIT_PAD - extent.y0 * k,
      });
      return;
    }
    if (!w || !h) return;
    const k = clampZoom(
      Math.min((w - 2 * FIT_PAD) / ew, (h - 2 * FIT_PAD) / eh, 1),
    );
    setView({
      k,
      tx: (w - ew * k) / 2 - extent.x0 * k,
      ty: (h - eh * k) / 2 - extent.y0 * k,
    });
  }, [extent.x0, extent.y0, extent.x1, extent.y1, compact]);

  // A new memoryKey (cluster, page, focus or layout) is a new drawing: forget the
  // old pan and zoom. Declared before the fit effect so it runs first.
  const lastKey = useRef(memoryKey);
  useLayoutEffect(() => {
    if (lastKey.current === memoryKey) return;
    lastKey.current = memoryKey;
    userMoved.current = false;
  }, [memoryKey]);

  // Fit on load and whenever the drawing changes, until the user pans or zooms.
  // biome-ignore lint/correctness/useExhaustiveDependencies: memoryKey re-fits a new drawing with an identical extent
  useLayoutEffect(() => {
    if (!userMoved.current) fitView();
  }, [fitView, memoryKey]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!userMoved.current) fitView();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitView]);

  const firstReset = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === firstReset.current) return;
    firstReset.current = resetSignal;
    MOVED.delete(memoryKey);
    userMoved.current = false;
    setVersion((v) => v + 1);
  }, [resetSignal, memoryKey]);

  const centres = scene.centres;
  const centresRef = useRef(centres);
  centresRef.current = centres;
  const centreN = centre?.n ?? 0;
  const centreId = centre?.id;
  useEffect(() => {
    const el = root.current;
    const p = centreId === undefined ? undefined : centresRef.current[centreId];
    if (centreN === 0 || !el || !p) return;
    userMoved.current = true;
    setView((v) => ({
      k: v.k,
      tx: el.clientWidth / 2 - p.x * v.k,
      ty: el.clientHeight / 2 - p.y * v.k,
    }));
  }, [centreN, centreId]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    userMoved.current = true;
    setView((v) => {
      const k = clampZoom(v.k * factor);
      const wx = (cx - v.tx) / v.k;
      const wy = (cy - v.ty) / v.k;
      return { k, tx: cx - wx * k, ty: cy - wy * k };
    });
  }, []);
  const zoomCentre = useCallback(
    (factor: number) => {
      const el = root.current;
      zoomAt(factor, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2);
    },
    [zoomAt],
  );

  // React's wheel listener is passive, so the zoom needs its own to stop the page scroll.
  useEffect(() => {
    const el = root.current;
    if (!el || compact) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      zoomAt(
        Math.exp(-e.deltaY * 0.0015),
        e.clientX - box.left,
        e.clientY - box.top,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, compact]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const posRef = useRef(pos);
  posRef.current = pos;

  const startDrag = useCallback(
    (e: ReactPointerEvent, next: Drag) => {
      e.stopPropagation();
      drag.current = next;
      clickBlocked.current = false;
      // One drawing per frame: the moves between frames only leave their last point.
      let frame = 0;
      let pending: PointerEvent | null = null;
      const flush = () => {
        frame = 0;
        const ev = pending;
        pending = null;
        if (ev) apply(ev);
      };
      const onMove = (ev: PointerEvent) => {
        pending = ev;
        if (frame === 0) frame = requestAnimationFrame(flush);
      };
      const apply = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        const dx = ev.clientX - d.x;
        const dy = ev.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
        d.moved = true;
        if (d.type === "pan") {
          userMoved.current = true;
          setView({ ...d.view, tx: d.view.tx + dx, ty: d.view.ty + dy });
          return;
        }
        // A moved node changes the drawing's extent, so the view must not refit under it.
        userMoved.current = true;
        const k = viewRef.current.k;
        const next: Positions = { ...(MOVED.get(memoryKey) ?? {}) };
        for (const id of d.ids) {
          next[id] = { x: d.start[id].x + dx / k, y: d.start[id].y + dy / k };
        }
        MOVED.set(memoryKey, next);
        setVersion((v) => v + 1);
      };
      const onUp = () => {
        if (frame !== 0) {
          cancelAnimationFrame(frame);
          flush();
        }
        clickBlocked.current = drag.current?.moved ?? false;
        drag.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [memoryKey],
  );

  const startMove = (e: ReactPointerEvent, moving: string[]) => {
    if (e.button !== 0) return;
    const start: Positions = {};
    for (const id of moving)
      if (posRef.current[id]) start[id] = posRef.current[id];
    startDrag(e, {
      type: "move",
      x: e.clientX,
      y: e.clientY,
      ids: Object.keys(start),
      start,
      moved: false,
    });
  };

  /** A box moves with everything in it: its leaves and the boxes under it. */
  const boxContents = (key: string): string[] => {
    const tree = scene.tree;
    if (!tree) return [key];
    const out = [key];
    const visit = (k: string) => {
      for (const c of tree.groups[k]?.kids ?? []) {
        out.push(c);
        visit(c);
      }
    };
    visit(key);
    return out;
  };

  const pick = (id: string) => {
    if (clickBlocked.current) {
      clickBlocked.current = false;
      return;
    }
    onSelect(id);
  };

  const moveSelection = (dir: "up" | "down" | "left" | "right") => {
    if (selected === null || !centres[selected]) {
      const first = levelSort(model, ids)[0];
      if (first !== undefined) onSelect(first);
      return;
    }
    const from = centres[selected];
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [id, p] of Object.entries(centres)) {
      if (id === selected) continue;
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      const main =
        dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
      const side =
        dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
      if (main <= 1) continue;
      const score = main + 2 * side;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (best !== null) onSelect(best);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const arrows: Record<string, "up" | "down" | "left" | "right"> = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (arrows[e.key]) {
      e.preventDefault();
      moveSelection(arrows[e.key]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onSelect(null);
    } else if (compact) {
      return;
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomCentre(STEP);
    } else if (e.key === "-") {
      e.preventDefault();
      zoomCentre(1 / STEP);
    } else if (e.key === "0") {
      e.preventDefault();
      userMoved.current = false;
      fitView();
    }
  };

  const searching = search.trim() !== "";
  const lit = useCallback(
    (id: string) => {
      const node = model.byId.get(id);
      return node ? matches(search, node.name, node.kind) : false;
    },
    [model, search],
  );
  const dimEdge = useCallback(
    (e: SceneEdge) => searching && !lit(e.from) && !lit(e.to),
    [searching, lit],
  );
  // Under Force, edges between namespaces are drawn only for the selected node.
  const edges = useMemo(
    () =>
      scene.edges.filter(
        (e) => layout !== "force" || !e.across || touches(e, selected),
      ),
    [scene.edges, layout, selected],
  );
  const hot = useMemo(
    () => edges.filter((e) => touches(e, selected)),
    [edges, selected],
  );
  const selectedNode = selected === null ? undefined : model.byId.get(selected);

  // What is under the bridges' marks, and what is over them. Neither depends on the view.
  const under = useMemo(
    () => (
      <>
        {scene.hulls.map((h) => (
          <MapHull key={h.namespace} namespace={h.namespace} rect={h.rect} />
        ))}
        {scene.boxes.map((b) => (
          <MapBox
            key={b.key}
            box={b}
            status={b.node ? model.byId.get(b.node.id)?.status : undefined}
            focus={b.node !== null && b.node.id === focusId}
            selected={b.node !== null && b.node.id === selected}
            dim={searching && b.node !== null && !lit(b.node.id)}
          />
        ))}
        <g>
          {edges.map((e) => (
            <MapEdgeLine key={e.key} edge={e} dim={dimEdge(e)} />
          ))}
        </g>
      </>
    ),
    [scene, model, edges, focusId, selected, searching, lit, dimEdge],
  );
  const over = useMemo(
    () => (
      <>
        {scene.icons.map((s) => (
          <MapIcon
            key={s.id}
            icon={s}
            status={model.byId.get(s.id)?.status ?? s.node.status}
            selected={s.id === selected}
            dim={searching && !lit(s.id)}
          />
        ))}
        <g className={styles.hot}>
          {hot.map((e) => (
            <path
              key={e.key}
              d={`${e.d}${e.head}`}
              className={e.via ? styles.hotBridge : undefined}
            />
          ))}
        </g>
      </>
    ),
    [scene, model, hot, selected, searching, lit],
  );

  // Nodes, boxes and areas are found from the event's target, so the drawing itself
  // holds no handlers.
  const hit = (target: EventTarget | null, selector: string) =>
    target instanceof Element ? target.closest(selector) : null;
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || compact) return;
    const el = hit(e.target, "[data-id], [data-box], [data-hull]");
    const hull = el?.getAttribute("data-hull");
    const box = el?.getAttribute("data-box");
    const id = el?.getAttribute("data-id");
    if (hull) {
      startMove(
        e,
        scene.icons.filter((s) => s.node.namespace === hull).map((s) => s.id),
      );
    } else if (box) {
      startMove(e, boxContents(box));
    } else if (id) {
      startMove(e, [id]);
    } else {
      startDrag(e, {
        type: "pan",
        x: e.clientX,
        y: e.clientY,
        view: viewRef.current,
        moved: false,
      });
    }
  };
  const onClick = (e: React.MouseEvent) => {
    const id = hit(e.target, "[data-id]")?.getAttribute("data-id");
    if (id) pick(id);
  };

  return (
    <div className={styles.frame}>
      <div
        ref={setRoot}
        className={
          compact ? `${styles.canvas} ${styles.compact}` : styles.canvas
        }
        data-testid="map-canvas"
        role="application"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas is one tab stop that reads its own keys (spec E §8.3).
        tabIndex={0}
        aria-label={
          compact
            ? "Resource map. Select a resource to see its connections."
            : "Resource map. Drag to pan, scroll to zoom, select a resource to see its connections."
        }
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onClick={onClick}
      >
        <svg
          className={compact ? styles.compactSvg : styles.svg}
          aria-hidden="true"
          // A whole-map export frames the drawing by its extent (spec O §6).
          data-extent={`${extent.x0} ${extent.y0} ${extent.x1} ${extent.y1}`}
          height={
            compact
              ? Math.ceil((extent.y1 - extent.y0) * view.k + 2 * FIT_PAD)
              : undefined
          }
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
            {under}
            <ViaMarks edges={edges} k={view.k} dim={dimEdge} />
            {over}
          </g>
        </svg>
      </div>
      {compact ? null : (
        <>
          <div className={styles.controls}>
            <IconButton
              label="Zoom in"
              icon={<ZoomIn size={16} />}
              data-testid="map-zoom-in"
              onClick={() => zoomCentre(STEP)}
            />
            <IconButton
              label="Zoom out"
              icon={<ZoomOut size={16} />}
              data-testid="map-zoom-out"
              onClick={() => zoomCentre(1 / STEP)}
            />
            <IconButton
              label="Fit to view"
              icon={<Scan size={16} />}
              data-testid="map-fit"
              onClick={() => {
                userMoved.current = false;
                fitView();
              }}
            />
            <span className={styles.zoom} data-testid="map-zoom-label">
              {`${Math.round(view.k * 100)}%`}
            </span>
            <IconButton
              label="Show or hide the legend"
              icon={<Info size={16} />}
              data-testid="map-legend-toggle"
              aria-pressed={legend}
              onClick={() => setLegend((v) => !v)}
            />
          </div>
          {legend ? (
            <section
              className={styles.legend}
              data-testid="map-legend"
              aria-label="Legend"
            >
              <h2 className={styles.legendTitle}>Legend</h2>
              <ul className={styles.legendList}>
                {LEGEND_STATUS.map(([status, text]) => (
                  <li key={status}>
                    <span
                      className={`${styles.swatch} ${styles[`dot-${status}`]}`}
                    />
                    {text}
                  </li>
                ))}
              </ul>
              <ul className={styles.legendList}>
                {LEGEND_EDGES.map(([style, text]) => (
                  <li key={style}>
                    <span
                      className={`${styles.swatch} ${styles[`key-${style}`]}`}
                    />
                    {text}
                  </li>
                ))}
                {edges.some((e) => e.via) ? (
                  <li data-testid="map-legend-bridge">
                    <span
                      className={`${styles.swatch} ${styles["key-bridge"]}`}
                    />
                    Through a hidden kind (hover for which)
                  </li>
                ) : null}
              </ul>
            </section>
          ) : null}
        </>
      )}
      <div className={styles.live} aria-live="polite" data-testid="map-live">
        {selectedNode
          ? `${selectedNode.kind} ${selectedNode.name}, ${statusLine(nodeOf(model, selectedNode.id))}`
          : ""}
      </div>
    </div>
  );
}
