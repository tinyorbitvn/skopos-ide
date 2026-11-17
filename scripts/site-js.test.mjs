import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODE = fs.readFileSync(path.join(ROOT, "site", "site.js"), "utf8");
const SIZES = {
  "aarch64.dmg": "14.0 MB",
  "x64.dmg": "14.6 MB",
  "x64-setup.exe": "9.8 MB",
  "amd64.AppImage": "93.9 MB",
  "amd64.deb": "16.6 MB",
};

// site.js runs in its own context, with no document, so it does not start by itself.
function loadSite() {
  const context = vm.createContext({});
  vm.runInContext(CODE, context, { filename: "site.js" });
  return context.SkoposSite;
}

// Values made in the vm context have that context's prototypes; compare them as JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

function element(attrs = {}, text = "") {
  return {
    attrs: { ...attrs },
    textContent: text,
    hidden: false,
    children: [],
    label: null,
    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector(selector) {
      return selector === "[data-label]" ? this.label : null;
    },
  };
}

// The parts of the page site.js touches, as Task 4's index.html lays them out.
function page({ withoutAssets = [] } = {}) {
  const links = {};
  for (const [suffix, size] of Object.entries(SIZES)) {
    if (withoutAssets.includes(suffix)) continue;
    links[suffix] = element({
      href: `https://downloads.test/${suffix}`,
      "data-asset": suffix,
      "data-name": `SkoposIDE_0.6.1_${suffix}`,
      "data-size": size,
    });
  }
  const button = element({ href: "#download" });
  button.label = element({}, "Download");
  const file = element();
  const alt = element();
  alt.hidden = true;
  const ids = { "hero-download": button, "hero-file": file, "hero-alt": alt };
  return {
    button,
    file,
    alt,
    getElementById: (id) => ids[id] ?? null,
    querySelector(selector) {
      const match = /^#download a\[data-asset="([^"]+)"\]$/.exec(selector);
      return match ? (links[match[1]] ?? null) : null;
    },
    createElement: () => element(),
  };
}

const UA = {
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  linuxArmFirefox: "Mozilla/5.0 (X11; Linux aarch64; rv:133.0) Gecko/20100101 Firefox/133.0",
  linuxChrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeos:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function uaData(platform, architecture, { mobile = false, fails = false } = {}) {
  return {
    platform,
    mobile,
    getHighEntropyValues: async () => {
      if (fails) throw new Error("denied");
      return { architecture };
    },
  };
}

const INTEL_ALT = ["Intel Mac? ", "Download the x64 dmg", "x64.dmg"];
const CASES = [
  {
    name: "macOS on Apple silicon, Chrome",
    nav: { userAgent: UA.macChrome, platform: "MacIntel", maxTouchPoints: 0, userAgentData: uaData("macOS", "arm") },
    primary: "aarch64.dmg",
    label: "Download for macOS",
    alt: INTEL_ALT,
  },
  {
    name: "macOS on Intel, Chrome",
    nav: { userAgent: UA.macChrome, platform: "MacIntel", maxTouchPoints: 0, userAgentData: uaData("macOS", "x86") },
    primary: "x64.dmg",
    label: "Download for macOS",
    alt: ["Apple silicon? ", "Download the arm64 dmg", "aarch64.dmg"],
  },
  {
    name: "macOS, Safari, which does not tell the architecture",
    nav: { userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 0 },
    primary: "aarch64.dmg",
    label: "Download for macOS",
    alt: INTEL_ALT,
  },
  {
    name: "macOS, architecture lookup refused",
    nav: { userAgent: UA.macChrome, platform: "MacIntel", maxTouchPoints: 0, userAgentData: uaData("macOS", "x86", { fails: true }) },
    primary: "aarch64.dmg",
    label: "Download for macOS",
    alt: INTEL_ALT,
  },
  {
    name: "Windows, Edge",
    nav: { userAgent: UA.windowsEdge, platform: "Win32", maxTouchPoints: 0, userAgentData: uaData("Windows", "x86") },
    primary: "x64-setup.exe",
    label: "Download for Windows",
    alt: null,
  },
  {
    name: "Windows on arm, which runs the x64 installer",
    nav: { userAgent: UA.windowsEdge, platform: "Win32", maxTouchPoints: 0, userAgentData: uaData("Windows", "arm") },
    primary: "x64-setup.exe",
    label: "Download for Windows",
    alt: null,
  },
  {
    name: "Linux x86_64, Firefox",
    nav: { userAgent: UA.linuxFirefox, platform: "Linux x86_64", maxTouchPoints: 0 },
    primary: "amd64.AppImage",
    label: "Download for Linux",
    alt: ["Debian or Ubuntu? ", "Download the .deb", "amd64.deb"],
  },
  {
    name: "Linux x86_64, Chrome",
    nav: { userAgent: UA.linuxChrome, platform: "Linux x86_64", maxTouchPoints: 0, userAgentData: uaData("Linux", "x86") },
    primary: "amd64.AppImage",
    label: "Download for Linux",
    alt: ["Debian or Ubuntu? ", "Download the .deb", "amd64.deb"],
  },
];

const NO_INSTALLER = [
  { name: "iPad asking for the desktop site", nav: { userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 5 } },
  { name: "iPhone", nav: { userAgent: UA.iphone, platform: "iPhone", maxTouchPoints: 5 } },
  {
    name: "Android phone",
    nav: { userAgent: UA.android, platform: "Linux armv8l", maxTouchPoints: 5, userAgentData: uaData("Android", "arm", { mobile: true }) },
  },
  {
    name: "ChromeOS",
    nav: { userAgent: UA.chromeos, platform: "Linux x86_64", maxTouchPoints: 0, userAgentData: uaData("Chrome OS", "x86") },
  },
  { name: "Linux on arm64, Firefox", nav: { userAgent: UA.linuxArmFirefox, platform: "Linux aarch64", maxTouchPoints: 0 } },
  {
    // Chrome's user agent says x86_64 on every Linux; only userAgentData knows the truth.
    name: "Linux on arm64, Chrome",
    nav: { userAgent: UA.linuxChrome, platform: "Linux x86_64", maxTouchPoints: 0, userAgentData: uaData("Linux", "arm") },
  },
  { name: "an unknown system", nav: { userAgent: "curl/8.5.0", platform: "", maxTouchPoints: 0 } },
];

describe("site.js", () => {
  for (const c of CASES) {
    test(`${c.name}: the hero downloads ${c.primary}`, async () => {
      const doc = page();
      const pick = await loadSite().init(doc, c.nav);
      assert.equal(plain(pick).primary, c.primary);
      assert.equal(doc.button.getAttribute("href"), `https://downloads.test/${c.primary}`);
      assert.equal(doc.button.label.textContent, c.label);
      assert.equal(doc.file.textContent, ` · SkoposIDE_0.6.1_${c.primary} · ${SIZES[c.primary]}`);
      if (c.alt) {
        const [text, linkText, suffix] = c.alt;
        assert.equal(doc.alt.hidden, false);
        assert.equal(doc.alt.textContent, text);
        assert.equal(doc.alt.children.length, 1);
        assert.equal(doc.alt.children[0].textContent, linkText);
        assert.equal(doc.alt.children[0].getAttribute("href"), `https://downloads.test/${suffix}`);
      } else {
        assert.equal(doc.alt.hidden, true);
        assert.equal(doc.alt.children.length, 0);
      }
    });
  }

  for (const c of NO_INSTALLER) {
    test(`${c.name}: the hero keeps the plain Download button`, async () => {
      const doc = page();
      assert.equal(await loadSite().init(doc, c.nav), null);
      assert.equal(doc.button.getAttribute("href"), "#download");
      assert.equal(doc.button.label.textContent, "Download");
      assert.equal(doc.file.textContent, "");
      assert.equal(doc.alt.hidden, true);
    });
  }

  test("a page without the chosen installer's link keeps the plain button", async () => {
    const doc = page({ withoutAssets: ["x64-setup.exe"] });
    const windows = CASES.find((c) => c.primary === "x64-setup.exe").nav;
    assert.equal(await loadSite().init(doc, windows), null);
    assert.equal(doc.button.getAttribute("href"), "#download");
    assert.equal(doc.button.label.textContent, "Download");
  });

  test("without the other installer's link the extra line stays hidden", async () => {
    const doc = page({ withoutAssets: ["x64.dmg"] });
    await loadSite().init(doc, CASES[0].nav);
    assert.equal(doc.button.getAttribute("href"), "https://downloads.test/aarch64.dmg");
    assert.equal(doc.alt.hidden, true);
  });

  test("pickDownload maps each system to its installers", () => {
    const site = loadSite();
    assert.deepEqual(plain(site.pickDownload("windows", "arm")), {
      label: "Windows",
      primary: "x64-setup.exe",
      alt: null,
    });
    assert.deepEqual(plain(site.pickDownload("mac", null)), {
      label: "macOS",
      primary: "aarch64.dmg",
      alt: { text: "Intel Mac? ", link: "Download the x64 dmg", asset: "x64.dmg" },
    });
    assert.equal(site.pickDownload("linux", "arm"), null);
    assert.equal(site.pickDownload(null, "x86"), null);
  });

  test("makes no network request and starts only where there is a document", () => {
    assert.doesNotMatch(CODE, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|import\(/);
    assert.equal(typeof loadSite().init, "function");
  });
});
