import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type PointerEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { TopologyPod } from "../../ipc/generated/TopologyPod";
import {
  type ActiveSquare,
  namespaceGroups,
  podKey,
  podTip,
  resolveActive,
} from "./model";
import styles from "./Topology.module.css";

/** The index of the square an event reached, or null off the squares. */
function squareIndex(target: EventTarget): number | null {
  if (!(target instanceof Element)) return null;
  const square = target.closest<HTMLElement>("[data-index]");
  if (square === null) return null;
  const index = Number(square.dataset.index);
  return Number.isInteger(index) ? index : null;
}

/**
 * A node's pods as squares by namespace (topology spec §3.4). The grid is one tab stop: it
 * listens for every square, keeps the active one by pod (RF2) and draws one tooltip on the
 * body, so the card's `content-visibility` cannot clip it.
 */
export const PodGrid = memo(function PodGrid(props: {
  node: string;
  pods: readonly TopologyPod[];
  highlight: string | null;
  onOpen(key: string): void;
}) {
  const { node, pods, highlight, onOpen } = props;
  const base = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    let start = 0;
    return namespaceGroups(pods).map((group) => {
      const row = { group, start };
      start += group.pods.length;
      return row;
    });
  }, [pods]);
  const ordered = useMemo(() => rows.flatMap((r) => r.group.pods), [rows]);
  const keys = useMemo(() => ordered.map(podKey), [ordered]);

  const [active, setActive] = useState<ActiveSquare | null>(null);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(
    null,
  );

  // A new snapshot keeps the active pod, or the square now at its place.
  const resolved = resolveActive(active, keys);
  if (resolved !== active) setActive(resolved);

  const pointed = hovered !== null && hovered < ordered.length ? hovered : null;
  const tipIndex = pointed ?? (focused ? (resolved?.index ?? null) : null);
  const tipPod = tipIndex === null ? undefined : ordered[tipIndex];

  // The tooltip sits above its square, measured once the square is drawn.
  useLayoutEffect(() => {
    const square =
      tipIndex === null
        ? null
        : gridRef.current?.querySelector(`[data-index="${tipIndex}"]`);
    if (!square) {
      setPlace(null);
      return;
    }
    const box = square.getBoundingClientRect();
    setPlace({ left: box.left + box.width / 2, top: box.top });
  }, [tipIndex]);

  const moveTo = (index: number) => {
    const key = keys[index];
    if (key !== undefined) setActive({ key, index });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (resolved === null) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onOpen(resolved.key);
      return;
    }
    const last = keys.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = Math.min(resolved.index + 1, last);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = Math.max(resolved.index - 1, 0);
    } else if (e.key === "Home") {
      next = 0;
    } else if (e.key === "End") {
      next = last;
    }
    if (next === null) return;
    e.preventDefault();
    moveTo(next);
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    setFocused(true);
    if (resolved === null) moveTo(0);
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) setFocused(false);
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const index = squareIndex(e.target);
    const key = index === null ? undefined : keys[index];
    if (index === null || key === undefined) return;
    setActive({ key, index });
    onOpen(key);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const index = squareIndex(e.target);
    if (index !== hovered) setHovered(index);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a table cannot wrap its cells as a flow of squares. */}
      <div
        ref={gridRef}
        role="grid"
        tabIndex={0}
        aria-label={`Pods on ${node}`}
        aria-activedescendant={
          resolved === null ? undefined : `${base}-${resolved.index}`
        }
        className={styles.pods}
        data-testid={`topology-pods-${node}`}
        data-keeps-drawer=""
        onClick={onClick}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHovered(null)}
      >
        {rows.map(({ group, start }) => (
          // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a table cannot wrap its cells as a flow of squares.
          <div key={group.namespace} role="row" className={styles.podRow}>
            {group.pods.map((pod, offset) => {
              const index = start + offset;
              return (
                // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a table cannot wrap its cells as a flow of squares.
                <span
                  key={podKey(pod)}
                  id={`${base}-${index}`}
                  role="gridcell"
                  aria-label={podTip(pod)}
                  className={styles.pod}
                  data-index={index}
                  data-pod={podKey(pod)}
                  data-state={pod.state}
                  data-active={
                    focused && resolved?.index === index ? "" : undefined
                  }
                  data-faded={
                    highlight !== null && pod.namespace !== highlight
                      ? ""
                      : undefined
                  }
                />
              );
            })}
          </div>
        ))}
      </div>
      {tipPod === undefined || place === null
        ? null
        : createPortal(
            <div
              className={styles.tip}
              role="tooltip"
              data-testid="topology-pod-tip"
              style={{ left: place.left, top: place.top }}
            >
              {podTip(tipPod)}
            </div>,
            document.body,
          )}
    </>
  );
});
