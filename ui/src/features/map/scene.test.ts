import { describe, expect, it } from "vitest";
import { ARGO, DEMO, POLICY, policyArgoGraph } from "../../test/graph";
import { buildModel } from "./model";
import { type ArrangeOptions, arrange, buildScene } from "./scene";

describe("buildScene", () => {
  it("draws manages like owns, project like a use, and a policy's selects as traffic", () => {
    const { nodes, edges } = policyArgoGraph();
    const model = buildModel(nodes, edges);
    const ids = model.nodes.map((n) => n.id);
    const o: ArrangeOptions = {
      layout: "layered",
      page: "cluster",
      flow: "h",
      focusId: "",
    };
    const scene = buildScene(model, ids, o, arrange(model, ids, o));
    const style = (from: string, rel: string, to: string) =>
      scene.edges.find((e) => e.key === `${from}>${rel}>${to}`)?.style;
    expect(style(ARGO.app, "manages", DEMO.deployment)).toBe("own");
    expect(style(ARGO.appSet, "owns", ARGO.app)).toBe("own");
    expect(style(ARGO.app, "project", ARGO.project)).toBe("use");
    expect(style(POLICY.netpol, "selects", DEMO.podA)).toBe("net");
  });
});
