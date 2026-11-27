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
  const classes = new Set();
  return {
    attrs: { ...attrs },
    textContent: text,
    hidden: false,
    children: [],
    label: null,
    tag: null,
    classList: {
      add: (name) => {
        classes.add(name);
      },
      remove: (name) => {
        classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
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
      if (selector === "[data-label]") return this.label;
      if (selector === ".platform__tag") return this.tag;
      return null;
    },
  };
}

function downloadButton() {
  const button = element({ href: "#download" });
  button.label = element({}, "Download");
  return button;
}

// The parts of the page site.js touches, as site/index.html lays them out.
function page({ withoutAssets = [], withoutHero = false, withoutCta = false, withoutCards = false } = {}) {
  const links = {};
  for (const [suffix, size] of Object.entries(SIZES)) {
    if (withoutAssets.includes(suffix)) continue;
    links[suffix] = element({
      href: `https://downloads.test/${suffix}`,
      "data-asset": suffix,
      "data-name": `SkoposIDE_0.6.1_${suffix}`,
      "data-size": size,
    });
    for (const name of ["button", "button--line", "button--sm"]) links[suffix].classList.add(name);
  }
  const cards = {};
  if (!withoutCards) {
    for (const os of ["mac", "windows", "linux"]) {
      cards[os] = element({ "data-os": os });
      cards[os].classList.add("platform");
      cards[os].tag = element({}, "Your system");
      cards[os].tag.hidden = true;
    }
  }
  const button = withoutHero ? null : downloadButton();
  const cta = withoutCta ? null : downloadButton();
  const file = element();
  const alt = element();
  alt.hidden = true;
  const store = { hero: element(), cta: element() };
  store.hero.hidden = true;
  store.cta.hidden = true;
  const ids = {
    "hero-download": button,
    "cta-download": cta,
    "hero-file": file,
    "hero-alt": alt,
    "hero-store": withoutHero ? null : store.hero,
    "cta-store": withoutCta ? null : store.cta,
  };
  return {
    button,
    cta,
    store,
    links,
    cards,
    file,
    alt,
    getElementById: (id) => ids[id] ?? null,
    querySelector(selector) {
      const asset = /^#download a\[data-asset="([^"]+)"\]$/.exec(selector);
      if (asset) return links[asset[1]] ?? null;
      const card = /^\.platform\[data-os="([^"]+)"\]$/.exec(selector);
      if (card) return cards[card[1]] ?? null;
      return null;
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

// The data-os of the card each label belongs to.
const OS = { "Download for macOS": "mac", "Download for Windows": "windows", "Download for Linux": "linux" };

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

  for (const c of CASES) {
    test(`${c.name}: the call to action matches the hero and only the ${OS[c.label]} card is marked`, async () => {
      const doc = page();
      await loadSite().init(doc, c.nav);
      assert.equal(doc.cta.getAttribute("href"), `https://downloads.test/${c.primary}`);
      assert.equal(doc.cta.label.textContent, c.label);
      for (const [os, card] of Object.entries(doc.cards)) {
        const mine = os === OS[c.label];
        assert.equal(card.classList.contains("platform--mine"), mine, os);
        assert.equal(card.tag.hidden, !mine, os);
      }
      for (const [suffix, link] of Object.entries(doc.links)) {
        const picked = suffix === c.primary;
        assert.equal(link.classList.contains("button--primary"), picked, suffix);
        assert.equal(link.classList.contains("button--line"), !picked, suffix);
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

  for (const c of NO_INSTALLER) {
    test(`${c.name}: no card is marked and the call to action stays plain`, async () => {
      const doc = page();
      await loadSite().init(doc, c.nav);
      assert.equal(doc.cta.getAttribute("href"), "#download");
      assert.equal(doc.cta.label.textContent, "Download");
      for (const card of Object.values(doc.cards)) {
        assert.equal(card.classList.contains("platform--mine"), false);
        assert.equal(card.tag.hidden, true);
      }
      for (const link of Object.values(doc.links)) {
        assert.equal(link.classList.contains("button--primary"), false);
      }
    });
  }

  for (const c of [...CASES, ...NO_INSTALLER]) {
    const windows = OS[c.label] === "windows";
    test(`${c.name}: the Microsoft Store badges are ${windows ? "shown" : "hidden"}`, async () => {
      const doc = page();
      await loadSite().init(doc, c.nav);
      assert.equal(doc.store.hero.hidden, !windows);
      assert.equal(doc.store.cta.hidden, !windows);
    });
  }

  test("Windows shows the Store badges even without the installer's link", async () => {
    const doc = page({ withoutAssets: ["x64-setup.exe"] });
    const windows = CASES.find((c) => OS[c.label] === "windows");
    assert.equal(await loadSite().init(doc, windows.nav), null);
    assert.equal(doc.store.hero.hidden, false);
    assert.equal(doc.store.cta.hidden, false);
  });

  test("a page without the call to action or the cards still points the hero", async () => {
    const doc = page({ withoutCta: true, withoutCards: true });
    await loadSite().init(doc, CASES[0].nav);
    assert.equal(doc.button.getAttribute("href"), "https://downloads.test/aarch64.dmg");
    assert.equal(doc.links["aarch64.dmg"].classList.contains("button--primary"), true);
  });

  test("a page without the hero's button still points the call to action and marks the card", async () => {
    const doc = page({ withoutHero: true });
    await loadSite().init(doc, CASES[0].nav);
    assert.equal(doc.cta.getAttribute("href"), "https://downloads.test/aarch64.dmg");
    assert.equal(doc.cta.label.textContent, "Download for macOS");
    assert.equal(doc.cards.mac.classList.contains("platform--mine"), true);
  });

  test("a page without the chosen installer's link keeps the plain button", async () => {
    const doc = page({ withoutAssets: ["x64-setup.exe"] });
    const windows = CASES.find((c) => c.primary === "x64-setup.exe").nav;
    assert.equal(await loadSite().init(doc, windows), null);
    assert.equal(doc.button.getAttribute("href"), "#download");
    assert.equal(doc.button.label.textContent, "Download");
    assert.equal(doc.cta.getAttribute("href"), "#download");
    for (const card of Object.values(doc.cards)) {
      assert.equal(card.classList.contains("platform--mine"), false);
    }
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

  test("makes no network request", () => {
    assert.doesNotMatch(CODE, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|import\(/);
  });

  describe("initLightbox", () => {
    // A node with attributes and the listeners site.js adds.
    function node(attrs = {}) {
      return {
        attrs: { ...attrs },
        listeners: {},
        className: "",
        textContent: "",
        focused: 0,
        getAttribute(name) {
          return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
        },
        setAttribute(name, value) {
          this.attrs[name] = String(value);
        },
        addEventListener(type, fn) {
          (this.listeners[type] ??= []).push(fn);
        },
        fire(type, event = {}) {
          for (const fn of this.listeners[type] ?? []) fn({ target: this, preventDefault() {}, ...event });
        },
        focus() {
          this.focused += 1;
        },
      };
    }

    // The lightbox dialog of site/index.html and two feature pictures.
    function lightboxPage({ showModal = true } = {}) {
      const close = node({ "aria-label": "Close" });
      const caption = node();
      const figure = node();
      figure.inserted = [];
      figure.insertBefore = (child, before) => figure.inserted.push([child, before]);
      const dialog = node();
      dialog.opened = 0;
      if (showModal) {
        dialog.showModal = () => {
          dialog.opened += 1;
        };
      }
      dialog.close = () => dialog.fire("close");
      dialog.querySelector = (selector) =>
        ({ ".lightbox__figure": figure, ".lightbox__caption": caption, ".lightbox__close": close })[selector] ?? null;
      const pictures = [
        node({ src: "images/canvas-map.png", alt: "The resource map of prod-eu-west" }),
        node({ src: "images/canvas-pods.png", alt: "The Pods of prod-eu-west" }),
      ];
      return {
        dialog,
        close,
        caption,
        figure,
        pictures,
        getElementById: (id) => (id === "lightbox" ? dialog : null),
        querySelectorAll: (selector) => (selector === ".card__media img" ? pictures : []),
        createElement: () => node(),
      };
    }

    test("leaves the pictures alone without the dialog or without dialog support", () => {
      const site = loadSite();
      const old = lightboxPage({ showModal: false });
      assert.equal(site.initLightbox(old), 0);
      assert.equal(old.pictures[0].getAttribute("role"), null);
      const none = lightboxPage();
      none.getElementById = () => null;
      assert.equal(site.initLightbox(none), 0);
    });

    test("makes each picture a button that opens it larger with its alt text as the caption", () => {
      const doc = lightboxPage();
      assert.equal(loadSite().initLightbox(doc), 2);
      const [map, pods] = doc.pictures;
      assert.deepEqual(plain(map.attrs), {
        src: "images/canvas-map.png",
        alt: "The resource map of prod-eu-west",
        tabindex: "0",
        role: "button",
        "aria-haspopup": "dialog",
        "aria-label": "Enlarge: The resource map of prod-eu-west",
      });
      const [[big, before]] = doc.figure.inserted;
      assert.equal(before, doc.caption);
      assert.equal(big.className, "lightbox__img");

      pods.fire("click");
      assert.equal(doc.dialog.opened, 1);
      assert.equal(big.getAttribute("src"), "images/canvas-pods.png");
      assert.equal(big.getAttribute("alt"), "The Pods of prod-eu-west");
      assert.equal(doc.caption.textContent, "The Pods of prod-eu-west");

      map.fire("keydown", { key: "Enter" });
      map.fire("keydown", { key: " " });
      map.fire("keydown", { key: "a" });
      assert.equal(doc.dialog.opened, 3);
      assert.equal(big.getAttribute("src"), "images/canvas-map.png");
    });

    test("closes on the close button or beside the picture and gives the focus back", () => {
      const doc = lightboxPage();
      loadSite().initLightbox(doc);
      const [map] = doc.pictures;
      map.fire("click");
      doc.close.fire("click");
      assert.equal(map.focused, 1);
      map.fire("click");
      doc.dialog.fire("click", { target: doc.figure });
      assert.equal(map.focused, 1, "a click on the picture keeps it open");
      doc.dialog.fire("click");
      assert.equal(map.focused, 2);
    });
  });

  test("starts by itself only where there is a document", () => {
    for (const [globals, starts] of [
      [["document", "navigator"], true],
      [["navigator"], false],
      [["document"], false],
    ]) {
      let reads = 0;
      const context = vm.createContext({});
      if (globals.includes("document")) context.document = page();
      if (globals.includes("navigator")) {
        context.navigator = {
          get userAgent() {
            reads += 1;
            return UA.linuxFirefox;
          },
        };
      }
      vm.runInContext(CODE, context, { filename: "site.js" });
      assert.equal(reads > 0, starts, globals.join(" and "));
    }
  });
});
