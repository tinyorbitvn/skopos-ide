//! One kind's field tree from a group version's OpenAPI v3 document (spec L4, L7 to L10).

use std::collections::BTreeSet;

use serde_json::{Map, Value};

use super::types::{KindSchema, SchemaField};
use super::Target;

/// The most fields one tree holds, counted depth first (spec L10).
pub(crate) const MAX_FIELDS: usize = 20_000;

const REF_PREFIX: &str = "#/components/schemas/";
const GVK: &str = "x-kubernetes-group-version-kind";

/// What a missing `items` reads as.
static EMPTY: Value = Value::Null;

/// The schema whose `x-kubernetes-group-version-kind` list holds the target, as a tree; `None`
/// when the document has none (spec L4).
pub(crate) fn kind_schema(document: &Value, target: &Target) -> Option<KindSchema> {
    let schemas = document.pointer("/components/schemas")?.as_object()?;
    let (key, root) = schemas.iter().find(|(_, schema)| lists(schema, target))?;
    let mut builder = Builder {
        schemas,
        count: 0,
        truncated: false,
        path: vec![key.clone()],
    };
    let fields = builder.fields(root, &target.kind);
    Some(KindSchema {
        api_version: target.api_version.clone(),
        kind: target.kind.clone(),
        description: text(root, "description").to_owned(),
        fields,
        truncated: builder.truncated,
    })
}

/// True when the schema's group-version-kind list holds the target; a missing group is the
/// core group "".
fn lists(schema: &Value, target: &Target) -> bool {
    let Some(entries) = schema.get(GVK).and_then(Value::as_array) else {
        return false;
    };
    entries.iter().any(|entry| {
        text(entry, "group") == target.group
            && text(entry, "version") == target.version
            && text(entry, "kind") == target.kind
    })
}

/// The schema key that a `$ref`, or an `allOf` of exactly one `$ref`, points at (spec L7).
fn reference(schema: &Value) -> Option<&str> {
    let pointer = match schema.get("$ref") {
        Some(pointer) => pointer,
        None => match schema.get("allOf")?.as_array()?.as_slice() {
            [only] => only.get("$ref")?,
            _ => return None,
        },
    };
    pointer.as_str()?.strip_prefix(REF_PREFIX)
}

struct Builder<'a> {
    schemas: &'a Map<String, Value>,
    /// Fields built so far, depth first.
    count: usize,
    truncated: bool,
    /// The schema keys from the kind down to the field being built (spec L9).
    path: Vec<String>,
}

/// A type label and the fields under it.
struct Described {
    label: String,
    children: Vec<SchemaField>,
    recursive: bool,
}

fn leaf(label: &str) -> Described {
    Described {
        label: label.to_owned(),
        children: Vec::new(),
        recursive: false,
    }
}

impl<'a> Builder<'a> {
    /// The schema a field references, or `null` when it references none or a missing one.
    fn target(&self, schema: &Value) -> &'a Value {
        let schemas = self.schemas;
        reference(schema)
            .and_then(|key| schemas.get(key))
            .unwrap_or(&EMPTY)
    }

    /// An object schema's fields, A to Z, until the tree holds `MAX_FIELDS` (spec L7, L10).
    fn fields(&mut self, holder: &'a Value, owner: &str) -> Vec<SchemaField> {
        let Some(properties) = holder.get("properties").and_then(Value::as_object) else {
            return Vec::new();
        };
        let required: BTreeSet<&str> = holder
            .get("required")
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut names: Vec<&'a String> = properties.keys().collect();
        names.sort();
        let mut fields = Vec::with_capacity(names.len());
        for name in names {
            if self.count >= MAX_FIELDS {
                self.truncated = true;
                break;
            }
            self.count += 1;
            let required = required.contains(name.as_str());
            fields.push(self.field(name, &properties[name], required, owner));
        }
        fields
    }

    /// One field: its own schema first, then the schema it references (spec L7).
    fn field(&mut self, name: &str, own: &'a Value, required: bool, owner: &str) -> SchemaField {
        let target = self.target(own);
        let described = self.describe(own, owner);
        SchemaField {
            name: name.to_owned(),
            type_label: described.label,
            required,
            description: first_text(own, target, "description"),
            owner: owner.to_owned(),
            format: first(own, target, "format")
                .and_then(Value::as_str)
                .map(str::to_owned),
            enum_values: first(own, target, "enum")
                .and_then(Value::as_array)
                .map(|values| values.iter().map(enum_text).collect())
                .unwrap_or_default(),
            default_value: first(own, target, "default")
                .filter(|value| !is_blank(value))
                .cloned(),
            recursive: described.recursive,
            children: described.children,
        }
    }

    /// The type label and the fields under it (spec L8, L9). `owner` holds the fields of an
    /// inline object; a referenced type holds its own.
    fn describe(&mut self, schema: &'a Value, owner: &str) -> Described {
        if int_or_string(schema) {
            return leaf("int-or-string");
        }
        let Some(key) = reference(schema) else {
            return self.by_type(schema, owner);
        };
        let short = short_name(key);
        let schemas = self.schemas;
        let Some(target) = schemas.get(key) else {
            // A reference to a schema the document lacks keeps the field, named, with
            // nothing under it.
            return leaf(short);
        };
        if int_or_string(target) {
            return leaf("int-or-string");
        }
        let has_fields = target.get("properties").is_some_and(Value::is_object);
        if !has_fields && target.get("oneOf").is_some() {
            return leaf(short);
        }
        if self.path.iter().any(|seen| seen == key) {
            return Described {
                label: short.to_owned(),
                children: Vec::new(),
                recursive: true,
            };
        }
        self.path.push(key.to_owned());
        let described = if has_fields {
            Described {
                label: short.to_owned(),
                children: self.fields(target, short),
                recursive: false,
            }
        } else {
            self.by_type(target, short)
        };
        self.path.pop();
        described
    }

    /// The label by `type`, for a schema that references nothing (spec L8).
    fn by_type(&mut self, schema: &'a Value, owner: &str) -> Described {
        match schema.get("type").and_then(Value::as_str) {
            Some(scalar @ ("string" | "integer" | "number" | "boolean")) => leaf(scalar),
            Some("array") => {
                let items = self.describe(schema.get("items").unwrap_or(&EMPTY), owner);
                Described {
                    label: format!("[]{}", items.label),
                    ..items
                }
            }
            Some("object") => self.object(schema, owner),
            None if preserves_unknown(schema) => self.object(schema, owner),
            _ => leaf("any"),
        }
    }

    /// A map is `map[string]` and its values' label; any other object shows its own fields
    /// (spec L8).
    fn object(&mut self, schema: &'a Value, owner: &str) -> Described {
        match schema.get("additionalProperties") {
            Some(values) if values.is_object() => {
                let inner = self.describe(values, owner);
                Described {
                    label: format!("map[string]{}", inner.label),
                    ..inner
                }
            }
            Some(Value::Bool(true)) => leaf("map[string]any"),
            _ => Described {
                label: "object".to_owned(),
                children: self.fields(schema, owner),
                recursive: false,
            },
        }
    }
}

/// `IntOrString` and the CRD fields marked `x-kubernetes-int-or-string`.
fn int_or_string(schema: &Value) -> bool {
    text(schema, "format") == "int-or-string"
        || schema
            .get("x-kubernetes-int-or-string")
            .and_then(Value::as_bool)
            == Some(true)
}

fn preserves_unknown(schema: &Value) -> bool {
    schema
        .get("x-kubernetes-preserve-unknown-fields")
        .and_then(Value::as_bool)
        == Some(true)
}

/// `io.k8s.api.core.v1.Container` reads `Container` (spec L7).
fn short_name(key: &str) -> &str {
    key.rsplit('.').next().unwrap_or(key)
}

/// A string member, or "" when it is missing or not a string.
fn text<'v>(schema: &'v Value, name: &str) -> &'v str {
    schema.get(name).and_then(Value::as_str).unwrap_or("")
}

/// The field's own value of `name`, else the referenced schema's.
fn first<'v>(own: &'v Value, target: &'v Value, name: &str) -> Option<&'v Value> {
    own.get(name).or_else(|| target.get(name))
}

/// The field's own non-empty text, else the referenced schema's (spec L7).
fn first_text(own: &Value, target: &Value, name: &str) -> String {
    let own_text = text(own, name);
    let chosen = if own_text.trim().is_empty() {
        text(target, name)
    } else {
        own_text
    };
    chosen.to_owned()
}

/// `{}`, `[]` and `""` say nothing as a default (spec L7).
fn is_blank(value: &Value) -> bool {
    match value {
        Value::Object(members) => members.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::String(text) => text.is_empty(),
        _ => false,
    }
}

/// An enum value as text: a string as it is, anything else as JSON (spec L7).
fn enum_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn document() -> Value {
        serde_json::from_str(include_str!("testdata/document.json")).unwrap()
    }

    fn schema_of(api_version: &str, kind: &str) -> Option<KindSchema> {
        kind_schema(&document(), &Target::parse(api_version, kind).unwrap())
    }

    fn gizmo() -> KindSchema {
        schema_of("gizmos.example.com/v1", "Gizmo").unwrap()
    }

    fn names(fields: &[SchemaField]) -> Vec<&str> {
        fields.iter().map(|field| field.name.as_str()).collect()
    }

    /// The field at a dotted path of names, such as `spec.parts.name`.
    fn field<'f>(fields: &'f [SchemaField], path: &str) -> &'f SchemaField {
        let mut level = fields;
        let mut found = None;
        for name in path.split('.') {
            let next = level
                .iter()
                .find(|field| field.name == name)
                .unwrap_or_else(|| panic!("no {name} on the way to {path}"));
            level = &next.children;
            found = Some(next);
        }
        found.expect("a path names at least one field")
    }

    fn count(fields: &[SchemaField]) -> usize {
        fields.iter().map(|field| 1 + count(&field.children)).sum()
    }

    #[test]
    fn finds_the_schema_by_group_version_and_kind() {
        assert_eq!(gizmo().description, "A Gizmo for tests.");
        assert_eq!(
            schema_of("gizmos.example.com/v2", "Gizmo")
                .unwrap()
                .description,
            "The decoy in another version."
        );
        let thing = schema_of("v1", "Thing").unwrap();
        assert_eq!(
            (thing.api_version.as_str(), thing.kind.as_str()),
            ("v1", "Thing")
        );
        assert!(schema_of("gizmos.example.com/v1", "Widget").is_none());
        assert!(schema_of("other.example.com/v1", "Gizmo").is_none());
        let no_schemas = json!({ "paths": {} });
        assert!(kind_schema(&no_schemas, &Target::parse("v1", "Thing").unwrap()).is_none());
    }

    #[test]
    fn fields_come_a_to_z_at_every_level() {
        let gizmo = gizmo();
        assert_eq!(
            names(&gizmo.fields),
            ["apiVersion", "kind", "metadata", "spec", "status"]
        );
        assert_eq!(
            names(&field(&gizmo.fields, "spec").children),
            [
                "anything", "byName", "count", "crdPort", "created", "dangling", "enabled", "free",
                "inline", "levels", "loose", "mixed", "note", "parent", "parts", "policy", "port",
                "ratio", "raw", "size", "tags",
            ]
        );
        assert_eq!(
            names(&field(&gizmo.fields, "spec.inline").children),
            ["alpha", "zeta"]
        );
    }

    #[test]
    fn a_reference_resolves_and_the_property_description_wins() {
        let gizmo = gizmo();
        let metadata = field(&gizmo.fields, "metadata");
        assert_eq!(metadata.type_label, "ObjectMeta");
        assert_eq!(metadata.description, "Standard object metadata.");
        assert_eq!(names(&metadata.children), ["labels", "name"]);
        let status = field(&gizmo.fields, "status");
        assert_eq!(status.type_label, "GizmoStatus");
        assert_eq!(status.description, "What the Gizmo is.");
        let created = field(&gizmo.fields, "spec.created");
        assert_eq!(created.description, "When it was made.");
        assert_eq!(created.type_label, "string");
        assert_eq!(created.format.as_deref(), Some("date-time"));
        assert_eq!(
            field(&gizmo.fields, "spec.port").description,
            "A number or a string."
        );
    }

    #[test]
    fn required_comes_from_the_parent_and_owner_names_the_holder() {
        let gizmo = gizmo();
        let check = |path: &str, required: bool, owner: &str| {
            let found = field(&gizmo.fields, path);
            assert_eq!(
                (found.required, found.owner.as_str()),
                (required, owner),
                "{path}"
            );
        };
        check("spec", true, "Gizmo");
        check("status", false, "Gizmo");
        check("spec.size", true, "GizmoSpec");
        check("spec.parts", true, "GizmoSpec");
        check("spec.count", false, "GizmoSpec");
        check("spec.inline.alpha", false, "GizmoSpec");
        check("spec.parts.name", true, "Part");
        check("spec.parts.weight", false, "Part");
        check("spec.byName.name", true, "Part");
        check("metadata.labels", false, "ObjectMeta");
    }

    #[test]
    fn format_enum_and_default_are_copied_unless_blank() {
        let gizmo = gizmo();
        let counted = field(&gizmo.fields, "spec.count");
        assert_eq!(counted.format.as_deref(), Some("int32"));
        assert_eq!(counted.default_value, Some(json!(1)));
        assert_eq!(
            field(&gizmo.fields, "spec.enabled").default_value,
            Some(json!(false))
        );
        for blank in ["spec.note", "spec.tags", "metadata", "spec"] {
            assert_eq!(field(&gizmo.fields, blank).default_value, None, "{blank}");
        }
        assert_eq!(
            field(&gizmo.fields, "spec.policy").enum_values,
            ["Always", "IfNotPresent", "Never"]
        );
        assert_eq!(
            field(&gizmo.fields, "spec.parts.weight").enum_values,
            ["1", "2"]
        );
        assert_eq!(
            field(&gizmo.fields, "spec.port").format.as_deref(),
            Some("int-or-string")
        );
        assert!(field(&gizmo.fields, "spec.policy")
            .description
            .contains("\n\nPossible enum values"));
    }

    #[test]
    fn each_kind_of_type_gets_its_label() {
        let gizmo = gizmo();
        let expected = [
            ("spec.anything", "any", 0),
            ("spec.byName", "map[string]Part", 2),
            ("spec.count", "integer", 0),
            ("spec.crdPort", "int-or-string", 0),
            ("spec.created", "string", 0),
            ("spec.enabled", "boolean", 0),
            ("spec.free", "object", 0),
            ("spec.inline", "object", 2),
            ("spec.levels", "[][]string", 0),
            ("spec.loose", "object", 0),
            ("spec.parent", "Node", 2),
            ("spec.parts", "[]Part", 2),
            ("spec.policy", "string", 0),
            ("spec.port", "int-or-string", 0),
            ("spec.ratio", "number", 0),
            ("spec.raw", "object", 1),
            ("spec.size", "Quantity", 0),
            ("spec.tags", "[]string", 0),
            ("metadata.labels", "map[string]string", 0),
        ];
        for (path, label, children) in expected {
            let found = field(&gizmo.fields, path);
            assert_eq!(
                (found.type_label.as_str(), found.children.len()),
                (label, children),
                "{path}"
            );
        }
    }

    #[test]
    fn a_reference_to_a_missing_schema_keeps_the_field() {
        let gizmo = gizmo();
        let dangling = field(&gizmo.fields, "spec.dangling");
        assert_eq!(dangling.type_label, "Missing");
        assert!(dangling.children.is_empty());
        assert!(!dangling.recursive);
        assert_eq!(dangling.description, "Points at nothing.");
    }

    #[test]
    fn all_of_with_inline_properties_shows_the_referenced_fields() {
        let gizmo = gizmo();
        let mixed = field(&gizmo.fields, "spec.mixed");
        assert_eq!(mixed.type_label, "Part");
        assert_eq!(names(&mixed.children), ["name", "weight"]);
        assert_eq!(mixed.description, "The property's words.");
        assert_eq!(mixed.children[1].description, "Weight from the type.");
    }

    #[test]
    fn a_type_already_on_the_path_is_recursive() {
        let gizmo = gizmo();
        assert!(!field(&gizmo.fields, "spec.parent").recursive);
        let next = field(&gizmo.fields, "spec.parent.next");
        assert_eq!(next.type_label, "Node");
        assert!(next.recursive);
        assert!(next.children.is_empty());
    }

    /// 150 top-level references to a schema of 150 strings: 22,650 fields in all.
    fn wide_document() -> Value {
        let leaves: Map<String, Value> = (0..150)
            .map(|at| (format!("v{at:03}"), json!({ "type": "string" })))
            .collect();
        let tops: Map<String, Value> = (0..150)
            .map(|at| {
                (
                    format!("f{at:03}"),
                    json!({ "$ref": "#/components/schemas/io.example.v1.Leafy" }),
                )
            })
            .collect();
        json!({ "components": { "schemas": {
            "io.example.v1.Wide": {
                "type": "object",
                "properties": tops,
                "x-kubernetes-group-version-kind": [{ "group": "", "version": "v1", "kind": "Wide" }],
            },
            "io.example.v1.Leafy": { "type": "object", "properties": leaves },
        } } })
    }

    #[test]
    fn the_tree_stops_at_twenty_thousand_fields_depth_first() {
        let wide = kind_schema(&wide_document(), &Target::parse("v1", "Wide").unwrap()).unwrap();
        assert!(wide.truncated);
        assert_eq!(count(&wide.fields), MAX_FIELDS);
        // 132 whole top-level fields of 151 each, then one with 67 of its 150 strings.
        assert_eq!(wide.fields.len(), 133);
        assert_eq!(wide.fields[131].children.len(), 150);
        assert_eq!(wide.fields[132].children.len(), 67);
        assert!(!gizmo().truncated);
    }
}
