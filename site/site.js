/*
 * Points the hero's and the call to action's Download buttons at the installer for the
 * visitor's system, and marks that system's card in the download section. The page works
 * without this script: both buttons then lead to the download section and no card is marked.
 * The targets come from the download section's own links; nothing is fetched. It also opens
 * the feature pictures larger in a dialog (initLightbox).
 */
(function (global) {
  "use strict";

  const MOBILE = /Android|iPhone|iPad|iPod|CrOS|Mobile/i;

  // "mac", "windows", "linux", or null when no installer fits: phones, tablets,
  // ChromeOS and unknown systems.
  function detectOs(nav) {
    const ua = String(nav?.userAgent ?? "");
    const data = nav?.userAgentData;
    const platform = String(data?.platform || nav?.platform || "");
    if (MOBILE.test(ua) || data?.mobile) return null;
    if (/Chrome OS|CrOS/i.test(platform)) return null;
    if (/Mac/i.test(platform) || /Macintosh/.test(ua)) {
      // iPadOS asks for the desktop site with a Mac user agent; only touch tells it apart.
      return (nav.maxTouchPoints ?? 0) > 1 ? null : "mac";
    }
    if (/Win/i.test(platform) || /Windows/.test(ua)) return "windows";
    if (/Linux/i.test(platform) || /Linux|X11/.test(ua)) return "linux";
    return null;
  }

  // Resolves to "arm", "x86" or null. Chromium browsers report the architecture through
  // userAgentData; the others only through the user agent, where macOS always says Intel.
  function detectArch(nav) {
    const data = nav?.userAgentData;
    if (data && typeof data.getHighEntropyValues === "function") {
      return Promise.resolve()
        .then(() => data.getHighEntropyValues(["architecture"]))
        .then(
          (values) => {
            const arch = values?.architecture;
            return arch === "arm" || arch === "x86" ? arch : null;
          },
          () => null,
        );
    }
    const ua = String(nav?.userAgent ?? "");
    if (/Macintosh/.test(ua)) return Promise.resolve(null);
    if (/aarch64|arm64|armv\d/i.test(ua)) return Promise.resolve("arm");
    if (/x86_64|x64|amd64|Win64|WOW64|i686/i.test(ua)) return Promise.resolve("x86");
    return Promise.resolve(null);
  }

  function pickDownload(os, arch) {
    if (os === "mac") {
      return arch === "x86"
        ? {
            label: "macOS",
            primary: "x64.dmg",
            alt: { text: "Apple silicon? ", link: "Download the arm64 dmg", asset: "aarch64.dmg" },
          }
        : {
            label: "macOS",
            primary: "aarch64.dmg",
            alt: { text: "Intel Mac? ", link: "Download the x64 dmg", asset: "x64.dmg" },
          };
    }
    if (os === "windows") return { label: "Windows", primary: "x64-setup.exe", alt: null };
    if (os === "linux" && arch !== "arm") {
      return {
        label: "Linux",
        primary: "amd64.AppImage",
        alt: { text: "Debian or Ubuntu? ", link: "Download the .deb", asset: "amd64.deb" },
      };
    }
    return null;
  }

  // Shows the visitor's card as theirs and turns its picked installer into the white pill.
  function markCard(doc, os, link) {
    const card = doc.querySelector(`.platform[data-os="${os}"]`);
    if (card) {
      card.classList.add("platform--mine");
      const tag = card.querySelector(".platform__tag");
      if (tag) tag.hidden = false;
    }
    link.classList.remove("button--line");
    link.classList.add("button--primary");
  }

  function init(doc, nav) {
    const os = detectOs(nav);
    if (!os) return Promise.resolve(null);
    return detectArch(nav).then((arch) => {
      const pick = pickDownload(os, arch);
      const link = (suffix) => doc.querySelector(`#download a[data-asset="${suffix}"]`);
      const target = pick && link(pick.primary);
      if (!target) return null;
      for (const each of [doc.getElementById("hero-download"), doc.getElementById("cta-download")]) {
        if (!each) continue;
        each.setAttribute("href", target.getAttribute("href"));
        const label = each.querySelector("[data-label]");
        if (label) label.textContent = `Download for ${pick.label}`;
      }
      const file = doc.getElementById("hero-file");
      if (file) {
        file.textContent = ` · ${target.getAttribute("data-name")} · ${target.getAttribute("data-size")}`;
      }
      const box = doc.getElementById("hero-alt");
      const other = pick.alt && link(pick.alt.asset);
      if (box && other) {
        box.textContent = pick.alt.text;
        const a = doc.createElement("a");
        a.setAttribute("href", other.getAttribute("href"));
        a.textContent = pick.alt.link;
        box.appendChild(a);
        box.hidden = false;
      }
      markCard(doc, os, target);
      return pick;
    });
  }

  // Lets each feature picture open larger in the page's #lightbox dialog, on a click or on
  // Enter or Space, with its alt text as the caption. Escape, the close button or a click
  // beside the picture closes it and gives the focus back to the picture. Without the script,
  // or without dialog support, the pictures stay as they are. Returns how many it set up.
  function initLightbox(doc) {
    const dialog = doc.getElementById("lightbox");
    if (!dialog || typeof dialog.showModal !== "function") return 0;
    const pictures = Array.from(doc.querySelectorAll(".card__media img"));
    if (pictures.length === 0) return 0;
    const figure = dialog.querySelector(".lightbox__figure");
    const caption = dialog.querySelector(".lightbox__caption");
    const big = doc.createElement("img");
    big.className = "lightbox__img";
    figure.insertBefore(big, caption);
    let opener = null;
    const open = (picture) => {
      const alt = picture.getAttribute("alt") || "";
      opener = picture;
      big.setAttribute("src", picture.currentSrc || picture.getAttribute("src"));
      big.setAttribute("alt", alt);
      caption.textContent = alt;
      dialog.showModal();
    };
    for (const picture of pictures) {
      picture.setAttribute("tabindex", "0");
      picture.setAttribute("role", "button");
      picture.setAttribute("aria-haspopup", "dialog");
      picture.setAttribute("aria-label", `Enlarge: ${picture.getAttribute("alt") || "picture"}`);
      picture.addEventListener("click", () => open(picture));
      picture.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open(picture);
      });
    }
    dialog.querySelector(".lightbox__close").addEventListener("click", () => dialog.close());
    // The dialog covers the window, so a click beside the picture lands on the dialog itself.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (opener) opener.focus();
    });
    return pictures.length;
  }

  global.SkoposSite = { detectOs, detectArch, pickDownload, init, initLightbox };
  if (typeof document !== "undefined" && typeof navigator !== "undefined") {
    init(document, navigator);
    initLightbox(document);
  }
})(globalThis);
