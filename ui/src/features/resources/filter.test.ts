import { describe, expect, test } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import {
  baseColumns,
  numberColumn,
  statusColumn,
  textColumn,
} from "../../kinds/columns";
import type { KubeObject } from "../../kinds/objects";
import { filterColumns } from "./columnFilter";
import {
  buildFilterIndex,
  chipText,
  columnOf,
  type FilterOperator,
  type FilterProperty,
  filterContext,
  filterText,
  keyCounts,
  LAST_APPLIED,
  matchChips,
  matchesFilter,
  measureHint,
  NO_COLUMNS,
  type ObjectFilter,
  operatorName,
  operatorsOf,
  parseFilter,
  passes,
  propertyWords,
  takesAnyValue,
  typedFilter,
  valueCounts,
} from "./filter";

const web: KubeObject = {
  metadata: {
    name: "web-1",
    namespace: "Team-A",
    labels: { app: "web", tier: "Front", "k8s.io/role": "edge" },
  },
};
const node: KubeObject = { metadata: { name: "node-1" } };
const scraped: KubeObject = {
  metadata: {
    name: "api-1",
    namespace: "shop",
    labels: { app: "api" },
    annotations: {
      "prometheus.io/scrape": "true",
      note: "",
      [LAST_APPLIED]: '{"secret":"hidden"}',
    },
  },
};

const NAME: FilterProperty = { type: "name" };
const NAMESPACE: FilterProperty = { type: "namespace" };
const label = (key: string): FilterProperty => ({ type: "label", key });
const anno = (key: string): FilterProperty => ({ type: "annotation", key });
const f = (
  property: FilterProperty,
  operator: FilterOperator,
  value: string,
): ObjectFilter => ({ property, operator, value });
const text = (value: string, operator: FilterOperator = ":") =>
  f({ type: "text" }, operator, value);

/** Today's search, now a text filter with `:` (spec M10). */
const search = (o: KubeObject, query: string) => matchesFilter(o, text(query));

describe("parseFilter", () => {
  test("nothing or white space gives null", () => {
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("   ")).toBeNull();
  });

  test("a property, an operator and a value give that filter, with spaces around the operator or none", () => {
    expect(parseFilter("name = web")).toEqual(f(NAME, "=", "web"));
    expect(parseFilter("name=web")).toEqual(f(NAME, "=", "web"));
    expect(parseFilter("  namespace   !=  shop  ")).toEqual(
      f(NAMESPACE, "!=", "shop"),
    );
    expect(parseFilter("label:tier : fr")).toEqual(f(label("tier"), ":", "fr"));
    expect(parseFilter("anno:note !: x y")).toEqual(
      f(anno("note"), "!:", "x y"),
    );
  });

  test("operators match longest first", () => {
    expect(parseFilter("label:a!=b")).toEqual(f(label("a"), "!=", "b"));
    expect(parseFilter("label:a!:b")).toEqual(f(label("a"), "!:", "b"));
    expect(parseFilter("label:a=!b")).toEqual(f(label("a"), "=", "!b"));
    expect(parseFilter("label:a:b=c")).toEqual(f(label("a"), ":", "b=c"));
  });

  test("the property ignores case; the key and the value keep theirs", () => {
    expect(parseFilter("NAME = Web")).toEqual(f(NAME, "=", "Web"));
    expect(parseFilter("NameSpace:Shop")).toEqual(f(NAMESPACE, ":", "Shop"));
    expect(parseFilter("LABEL:Tier = Front")).toEqual(
      f(label("Tier"), "=", "Front"),
    );
    expect(parseFilter("Anno:X = 1")).toEqual(f(anno("X"), "=", "1"));
  });

  test("keys may hold / and .", () => {
    expect(parseFilter("label:app.kubernetes.io/name=web")).toEqual(
      f(label("app.kubernetes.io/name"), "=", "web"),
    );
    expect(parseFilter("anno:prometheus.io/scrape = true")).toEqual(
      f(anno("prometheus.io/scrape"), "=", "true"),
    );
  });

  test("an empty value is any value for : and !:, and incomplete for = and !=", () => {
    expect(parseFilter("label:tier :")).toEqual(f(label("tier"), ":", ""));
    expect(parseFilter("anno:note !: ")).toEqual(f(anno("note"), "!:", ""));
    expect(parseFilter("name:")).toEqual(f(NAME, ":", ""));
    expect(parseFilter("label:tier =")).toBe("incomplete");
    expect(parseFilter("label:tier != ")).toBe("incomplete");
    expect(parseFilter("namespace =")).toBe("incomplete");
  });

  test("a property alone is incomplete once a space follows it; label: and anno: are until an operator", () => {
    expect(parseFilter("name ")).toBe("incomplete");
    expect(parseFilter("namespace  ")).toBe("incomplete");
    expect(parseFilter("label:tier ")).toBe("incomplete");
    expect(parseFilter("label:tier")).toBe("incomplete");
    expect(parseFilter("anno:")).toBe("incomplete");
    expect(parseFilter("label:")).toBe("incomplete");
    expect(parseFilter("label:tier web")).toBe("incomplete");
  });

  test("any other text is a text filter, so name, namespace and k=v search as before", () => {
    expect(parseFilter("web")).toEqual(text("web"));
    expect(parseFilter("  web  team-a ")).toEqual(text("web  team-a"));
    expect(parseFilter("name")).toEqual(text("name"));
    expect(parseFilter("namespace")).toEqual(text("namespace"));
    expect(parseFilter("app=web")).toEqual(text("app=web"));
    expect(parseFilter("names=web")).toEqual(text("names=web"));
    expect(parseFilter("name web")).toEqual(text("name web"));
  });

  test("typedFilter keeps only a filter", () => {
    expect(typedFilter("app=web")).toEqual(text("app=web"));
    expect(typedFilter("label:tier =")).toBeNull();
    expect(typedFilter(" ")).toBeNull();
  });
});

describe("text forms and words", () => {
  test("a filter reads property, operator, value; a text filter is quoted", () => {
    expect(filterText(f(label("tier"), "=", "web"))).toBe("label:tier = web");
    expect(filterText(f(anno("a/b"), ":", ""))).toBe("anno:a/b :");
    expect(filterText(f(NAME, "!=", "x"))).toBe("name != x");
    expect(filterText(f(NAMESPACE, "!:", "x"))).toBe("namespace !: x");
    expect(filterText(text("web"))).toBe('"web"');
    expect(filterText(text("web", "!:"))).toBe('not "web"');
  });

  test("properties have words and their operators", () => {
    expect(propertyWords(label("tier"))).toBe("Label tier");
    expect(propertyWords(anno("prometheus.io/scrape"))).toBe(
      "Annotation prometheus.io/scrape",
    );
    expect(propertyWords(NAME)).toBe("Name");
    expect(propertyWords(NAMESPACE)).toBe("Namespace");
    expect(propertyWords({ type: "text" })).toBe("Free text");
    expect(operatorsOf({ type: "text" })).toEqual([":", "!:"]);
    expect(operatorsOf(NAME)).toEqual(["=", "!=", ":", "!:"]);
  });
});

describe("text filters keep today's search", () => {
  test("an empty query matches everything", () => {
    expect(search(web, "")).toBe(true);
    expect(search(node, "   ")).toBe(true);
  });

  test("matches the name", () => {
    expect(search(web, "web-")).toBe(true);
    expect(search(web, "absent")).toBe(false);
  });

  test("matches the namespace", () => {
    expect(search(web, "team-a")).toBe(true);
    expect(search(node, "team-a")).toBe(false);
  });

  test("matches a label key or value", () => {
    expect(search(web, "tier")).toBe(true);
    expect(search(web, "front")).toBe(true);
    expect(search(node, "front")).toBe(false);
  });

  test("k=v matches a label with that key and value", () => {
    expect(search(web, "app=web")).toBe(true);
    expect(search(web, "k8s.io/role=edge")).toBe(true);
    // Each side has to match the whole of its part.
    expect(search(web, "app=we")).toBe(false);
    expect(search(web, "ap=web")).toBe(false);
    expect(search(web, "tier=web")).toBe(false);
    expect(search(node, "app=web")).toBe(false);
  });

  test("terms separated by spaces must all match", () => {
    expect(search(web, "web team-a")).toBe(true);
    expect(search(web, "web   app=web  front")).toBe(true);
    expect(search(web, "web team-b")).toBe(false);
    expect(search(web, "app=web tier=back")).toBe(false);
  });

  test("matching ignores case", () => {
    expect(search(web, "WEB-1")).toBe(true);
    expect(search(web, "TEAM-a")).toBe(true);
    expect(search(web, "TIER=front")).toBe(true);
  });

  test("an object without labels or a namespace is fine", () => {
    expect(search(node, "node")).toBe(true);
    expect(search(node, "k=v")).toBe(false);
  });

  test("text never reads annotations, and !: turns it around", () => {
    expect(search(scraped, "scrape")).toBe(false);
    expect(matchesFilter(web, text("web", "!:"))).toBe(false);
    expect(matchesFilter(web, text("absent", "!:"))).toBe(true);
  });
});

describe("matchesFilter", () => {
  test("name and namespace: equals, does not equal, contains, does not contain, ignoring case", () => {
    expect(matchesFilter(web, f(NAME, "=", "WEB-1"))).toBe(true);
    expect(matchesFilter(web, f(NAME, "=", "web"))).toBe(false);
    expect(matchesFilter(web, f(NAME, "!=", "web"))).toBe(true);
    expect(matchesFilter(web, f(NAME, "!=", "web-1"))).toBe(false);
    expect(matchesFilter(web, f(NAME, ":", "EB"))).toBe(true);
    expect(matchesFilter(web, f(NAME, "!:", "eb"))).toBe(false);
    expect(matchesFilter(web, f(NAMESPACE, "=", "team-a"))).toBe(true);
    expect(matchesFilter(web, f(NAMESPACE, ":", "team"))).toBe(true);
    expect(matchesFilter(web, f(NAMESPACE, "!:", "shop"))).toBe(true);
  });

  test("a cluster-scoped object's namespace is empty", () => {
    expect(matchesFilter(node, f(NAMESPACE, ":", ""))).toBe(true);
    expect(matchesFilter(node, f(NAMESPACE, "!=", "x"))).toBe(true);
    expect(matchesFilter(node, f(NAMESPACE, ":", "x"))).toBe(false);
  });

  test("labels: the key compared ignoring case, and each operator", () => {
    expect(matchesFilter(web, f(label("TIER"), "=", "front"))).toBe(true);
    expect(matchesFilter(web, f(label("tier"), "=", "fro"))).toBe(false);
    expect(matchesFilter(web, f(label("tier"), "!=", "back"))).toBe(true);
    expect(matchesFilter(web, f(label("tier"), "!=", "Front"))).toBe(false);
    expect(matchesFilter(node, f(label("tier"), "!=", "front"))).toBe(true);
    expect(matchesFilter(web, f(label("tier"), ":", "ron"))).toBe(true);
    expect(matchesFilter(node, f(label("tier"), ":", "ron"))).toBe(false);
    expect(matchesFilter(web, f(label("tier"), "!:", "ron"))).toBe(false);
    expect(matchesFilter(node, f(label("tier"), "!:", "ron"))).toBe(true);
  });

  test("annotations: each operator", () => {
    const scrape = anno("prometheus.io/scrape");
    expect(matchesFilter(scraped, f(scrape, "=", "TRUE"))).toBe(true);
    expect(matchesFilter(scraped, f(scrape, "!=", "true"))).toBe(false);
    expect(matchesFilter(web, f(scrape, "!=", "true"))).toBe(true);
    expect(matchesFilter(scraped, f(scrape, ":", "ru"))).toBe(true);
    expect(matchesFilter(scraped, f(scrape, "!:", "ru"))).toBe(false);
    expect(matchesFilter(web, f(scrape, "!:", "ru"))).toBe(true);
  });

  test("an empty value with : means the key is there, and with !: that it is missing", () => {
    expect(matchesFilter(scraped, f(anno("note"), ":", ""))).toBe(true);
    expect(matchesFilter(web, f(anno("note"), ":", ""))).toBe(false);
    expect(matchesFilter(scraped, f(anno("note"), "!:", ""))).toBe(false);
    expect(matchesFilter(web, f(anno("note"), "!:", ""))).toBe(true);
    expect(matchesFilter(web, f(label("tier"), ":", ""))).toBe(true);
    expect(matchesFilter(node, f(label("tier"), "!:", ""))).toBe(true);
  });

  test("the last-applied annotation never matches, in any case of its key", () => {
    const applied = anno(LAST_APPLIED);
    expect(matchesFilter(scraped, f(applied, ":", ""))).toBe(false);
    expect(matchesFilter(scraped, f(applied, ":", "secret"))).toBe(false);
    expect(matchesFilter(scraped, f(applied, "!:", ""))).toBe(true);
    expect(
      matchesFilter(scraped, f(anno(LAST_APPLIED.toUpperCase()), ":", "")),
    ).toBe(false);
  });
});

describe("passes", () => {
  const tier = f(label("tier"), "=", "front");
  const scrape = f(anno("prometheus.io/scrape"), "=", "true");

  test("and needs every token, or any; no token passes everything", () => {
    expect(passes(web, [tier, scrape], "and", null)).toBe(false);
    expect(passes(web, [tier, scrape], "or", null)).toBe(true);
    expect(passes(scraped, [tier, scrape], "or", null)).toBe(true);
    expect(passes(node, [tier, scrape], "or", null)).toBe(false);
    expect(passes(node, [], "and", null)).toBe(true);
    expect(passes(node, [], "or", null)).toBe(true);
  });

  test("the typed filter always narrows, whatever the join", () => {
    expect(passes(web, [tier, scrape], "or", text("api"))).toBe(false);
    expect(passes(scraped, [tier, scrape], "or", text("api"))).toBe(true);
    expect(passes(web, [], "or", text("absent"))).toBe(false);
    expect(passes(web, [], "and", f(NAME, ":", "web"))).toBe(true);
  });
});

describe("matchChips", () => {
  test("a label or annotation that matched with = or : gives a chip", () => {
    expect(
      matchChips(scraped, [
        f(anno("prometheus.io/scrape"), "=", "true"),
        f(label("APP"), ":", "ap"),
      ]),
    ).toEqual([
      { kind: "anno", key: "prometheus.io/scrape", value: "true" },
      { kind: "label", key: "app", value: "api" },
    ]);
  });

  test("a text word that matched a label gives a chip, k=v or part of a key or value", () => {
    expect(matchChips(web, [text("app=web")])).toEqual([
      { kind: "label", key: "app", value: "web" },
    ]);
    expect(matchChips(web, [text("fron edge")])).toEqual([
      { kind: "label", key: "tier", value: "Front" },
      { kind: "label", key: "k8s.io/role", value: "edge" },
    ]);
  });

  test("!=, !:, names, namespaces, filters that do not match and duplicates add none", () => {
    expect(
      matchChips(web, [
        f(label("tier"), "!=", "back"),
        f(label("app"), "!:", "x"),
        f(NAME, "=", "web-1"),
        f(NAMESPACE, ":", "team"),
        f(label("tier"), "=", "back"),
        text("web-1"),
      ]),
    ).toEqual([]);
    expect(
      matchChips(web, [f(label("app"), "=", "web"), text("app=web")]),
    ).toEqual([{ kind: "label", key: "app", value: "web" }]);
  });

  test("the last-applied annotation never gives a chip", () => {
    expect(matchChips(scraped, [f(anno(LAST_APPLIED), ":", "")])).toEqual([]);
  });

  test("chipText is key=value", () => {
    expect(chipText({ kind: "anno", key: "a/b", value: "c" })).toBe("a/b=c");
  });
});

describe("the filter index", () => {
  const objects: KubeObject[] = [
    {
      metadata: {
        name: "a",
        namespace: "shop",
        labels: { tier: "web", app: "a" },
        annotations: { note: "x", [LAST_APPLIED]: "{}" },
      },
    },
    {
      metadata: {
        name: "b",
        namespace: "shop",
        labels: { tier: "web" },
        annotations: { note: "" },
      },
    },
    {
      metadata: { name: "c", namespace: "ops", labels: { tier: "db" } },
    },
    { metadata: { name: "n1" } },
  ];
  const index = buildFilterIndex(objects);

  test("keys count the objects that carry them, most common first, then by key, never last-applied", () => {
    expect(keyCounts(index, "label")).toEqual([
      { text: "tier", count: 3 },
      { text: "app", count: 1 },
    ]);
    expect(keyCounts(index, "annotation")).toEqual([
      { text: "note", count: 2 },
    ]);
  });

  test("values count per property, most common first, then by value", () => {
    expect(valueCounts(index, label("tier"))).toEqual([
      { text: "web", count: 2 },
      { text: "db", count: 1 },
    ]);
    expect(valueCounts(index, label("TIER"))).toEqual(
      valueCounts(index, label("tier")),
    );
    expect(valueCounts(index, anno("note"))).toEqual([
      { text: "", count: 1 },
      { text: "x", count: 1 },
    ]);
    expect(valueCounts(index, NAMESPACE)).toEqual([
      { text: "shop", count: 2 },
      { text: "", count: 1 },
      { text: "ops", count: 1 },
    ]);
    expect(valueCounts(index, NAME).map((c) => c.text)).toEqual([
      "a",
      "b",
      "c",
      "n1",
    ]);
    expect(valueCounts(index, anno(LAST_APPLIED))).toEqual([]);
    expect(valueCounts(index, { type: "text" })).toEqual([]);
  });
});

const NOW = Date.parse("2026-11-22T12:00:00Z");
const POD_REF: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};
const POD_COLUMNS = baseColumns(
  POD_REF,
  statusColumn((o) => ({ label: o.status?.phase ?? "Unknown", tone: "ok" })),
  numberColumn("restarts", "Restarts", (o) => o.status?.restarts),
  textColumn("ip", "IP", (o) => o.status?.podIP),
  textColumn("node", "Node", (o) => o.spec?.nodeName),
  textColumn("family", "IP family", (o) => o.status?.family),
  textColumn("reason", "Reason", (o) => o.status?.reason),
);
/** IP is hidden, as a Pod list starts. */
const ctx = filterContext(filterColumns(POD_COLUMNS, ["ip"]), NOW);
const hiddenCtx = (hidden: string[], now = NOW) =>
  filterContext(filterColumns(POD_COLUMNS, hidden), now);

const running: KubeObject = {
  metadata: {
    name: "web-1",
    namespace: "shop",
    creationTimestamp: "2026-11-22T11:30:00Z",
    labels: { app: "web" },
  },
  spec: { nodeName: "worker-1" },
  status: {
    phase: "Running",
    restarts: 2,
    podIP: "10.244.1.5",
    family: "IPv4",
    reason: "Back-off restarting",
  },
};
const pending: KubeObject = {
  metadata: {
    name: "db-1",
    namespace: "ops",
    creationTimestamp: "2026-11-12T12:00:00Z",
  },
  spec: {},
  status: { phase: "Pending" },
};
const column = (key: string): FilterProperty => ({ type: "column", key });
const parse = (text: string) => parseFilter(text, ctx);
const match = (o: KubeObject, text: string, context = ctx) => {
  const parsed = parseFilter(text, context);
  if (parsed === null || parsed === "incomplete") {
    throw new Error(`${text} is ${String(parsed)}`);
  }
  return matchesFilter(o, parsed, context);
};

describe("column properties", () => {
  test("a column key with an operator is a column filter, read ignoring case, with or without spaces", () => {
    expect(parse("status = Running")).toEqual(
      f(column("status"), "=", "Running"),
    );
    expect(parse("STATUS=Running")).toEqual(
      f(column("status"), "=", "Running"),
    );
    expect(parse("node : worker")).toEqual(f(column("node"), ":", "worker"));
    expect(parse("ip !: 10.244")).toEqual(f(column("ip"), "!:", "10.244"));
    expect(parse("reason = Back-off restarting")).toEqual(
      f(column("reason"), "=", "Back-off restarting"),
    );
  });

  test("keys are tried longest first, and a key needs an operator after it", () => {
    expect(parse("ip-family = IPv4")).toEqual(
      f(column("ip-family"), "=", "IPv4"),
    );
    expect(parse("statusbar")).toEqual(text("statusbar"));
    expect(parse("sync-status = x")).toEqual(text("sync-status = x"));
    expect(parse("status ")).toBe("incomplete");
  });

  test("k=v filters a column when k is one of the list's keys, and labels otherwise", () => {
    expect(parse("node=worker")).toEqual(f(column("node"), "=", "worker"));
    expect(parse("app=web")).toEqual(text("app=web"));
    expect(parse("web node=worker")).toEqual(text("web node=worker"));
    expect(parse("label:node = worker")).toEqual(
      f(label("node"), "=", "worker"),
    );
  });

  test("> and < take a number or a time on a number or time column only", () => {
    expect(parse("restarts > 0")).toEqual(f(column("restarts"), ">", "0"));
    expect(parse("age < 1h")).toEqual(f(column("age"), "<", "1h"));
    expect(parse("age > 7D")).toEqual(f(column("age"), ">", "7D"));
    for (const incomplete of [
      "status > 1",
      "name < x",
      "label:app > 1",
      "age < abc",
      "age < 90",
      "restarts > 1h",
      "age > ",
    ]) {
      expect(parse(incomplete)).toBe("incomplete");
    }
  });

  test(": and !: with no value on a column mean any value, as for labels", () => {
    expect(parse("ip :")).toEqual(f(column("ip"), ":", ""));
    expect(takesAnyValue(column("ip"), ":")).toBe(true);
    expect(takesAnyValue(column("ip"), "=")).toBe(false);
    expect(parse("ip =")).toBe("incomplete");
  });

  test("a header with regular-expression characters gives a key that can be typed", () => {
    const odd = filterContext(
      filterColumns(
        [
          textColumn("ready", "Pods (Ready)", () => "1/1"),
          textColumn("size", "Size.GB", () => "10"),
        ],
        [],
      ),
      NOW,
    );
    expect(parseFilter("pods-(ready) = 1/1", odd)).toEqual(
      f(column("pods-(ready)"), "=", "1/1"),
    );
    expect(parseFilter("size.gb : 1", odd)).toEqual(
      f(column("size.gb"), ":", "1"),
    );
    expect(parseFilter("sizexgb : 1", odd)).toEqual(text("sizexgb : 1"));
  });

  test("operators, their names, words and text forms follow the column", () => {
    expect(operatorsOf(column("status"), ctx)).toEqual(["=", "!=", ":", "!:"]);
    expect(operatorsOf(column("restarts"), ctx)).toEqual([
      "=",
      "!=",
      ":",
      "!:",
      ">",
      "<",
    ]);
    expect(operatorName(">", column("restarts"), ctx)).toBe("Greater than");
    expect(operatorName("<", column("restarts"), ctx)).toBe("Less than");
    expect(operatorName(">", column("age"), ctx)).toBe("Longer than");
    expect(operatorName("<", column("age"), ctx)).toBe("Shorter than");
    expect(operatorName("=", column("age"), ctx)).toBe("Equals");
    expect(measureHint(column("age"), ctx)).toBe(
      "Type a time such as 30m, 2h or 7d",
    );
    expect(measureHint(column("restarts"), ctx)).toBe("Type a number");
    expect(propertyWords(column("status"), ctx)).toBe("Status");
    expect(propertyWords(column("cpu"), ctx)).toBe("cpu");
    expect(columnOf(column("ip"), ctx)?.hidden).toBe(true);
    expect(filterText(f(column("age"), "<", "1h"))).toBe("age < 1h");
    expect(filterText(f(column("ip"), ":", ""))).toBe("ip :");
  });

  test("without columns, the filter reads names, namespaces and labels as before", () => {
    expect(parseFilter("status = Running")).toEqual(text("status = Running"));
    expect(parseFilter("name = web", NO_COLUMNS)).toEqual(f(NAME, "=", "web"));
  });
});

describe("matching columns", () => {
  test("text operators compare the cell's text ignoring case", () => {
    expect(match(running, "status = running")).toBe(true);
    expect(match(running, "STATUS = Running")).toBe(true);
    expect(match(pending, "status = Running")).toBe(false);
    expect(match(pending, "status != Running")).toBe(true);
    expect(match(running, "node : WORKER")).toBe(true);
    expect(match(running, "reason = back-off restarting")).toBe(true);
    expect(match(running, "reason = back-off")).toBe(false);
    // Number and time columns compare their shown text too.
    expect(match(running, "restarts = 2")).toBe(true);
    expect(match(running, "restarts != 2")).toBe(false);
    expect(match(running, "age = 30m")).toBe(true);
    expect(match(running, "age : 30")).toBe(true);
  });

  test("an empty cell matches != and !: but not = and :", () => {
    expect(match(pending, "node : worker")).toBe(false);
    expect(match(pending, "node = worker")).toBe(false);
    expect(match(pending, "node !: worker")).toBe(true);
    expect(match(pending, "node != worker")).toBe(true);
    expect(match(running, "ip :")).toBe(true);
    expect(match(pending, "ip :")).toBe(false);
    expect(match(pending, "ip !:")).toBe(true);
  });

  test("> and < compare amounts; equal is neither, and an empty cell neither", () => {
    expect(match(running, "restarts > 1")).toBe(true);
    expect(match(running, "restarts > 2")).toBe(false);
    expect(match(running, "restarts < 2")).toBe(false);
    expect(match(pending, "restarts < 1")).toBe(true);
    expect(match(running, "age < 1h")).toBe(true);
    expect(match(pending, "age < 1h")).toBe(false);
    expect(match(pending, "age > 7d")).toBe(true);
    const unborn: KubeObject = { metadata: { name: "x" } };
    expect(match(unborn, "age > 0s")).toBe(false);
    expect(match(unborn, "age < 1y")).toBe(false);
  });

  test("a time filter reads the context's time", () => {
    expect(
      match(running, "age < 1h", hiddenCtx(["ip"], NOW + 31 * 60_000)),
    ).toBe(false);
  });

  test("a token whose column is not in the list matches nothing, whatever its operator", () => {
    for (const operator of ["=", "!=", ":", "!:", ">", "<"] as const) {
      expect(matchesFilter(running, f(column("cpu"), operator, "1"), ctx)).toBe(
        false,
      );
    }
  });

  test("free text reads every column, the hidden ones too; a word with = reads labels only", () => {
    expect(matchesFilter(running, text("10.244.1.5"), ctx)).toBe(true);
    expect(matchesFilter(running, text("worker-1"), ctx)).toBe(true);
    expect(matchesFilter(pending, text("pending"), ctx)).toBe(true);
    expect(matchesFilter(pending, text("worker"), ctx)).toBe(false);
    expect(matchesFilter(running, text("ipv4 web"), ctx)).toBe(true);
    expect(matchesFilter(running, text("phase=Running"), ctx)).toBe(false);
    expect(matchesFilter(running, text("app=web"), ctx)).toBe(true);
  });

  test("passes reads the context for tokens and the typed filter", () => {
    const tokens = [f(column("status"), "=", "Running")];
    expect(passes(running, tokens, "and", null, ctx)).toBe(true);
    expect(passes(pending, tokens, "and", null, ctx)).toBe(false);
    expect(
      passes(running, [], "and", f(column("restarts"), ">", "5"), ctx),
    ).toBe(false);
  });
});

describe("column chips", () => {
  test("a hidden column adds a chip for free text, after the labels a word matched", () => {
    expect(matchChips(running, [text("10.244")], ctx)).toEqual([
      { kind: "column", key: "ip", value: "10.244.1.5" },
    ]);
    expect(matchChips(running, [text("web")], ctx)).toEqual([
      { kind: "label", key: "app", value: "web" },
    ]);
    expect(matchChips(running, [text("worker")], ctx)).toEqual([]);
  });

  test("a hidden column adds a chip for =, :, > and <, never for != and !:", () => {
    const chip = { kind: "column", key: "ip", value: "10.244.1.5" };
    expect(matchChips(running, [f(column("ip"), ":", "10.244")], ctx)).toEqual([
      chip,
    ]);
    expect(
      matchChips(running, [f(column("ip"), "=", "10.244.1.5")], ctx),
    ).toEqual([chip]);
    expect(matchChips(running, [f(column("ip"), ":", "")], ctx)).toEqual([
      chip,
    ]);
    expect(matchChips(running, [f(column("ip"), "!=", "x")], ctx)).toEqual([]);
    expect(matchChips(running, [f(column("ip"), "!:", "x")], ctx)).toEqual([]);
    expect(matchChips(running, [f(column("restarts"), ">", "1")], ctx)).toEqual(
      [],
    );
    const ageHidden = hiddenCtx(["age"]);
    expect(
      matchChips(running, [f(column("age"), "<", "1h")], ageHidden),
    ).toEqual([{ kind: "column", key: "age", value: "30m" }]);
  });

  test("a hidden Namespace column adds a chip for a namespace token and for free text", () => {
    const nsHidden = hiddenCtx(["namespace"]);
    const chip = { kind: "column", key: "namespace", value: "shop" };
    expect(matchChips(running, [f(NAMESPACE, ":", "sh")], nsHidden)).toEqual([
      chip,
    ]);
    expect(matchChips(running, [text("shop")], nsHidden)).toEqual([chip]);
    expect(matchChips(running, [f(NAMESPACE, ":", "sh")], ctx)).toEqual([]);
  });

  test("a chip's text is the key and the cell's text", () => {
    expect(chipText({ kind: "column", key: "ip", value: "10.244.1.5" })).toBe(
      "ip=10.244.1.5",
    );
  });
});

describe("the index of columns", () => {
  test("counts each column's texts, without empty cells and time columns", () => {
    const index = buildFilterIndex([running, pending], ctx);
    expect([...(index.columns.get("status") ?? [])]).toEqual([
      ["Running", 1],
      ["Pending", 1],
    ]);
    expect([...(index.columns.get("node") ?? [])]).toEqual([["worker-1", 1]]);
    expect(index.columns.has("age")).toBe(false);
    expect(index.columns.has("name")).toBe(false);
    expect(valueCounts(index, column("status"))).toEqual([
      { text: "Pending", count: 1 },
      { text: "Running", count: 1 },
    ]);
    expect(valueCounts(index, column("cpu"))).toEqual([]);
    expect(buildFilterIndex([running]).columns.size).toBe(0);
  });
});
