import { expect, test, vi } from "vitest";
import { templateSections } from "./pickerSections";

test("one section per group, titled, with the kind and group as keywords", () => {
  const sections = templateSections([], vi.fn());
  expect(sections.map((s) => s.title)).toEqual([
    "Workloads",
    "Network",
    "Config",
    "Storage",
    "Access",
    "Cluster",
  ]);
  const nodePort = sections[1].items.find((i) => i.id === "service-nodeport");
  expect(nodePort).toMatchObject({
    label: "Service · NodePort",
    keywords: ["Service", "Network"],
    testId: "menu-item-service-nodeport",
    disabled: false,
  });
});

test("a kind the cluster does not serve is disabled with the reason", () => {
  const sections = templateSections(
    [{ apiVersion: "v1", kind: "Pod" }],
    vi.fn(),
  );
  const gateway = sections[1].items.find((i) => i.id === "gateway");
  expect(gateway).toMatchObject({
    disabled: true,
    disabledHint: "Not served by this cluster",
  });
  expect(sections[0].items.find((i) => i.id === "pod")?.disabled).toBe(false);
});
