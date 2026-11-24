.PHONY: check ui-build build dev fmt e2e-build e2e e2e-smoke e2e-screens test-kind test-argocd test-metrics release site site-screens audit sbom
ifeq ($(shell uname -s),Linux)
XVFB := xvfb-run -a --server-args="-screen 0 1600x1000x24"
XVFB_SCREENS := xvfb-run -a --server-args="-screen 0 2048x1280x24"
else
XVFB :=
XVFB_SCREENS :=
endif
# The release SBOM (docs/releasing.md, "SBOM"). Both workflows install this version too.
CARGO_CYCLONEDX_VERSION := 0.5.10
SBOM_TARGETS := x86_64-unknown-linux-gnu aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc
ui-build:
	pnpm install --frozen-lockfile
	pnpm -C ui build
check: ui-build
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --workspace
	git diff --exit-code -- ui/src/ipc/generated && test -z "$$(git ls-files --others --exclude-standard -- ui/src/ipc/generated)"
	pnpm -C ui typecheck
	pnpm -C ui lint
	pnpm -C ui test
	node --test scripts/*.test.mjs e2e/helpers/*.test.ts
	scripts/check-provenance.sh
build:
	pnpm tauri build --config crates/skopos-app/tauri.conf.json
dev:
	pnpm tauri dev --config crates/skopos-app/tauri.conf.json
fmt:
	cargo fmt --all
	pnpm -C ui exec biome check --write .
e2e-build:
	VITE_E2E=1 pnpm tauri build --debug --no-bundle --features e2e --config crates/skopos-app/tauri.conf.json --config crates/skopos-app/tauri.e2e.conf.json
e2e: e2e-build
	scripts/kind-up.sh
	cargo build -p skopos-fakekube
	cargo build -p skopos-core --bin skopos-fakeagent
	SKOPOS_E2E_SPEC_SET=full $(XVFB) pnpm -C e2e exec wdio run wdio.conf.ts
test-kind:
	scripts/kind-up.sh
	cargo test -p skopos-core --test 'kind_*' -- --ignored --test-threads=1
test-argocd:
	scripts/kind-up.sh
	scripts/argocd-up.sh
	cargo test -p skopos-core --test 'argocd_*' -- --ignored --test-threads=1; \
	  status=$$?; scripts/argocd-down.sh; exit $$status

test-metrics:
	scripts/kind-up.sh
	scripts/metrics-up.sh
	cargo test -p skopos-core --test 'metrics_*' -- --ignored --test-threads=1; \
	  status=$$?; scripts/metrics-down.sh; exit $$status

e2e-smoke: e2e-build
	cargo build -p skopos-fakekube
	SKOPOS_E2E_SPEC_SET=smoke $(XVFB) pnpm -C e2e exec wdio run wdio.conf.ts
e2e-screens: e2e-build
	scripts/kind-up.sh
	cargo build -p skopos-fakekube
	SKOPOS_E2E_SPEC_SET=screens $(XVFB_SCREENS) pnpm -C e2e exec wdio run wdio.conf.ts
site:
	node scripts/build-site.mjs --out tmp/site
site-screens:
	node scripts/canvas-screens.mjs --canvas tmp/canvas --out site/images
release:
	scripts/release.sh bump $(VERSION)
# Open Dependabot alerts against the advisory policy (docs/releasing.md); needs gh auth.
audit:
	mkdir -p tmp/advisories
	gh api --paginate --jq '.[]' \
	  "repos/$$(gh repo view --json nameWithOwner --jq .nameWithOwner)/dependabot/alerts?state=open&per_page=100" \
	  > tmp/advisories/alerts.ndjson
	node scripts/advisories.mjs alerts --file tmp/advisories/alerts.ndjson

# cargo cyclonedx writes <name>.json beside every workspace member's Cargo.toml; only
# skopos-app's is kept.
sbom:
	@cargo cyclonedx --version 2>/dev/null | grep -qE ' $(subst .,\.,$(CARGO_CYCLONEDX_VERSION))$$' || \
	  { echo "make sbom needs cargo-cyclonedx $(CARGO_CYCLONEDX_VERSION): cargo install --locked cargo-cyclonedx@$(CARGO_CYCLONEDX_VERSION)" >&2; exit 1; }
	pnpm install --frozen-lockfile
	rm -rf tmp/sbom && mkdir -p tmp/sbom
	for target in $(SBOM_TARGETS); do \
	  cargo cyclonedx --manifest-path crates/skopos-app/Cargo.toml --format json --spec-version 1.6 \
	    --target $$target --override-filename sbom-$$target && \
	  mv crates/skopos-app/sbom-$$target.json tmp/sbom/ && \
	  rm -f crates/*/sbom-$$target.json || exit 1; \
	done
	pnpm --filter ./ui list --prod --depth Infinity --json > tmp/sbom/ui.json
	node scripts/sbom.mjs merge $(foreach t,$(SBOM_TARGETS),--rust $(t)=tmp/sbom/sbom-$(t).json) \
	  --ui tmp/sbom/ui.json --lock pnpm-lock.yaml --out tmp/sbom/SkoposIDE.cdx.json
