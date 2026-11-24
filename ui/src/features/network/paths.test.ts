import { expect, test } from "vitest";
import { reachabilityPath } from "./paths";

test("the Reachability path encodes the cluster id and puts the namespace in ns", () => {
  expect(reachabilityPath("c1")).toBe("/cluster/c1/network/reachability");
  expect(reachabilityPath("team a/prod", "payments")).toBe(
    "/cluster/team%20a%2Fprod/network/reachability?ns=payments",
  );
  expect(reachabilityPath("c1", "a&b")).toBe(
    "/cluster/c1/network/reachability?ns=a%26b",
  );
});
