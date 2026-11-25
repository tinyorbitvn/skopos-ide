# Microsoft Store listing

The text to paste into Partner Center for the first submission, and the answers it asks for.

## Product

- Name: SkoposIDE
- Category: Developer tools
- Price: Free, all markets
- Website: https://skopos-ide.app/
- Support: https://github.com/tinyorbitvn/skopos-ide/issues
- Privacy policy: https://skopos-ide.app/docs/privacy.html
- Copyright: Copyright Nguyen Van Long
- License terms: https://github.com/tinyorbitvn/skopos-ide/blob/main/LICENSE (PolyForm Shield 1.0.0)

## Short description

Desktop Kubernetes IDE: every kubeconfig in one catalog, live resource tables, logs, shells, Helm and Argo CD.

## Description

SkoposIDE is a desktop Kubernetes IDE. It reads your kubeconfig files, connects to several
clusters at once and lets you switch between them from a hotbar.

Each resource kind has a live table with its own columns, status badges and a filter on any
column. A details drawer, a YAML editor beside the API docs, cluster overviews, a resource map and
a node topology show what runs where. Logs, local terminals and Pod shells open in a dock; port
forwards bind to 127.0.0.1 only. Helm releases and Argo CD Applications have their own views, and
metrics come from Prometheus or metrics-server.

SkoposIDE runs on your computer with no account and no telemetry. It is source-available under
the PolyForm Shield License 1.0.0 and free for people and companies alike.

## Features

- Every kubeconfig file in one catalog, with folders and a hotbar
- Several clusters connected at once; one failing never affects another
- Live tables per resource kind with a filter on any column
- YAML editor beside the API docs of the kind
- Logs, local terminals and Pod shells in a dock
- Port forwards bound to 127.0.0.1 only
- Helm releases and Argo CD Applications
- Metrics from Prometheus or metrics-server
- Resource map and node topology
- Keyboard first, with a command palette

## Search terms

Kubernetes, kubectl, Helm, Argo CD, Kubernetes IDE, cluster, DevOps

## Screenshots

Run `flock -o tmp/e2e.lock make e2e-screens` and upload the light PNGs from `tmp/screens/`
(1920×1080): the catalog, the cluster overview, the Pods table with a Pod drawer, the dock with a
YAML tab and Preferences.

## Restricted capabilities

- `runFullTrust`: SkoposIDE is a Win32 desktop app. It runs the kubectl exec credential plugins
  the person configured, local terminals, and the helm and kubectl tools, which needs a
  full-trust desktop process.
- `unvirtualizedResources`: the app's terminals run the person's own command-line tools, such as
  kubectl, helm, az or gcloud. Their configuration and sign-in caches live under %APPDATA% and
  HKCU and must stay shared with the same tools outside the app and with the SkoposIDE build
  downloaded from GitHub. With write virtualization these writes would land in a private copy that
  the person's other tools never see.

## Age rating (IARC questionnaire)

A developer tool with no user-to-user interaction, no content sharing, no location, no purchases
and no web browsing: answer No to each content and interaction question.
