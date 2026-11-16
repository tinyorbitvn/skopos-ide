import type { KindSchema } from "../ipc/generated/KindSchema";
import type { SchemaField } from "../ipc/generated/SchemaField";

/** A field: an optional string of `Thing`, unless `partial` says otherwise. */
export function schemaField(
  partial: Partial<SchemaField> & { name: string },
): SchemaField {
  return {
    typeLabel: "string",
    required: false,
    description: "",
    owner: "Thing",
    format: null,
    enumValues: [],
    defaultValue: null,
    recursive: false,
    children: [],
    ...partial,
  };
}

export function kindSchema(partial: Partial<KindSchema> = {}): KindSchema {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    description: "",
    fields: [],
    truncated: false,
    ...partial,
  };
}

const field = schemaField;

/** A Deployment's docs, cut down to 17 fields. */
export const DEPLOYMENT: KindSchema = kindSchema({
  apiVersion: "apps/v1",
  kind: "Deployment",
  description:
    "Deployment enables declarative updates for Pods and ReplicaSets.",
  fields: [
    field({ name: "apiVersion", owner: "Deployment" }),
    field({ name: "kind", owner: "Deployment" }),
    field({
      name: "metadata",
      typeLabel: "ObjectMeta",
      owner: "Deployment",
      description: "Standard object's metadata.",
      children: [
        field({
          name: "labels",
          typeLabel: "map[string]string",
          owner: "ObjectMeta",
        }),
        field({ name: "name", owner: "ObjectMeta" }),
      ],
    }),
    field({
      name: "spec",
      typeLabel: "DeploymentSpec",
      owner: "Deployment",
      description: "Specification of the desired behavior of the Deployment.",
      children: [
        field({
          name: "replicas",
          typeLabel: "integer",
          owner: "DeploymentSpec",
          format: "int32",
          defaultValue: 1,
          description: "Number of desired pods.",
        }),
        field({
          name: "selector",
          typeLabel: "LabelSelector",
          required: true,
          owner: "DeploymentSpec",
          children: [
            field({
              name: "matchLabels",
              typeLabel: "map[string]string",
              owner: "LabelSelector",
            }),
          ],
        }),
        field({
          name: "template",
          typeLabel: "PodTemplateSpec",
          required: true,
          owner: "DeploymentSpec",
          children: [
            field({
              name: "spec",
              typeLabel: "PodSpec",
              owner: "PodTemplateSpec",
              children: [
                field({
                  name: "containers",
                  typeLabel: "[]Container",
                  required: true,
                  owner: "PodSpec",
                  children: [
                    field({
                      name: "image",
                      owner: "Container",
                      description:
                        "Container image name.\nMore info: https://example.com/docs/images",
                    }),
                    field({
                      name: "imagePullPolicy",
                      owner: "Container",
                      enumValues: ["Always", "IfNotPresent", "Never"],
                    }),
                    field({ name: "name", required: true, owner: "Container" }),
                    field({
                      name: "ports",
                      typeLabel: "[]ContainerPort",
                      owner: "Container",
                      children: [
                        field({
                          name: "containerPort",
                          typeLabel: "integer",
                          required: true,
                          owner: "ContainerPort",
                          format: "int32",
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ],
});

/** A ConfigMap's docs, cut down to 5 fields. */
export const CONFIG_MAP: KindSchema = kindSchema({
  apiVersion: "v1",
  kind: "ConfigMap",
  description: "ConfigMap holds configuration data for pods to consume.",
  fields: [
    field({ name: "apiVersion", owner: "ConfigMap" }),
    field({ name: "data", typeLabel: "map[string]string", owner: "ConfigMap" }),
    field({ name: "kind", owner: "ConfigMap" }),
    field({
      name: "metadata",
      typeLabel: "ObjectMeta",
      owner: "ConfigMap",
      children: [field({ name: "name", owner: "ObjectMeta" })],
    }),
  ],
});

/** A CRD's docs with nested arrays, a map of objects and a field that refers back. */
export const GADGET: KindSchema = kindSchema({
  apiVersion: "gizmos.example.com/v1",
  kind: "Gadget",
  fields: [
    field({
      name: "spec",
      typeLabel: "object",
      owner: "Gadget",
      children: [
        field({
          name: "matrix",
          typeLabel: "[][]Cell",
          owner: "Gadget",
          children: [field({ name: "value", owner: "Cell" })],
        }),
        field({
          name: "parts",
          typeLabel: "map[string]object",
          owner: "Gadget",
          children: [
            field({ name: "size", typeLabel: "integer", owner: "Gadget" }),
          ],
        }),
        field({
          name: "self",
          typeLabel: "Gadget",
          owner: "Gadget",
          recursive: true,
        }),
      ],
    }),
  ],
});
