# Changelog

What changed in each SkoposIDE release. Add notes under Unreleased as changes land on main;
`make release VERSION=x.y.z` dates them, and the release workflow publishes them as the
release notes (see `docs/releasing.md`). Releases before 0.6.0 have their notes on the
[releases page](https://github.com/vanlongme/skopos-ide/releases).

## [Unreleased]

- **Metrics errors show:** when Prometheus, Mimir or metrics-server times out or answers 502, 503 or 504 while the cluster is connected, the Metrics tab and the Overview show the error with Retry instead of loading forever.

## [0.6.0] - 2026-11-16

- **New app icon and logo:** the TinyOrbit orbit mark, white on navy, replaces the old icon on Linux, macOS and Windows and in the About dialog.
- **Metrics from Grafana Mimir and other multi-tenant Prometheus APIs:** the "Prometheus or Mimir in the cluster" setting in Cluster settings gains:
  - **Scheme** (http or https) and **Path prefix**, such as `/prometheus` for Mimir;
  - **Tenant**, sent as the `X-Scope-OrgID` header; when Mimir answers "no org id", the app says that a tenant is needed;
  - **Cluster label**, a name and value added to every metrics query, for a Mimir or Prometheus that holds several clusters.
- **Metrics source line:** names the tenant and the cluster label in use. When a query answers with no samples, it says which setting to check; a query that fails is reported apart from one that comes back empty.
- **Details drawer:** in the Overview, Metadata comes right under Summary.
