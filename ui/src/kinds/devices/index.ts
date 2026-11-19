import { baseColumns, statusColumn, textColumn } from "../columns";
import { registerKind } from "../registry";
import {
  DeviceClassDetail,
  ResourceClaimDetail,
  ResourceClaimTemplateDetail,
  ResourceSliceDetail,
} from "./DeviceDetails";
import {
  claimState,
  classSelectors,
  requestClasses,
  sliceDevices,
  sliceNode,
} from "./devices";

/** Dynamic Resource Allocation (resource.k8s.io): Device Resources in the sidebar. */
const GROUP = "resource.k8s.io";

registerKind(GROUP, "resourceclaims", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("classes", "Device classes", (o) => requestClasses(o.spec)),
      statusColumn(claimState, { header: "State" }),
    ),
  detail: ResourceClaimDetail,
});

registerKind(GROUP, "resourceclaimtemplates", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("classes", "Device classes", (o) =>
        requestClasses(o.spec?.spec),
      ),
    ),
  detail: ResourceClaimTemplateDetail,
});

registerKind(GROUP, "deviceclasses", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("selectors", "Selectors", (o) =>
        String(classSelectors(o).length),
      ),
    ),
  detail: DeviceClassDetail,
});

registerKind(GROUP, "resourceslices", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("node", "Node", (o) => sliceNode(o) || undefined),
      textColumn("driver", "Driver", (o) => o.spec?.driver),
      textColumn("pool", "Pool", (o) => o.spec?.pool?.name),
      textColumn("devices", "Devices", (o) => String(sliceDevices(o).length), {
        width: 90,
      }),
    ),
  detail: ResourceSliceDetail,
});
