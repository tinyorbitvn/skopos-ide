import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  type ResourceListState,
  useResourceList,
} from "../../stores/resources";
import { WAITING } from "../resources/useTableList";
import { listedResource } from "./counts";

/**
 * A resource's objects in the chosen namespaces, or in every namespace when none is
 * chosen. The backend is asked for the chosen ones only, and once `ready` says the
 * saved choice was read, so never for every namespace first. A new choice is a new
 * list, which loads before it is counted.
 */
export function useListIn(
  clusterId: string,
  info: ApiResourceInfo | undefined,
  namespaces: string[],
  ready: boolean,
): ResourceListState {
  const list = useResourceList(
    clusterId,
    ready ? listedResource(info) : null,
    namespaces,
  );
  return ready ? list : WAITING;
}
