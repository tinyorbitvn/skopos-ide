//! What `api_schema` gives the UI: one kind's fields, from the cluster's OpenAPI v3 (spec L11).

use serde::Serialize;
use ts_rs::TS;

/// One kind's API docs: its description and its fields, A to Z at each level.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct KindSchema {
    /// As asked: `v1` or `apps/v1`.
    pub api_version: String,
    pub kind: String,
    pub description: String,
    pub fields: Vec<SchemaField>,
    /// True when the tree stopped at 20,000 fields.
    pub truncated: bool,
}

/// One field and, for an object, a map or a list of objects, the fields under it.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SchemaField {
    pub name: String,
    /// `string`, `[]Container`, `map[string]string`, `int-or-string`, `object`, `any`, or a
    /// referenced type's short name such as `DeploymentSpec`.
    pub type_label: String,
    pub required: bool,
    pub description: String,
    /// The short name of the type that holds the field, or the kind at the top.
    pub owner: String,
    pub format: Option<String>,
    pub enum_values: Vec<String>,
    pub default_value: Option<serde_json::Value>,
    /// The field's type is one of its ancestors' types, so its fields are not repeated.
    pub recursive: bool,
    pub children: Vec<SchemaField>,
}
