import type { ReactNode } from "react";
import { Badge } from "../../design";
import { Chips, Facts, ObjectLink, Part, SimpleTable } from "../detail/parts";
import type { DetailProps } from "../registry";
import {
  allocatedDevices,
  claimState,
  classSelectors,
  deviceRequests,
  reservedFor,
  sliceDevices,
  sliceNode,
} from "./devices";

/** The requests table of a claim, or of the claim a template makes. */
function Requests(props: DetailProps & { spec: unknown }) {
  const { clusterId, object, resources } = props;
  const rows = deviceRequests(props.spec).map((r) => [
    r.name,
    r.classes.length === 0
      ? "-"
      : r.classes.map((c, i) => (
          <span key={c}>
            {i > 0 ? ", " : null}
            <ObjectLink
              clusterId={clusterId}
              resources={resources}
              kind="DeviceClass"
              name={c}
              apiVersion={object.apiVersion}
            />
          </span>
        )),
    r.mode,
    r.selectors.length === 0 ? (
      "-"
    ) : (
      <Chips key="selectors" values={r.selectors} />
    ),
  ]);
  return (
    <Part title="Requests">
      <SimpleTable
        testId="device-requests"
        headers={["Name", "Device class", "Count", "Selectors"]}
        rows={rows}
        empty="No device requests."
      />
    </Part>
  );
}

export function ResourceClaimDetail(props: DetailProps) {
  const { clusterId, object, resources } = props;
  const state = claimState(object);
  const holders: ReactNode[] = reservedFor(object).map((c) =>
    c.resource === "pods" && c.group === "" ? (
      <ObjectLink
        key={`${c.resource}/${c.name}`}
        clusterId={clusterId}
        resources={resources}
        kind="Pod"
        name={c.name}
        namespace={object.metadata.namespace}
        apiVersion="v1"
      />
    ) : (
      <span key={`${c.resource}/${c.name}`}>{`${c.resource}/${c.name}`}</span>
    ),
  );
  const reserved =
    holders.length === 0 ? undefined : (
      <span data-testid="claim-reserved-for">
        {holders.map((h, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the list keeps its order
          <span key={i}>
            {i > 0 ? ", " : null}
            {h}
          </span>
        ))}
      </span>
    );
  const devices = allocatedDevices(object).map((d) => [
    d.request,
    d.driver,
    d.pool,
    d.device,
  ]);
  return (
    <>
      <Part title="Claim">
        <Facts
          items={[
            [
              "State",
              <Badge key="state" tone={state.tone}>
                {state.label}
              </Badge>,
            ],
            ["Reserved for", reserved],
          ]}
        />
      </Part>
      <Requests {...props} spec={object.spec} />
      <Part title="Allocated devices">
        <SimpleTable
          testId="claim-devices"
          headers={["Request", "Driver", "Pool", "Device"]}
          rows={devices}
          empty="No devices allocated yet."
        />
      </Part>
    </>
  );
}

export function ResourceClaimTemplateDetail(props: DetailProps) {
  return <Requests {...props} spec={props.object.spec?.spec} />;
}

export function DeviceClassDetail({ object }: DetailProps) {
  const selectors = classSelectors(object);
  const selectorChips =
    selectors.length === 0 ? "None" : <Chips values={selectors} />;
  const config = Array.isArray(object.spec?.config)
    ? object.spec.config.length
    : 0;
  return (
    <Part title="Device class">
      <Facts
        items={[
          ["Selectors", selectorChips],
          ["Configuration", config === 0 ? undefined : String(config)],
          ["Extended resource", object.spec?.extendedResourceName],
        ]}
      />
    </Part>
  );
}

export function ResourceSliceDetail({
  clusterId,
  object,
  resources,
}: DetailProps) {
  const spec = object.spec ?? {};
  const node = typeof spec.nodeName === "string" ? spec.nodeName : "";
  const nodeCell =
    node !== "" ? (
      <ObjectLink
        clusterId={clusterId}
        resources={resources}
        kind="Node"
        name={node}
        apiVersion="v1"
      />
    ) : (
      sliceNode(object) || undefined
    );
  const rows = sliceDevices(object).map((d) => [
    d.name,
    d.attributes.length === 0 ? (
      "-"
    ) : (
      <Chips key="attributes" values={d.attributes} />
    ),
    d.capacity.length === 0 ? (
      "-"
    ) : (
      <Chips key="capacity" values={d.capacity} />
    ),
  ]);
  return (
    <>
      <Part title="Resource slice">
        <Facts
          items={[
            ["Driver", spec.driver],
            ["Node", nodeCell],
            ["Pool", spec.pool?.name],
            [
              "Pool generation",
              spec.pool?.generation === undefined
                ? undefined
                : String(spec.pool.generation),
            ],
            [
              "Slices in pool",
              spec.pool?.resourceSliceCount === undefined
                ? undefined
                : String(spec.pool.resourceSliceCount),
            ],
          ]}
        />
      </Part>
      <Part title="Devices">
        <SimpleTable
          testId="slice-devices"
          headers={["Name", "Attributes", "Capacity"]}
          rows={rows}
          empty="No devices."
        />
      </Part>
    </>
  );
}
