import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useRef,
} from "react";
import { useSearchParams } from "react-router";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { PODS } from "../../kinds/refs";
import { findResource } from "../../stores/resources";
import { DetailDrawer, isDrawerEscape } from "../details/DetailDrawer";
import { useDrawerHistory } from "../details/useDrawerHistory";
import { DrawerObjectActions } from "../resources/DrawerObjectActions";
import { openKeyOf } from "./text";

/** What an overview page needs of its drawer. */
export interface OverviewDrawer {
  /** Opens `key` (`<namespace>/<name>`, or `/<name>`) of `ref`, one of the page's kinds. */
  open(ref: ResourceRef, key: string): void;
  close(): void;
  /** The page root's handler: an Escape from the drawer closes it. */
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  /** The drawer, to render after the grid. */
  drawer: ReactElement;
}

/**
 * The drawer of one kind with its back history. The hook keys it by its kind, so another
 * kind under the same object key starts a history of its own.
 */
function KindDrawer(props: {
  clusterId: string;
  resources: ApiResourceInfo[];
  resource: ResourceRef;
  objectKey: string | null;
  onClose(): void;
}) {
  const { clusterId, resources, resource } = props;
  const history = useDrawerHistory(resource, props.objectKey);
  const info = findResource(resources, resource.group, resource.plural);
  return (
    <DetailDrawer
      clusterId={clusterId}
      resource={resource}
      history={history}
      onClose={props.onClose}
      resources={resources}
      actions={
        info === undefined
          ? undefined
          : (object) => (
              <DrawerObjectActions
                clusterId={clusterId}
                info={info}
                object={object}
              />
            )
      }
    />
  );
}

/**
 * The drawer of an overview page (R4), as the cluster Overview wires it: `?open=` holds the
 * kind's `openKeyOf` and `?object=` the object's key (R3), each open is a history entry, and
 * Escape from the drawer closes it. `openable` lists the kinds the page may open; any other
 * `?open=` opens nothing.
 */
export function useOverviewDrawer(
  clusterId: string,
  resources: ApiResourceInfo[],
  openable: readonly ResourceRef[],
): OverviewDrawer {
  const [params, setParams] = useSearchParams();
  const openParam = params.get("open");
  const opened =
    openParam === null
      ? undefined
      : openable.find((r) => openKeyOf(r) === openParam);
  const resource = opened ?? openable[0] ?? PODS;
  const objectKey = opened === undefined ? null : params.get("object");
  // `setParams` changes with the location; the callbacks read it here, so they stay the same.
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const show = useCallback((openKey: string | null, key: string | null) => {
    setParamsRef.current(
      (p) => {
        const next = new URLSearchParams(p);
        if (openKey === null || key === null) {
          next.delete("open");
          next.delete("object");
        } else {
          next.set("open", openKey);
          next.set("object", key);
        }
        return next;
      },
      { replace: false },
    );
  }, []);
  const open = useCallback(
    (ref: ResourceRef, key: string) => show(openKeyOf(ref), key),
    [show],
  );
  const close = useCallback(() => show(null, null), [show]);
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (!isDrawerEscape(e)) return;
      e.stopPropagation();
      close();
    },
    [close],
  );
  return {
    open,
    close,
    onKeyDown,
    drawer: (
      <KindDrawer
        key={openKeyOf(resource)}
        clusterId={clusterId}
        resources={resources}
        resource={resource}
        objectKey={objectKey}
        onClose={close}
      />
    ),
  };
}
