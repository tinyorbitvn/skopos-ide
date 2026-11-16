//! `api_schema` against the `skopos-e2e` kind cluster (spec L30). Needs `make test-kind`;
//! only `e2e/.tmp/kubeconfig` is read.

mod support;

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::DeleteParams;
use kube::Api;
use skopos_core::app_core::AppCore;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::openapi::{KindSchema, SchemaField};

use support::connected_kind;

const GROUP_VERSION: &str = "skopos-test.example.com/v1";
const GADGETS: &str = "gadgets.skopos-test.example.com";
const WIDGETS: &str = "widgets.skopos-test.example.com";
const WAIT: Duration = Duration::from_secs(60);
/// How long a new CRD's schema may take to reach `/openapi/v3` (spec L30).
const PUBLISH_WAIT: Duration = Duration::from_secs(30);

const GADGET_CRD: &str = "\
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: gadgets.skopos-test.example.com
spec:
  group: skopos-test.example.com
  scope: Namespaced
  names:
    plural: gadgets
    singular: gadget
    kind: Gadget
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [size]
              properties:
                size:
                  type: integer
                  description: How big the gadget is.
                color:
                  type: string
                  enum: [red, blue]
";

const WIDGET_CRD: &str = "\
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.skopos-test.example.com
spec:
  group: skopos-test.example.com
  scope: Namespaced
  names:
    plural: widgets
    singular: widget
    kind: Widget
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          x-kubernetes-preserve-unknown-fields: true
";

/// The field at `path`, by names from the top.
fn field<'a>(fields: &'a [SchemaField], path: &[&str]) -> &'a SchemaField {
    let (first, rest) = path.split_first().expect("a path has a name");
    let found = fields
        .iter()
        .find(|field| field.name == *first)
        .unwrap_or_else(|| panic!("no field {first} among {:?}", names(fields)));
    if rest.is_empty() {
        found
    } else {
        field(&found.children, rest)
    }
}

fn names(fields: &[SchemaField]) -> Vec<&str> {
    fields.iter().map(|field| field.name.as_str()).collect()
}

async fn eventually<F, Fut>(what: &str, check: F)
where
    F: Fn() -> Fut,
    Fut: Future<Output = bool>,
{
    let started = Instant::now();
    while !check().await {
        assert!(started.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Asks for `kind` until the cluster publishes it, for up to `PUBLISH_WAIT`.
async fn published(core: &AppCore, id: &ClusterId, kind: &str) -> KindSchema {
    let started = Instant::now();
    loop {
        match core.api_schema(id, GROUP_VERSION, kind).await {
            Ok(schema) => return schema,
            Err(err) => assert!(
                started.elapsed() < PUBLISH_WAIT,
                "{kind} never reached /openapi/v3: {}",
                err.message
            ),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn established(crd: &CustomResourceDefinition) -> bool {
    crd.status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .is_some_and(|conditions| {
            conditions
                .iter()
                .any(|condition| condition.type_ == "Established" && condition.status == "True")
        })
}

/// Installs the CRD `name` from `yaml` with `resource_apply`, runs `body`, then removes the
/// CRD whether or not `body` failed.
async fn with_crd<Fut: Future<Output = ()>>(
    core: &AppCore,
    id: &ClusterId,
    name: &str,
    yaml: &str,
    body: Fut,
) {
    let crds: Api<CustomResourceDefinition> = Api::all(core.cluster_client(id).unwrap());
    let remove = || async {
        let _ = crds.delete(name, &DeleteParams::default()).await;
        eventually("the CRD to go", || async {
            crds.get_opt(name).await.unwrap().is_none()
        })
        .await;
    };
    remove().await;
    let results = core.resource_apply(id, yaml, "default").await.unwrap();
    assert!(results.iter().all(|result| result.ok), "{results:?}");
    eventually("the CRD to be established", || async {
        crds.get_opt(name)
            .await
            .unwrap()
            .as_ref()
            .is_some_and(established)
    })
    .await;
    let outcome = AssertUnwindSafe(body).catch_unwind().await;
    remove().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn deployment_and_config_map_docs_come_from_the_cluster() {
    let (core, id, _root) = connected_kind().await;

    let deployment = core.api_schema(&id, "apps/v1", "Deployment").await.unwrap();
    let spec = field(&deployment.fields, &["spec"]);
    assert_eq!(
        (spec.type_label.as_str(), spec.owner.as_str()),
        ("DeploymentSpec", "Deployment")
    );
    let containers = field(
        &deployment.fields,
        &["spec", "template", "spec", "containers"],
    );
    assert_eq!(containers.type_label, "[]Container");
    assert!(containers.required);
    let image = field(&containers.children, &["image"]);
    assert_eq!(
        (image.type_label.as_str(), image.owner.as_str()),
        ("string", "Container")
    );
    assert!(
        image.description.contains("Container image name"),
        "{}",
        image.description
    );
    let policy = field(&containers.children, &["imagePullPolicy"]);
    assert_eq!(policy.enum_values, ["Always", "IfNotPresent", "Never"]);

    let config_map = core.api_schema(&id, "v1", "ConfigMap").await.unwrap();
    assert_eq!(
        field(&config_map.fields, &["data"]).type_label,
        "map[string]string"
    );
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn a_crd_schema_shows_once_the_cluster_publishes_it() {
    let (core, id, _root) = connected_kind().await;

    with_crd(&core, &id, GADGETS, GADGET_CRD, async {
        let gadget = published(&core, &id, "Gadget").await;
        assert_eq!(gadget.api_version, GROUP_VERSION);
        let spec = field(&gadget.fields, &["spec"]);
        assert_eq!(spec.type_label, "object");
        let size = field(&spec.children, &["size"]);
        assert_eq!(
            (size.type_label.as_str(), size.required, size.owner.as_str()),
            ("integer", true, "Gadget")
        );
        assert_eq!(size.description, "How big the gadget is.");
        let color = field(&spec.children, &["color"]);
        assert_eq!(color.enum_values, ["red", "blue"]);
        assert!(!color.required);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn a_crd_that_keeps_unknown_fields_shows_only_the_standard_ones() {
    let (core, id, _root) = connected_kind().await;

    with_crd(&core, &id, WIDGETS, WIDGET_CRD, async {
        let widget = published(&core, &id, "Widget").await;
        assert_eq!(names(&widget.fields), ["apiVersion", "kind", "metadata"]);
    })
    .await;
}
