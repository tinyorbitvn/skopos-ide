import {
  byTestId,
  clickWhenShown,
  expectResourceTitle,
  gone,
  navItem,
  openCluster,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";

async function collapsed(): Promise<string | null> {
  return (await shown("sidebar-column")).getAttribute("data-collapsed");
}

// Spec Q §3: the sidebar collapses to an icon rail with flyouts, and back.
describe("the sidebar rail", () => {
  before(async () => {
    await openCluster(KIND);
  });

  it("collapses the sidebar to the rail with Ctrl+B", async () => {
    expect(await collapsed()).toBeNull();

    await browser.keys(["Control", "b"]);

    await shown("cluster-rail");
    await gone("cluster-sidebar");
    expect(await collapsed()).toBe("true");
  });

  it("opens Workloads from the rail's flyout and shows the Pods list", async () => {
    await clickWhenShown("rail-workloads");
    await shown("rail-flyout-workloads");

    await clickWhenShown("rail-item-core-pods");

    await gone("rail-flyout-workloads");
    await expectResourceTitle("Pod");
    expect(await byTestId("rail-workloads").getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("expands the sidebar again from its handle", async () => {
    await clickWhenShown("sidebar-collapse");

    await shown("cluster-sidebar");
    await gone("cluster-rail");
    expect(await collapsed()).toBeNull();
    await navItem("nav-item-core-pods");
  });
});
