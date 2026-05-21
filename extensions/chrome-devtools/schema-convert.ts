// src/schema-convert.ts
import { Type, type TObject, type TSchema } from "typebox";
import type { JsonSchemaProperty } from "./mcp-client.js";

/**
 * Convert a JSON Schema object (with optional "properties" and "required" arrays)
 * into a TypeBox TObject. Returns a plain TObject for parameterless tools.
 */
export function jsonSchemaToTypeBox(
  schema: { properties?: Record<string, JsonSchemaProperty>; required?: string[] } | undefined,
): TObject {
  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
    return Type.Object({});
  }

  const required = new Set(schema.required || []);
  const props: Record<string, TSchema> = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    const converted = convertProperty(prop);
    props[key] = required.has(key) ? converted : Type.Optional(converted);
  }

  return Type.Object(props);
}

function convertProperty(prop: JsonSchemaProperty): TSchema {
  const type = prop.type || "string";

  switch (type) {
    case "string":
      if (prop.enum && prop.enum.length > 0) {
        return Type.String({ description: prop.description });
      }
      return Type.String(prop.description ? { description: prop.description } : {});

    case "number":
      return Type.Number(prop.description ? { description: prop.description } : {});

    case "boolean":
      return Type.Boolean(prop.description ? { description: prop.description } : {});

    case "array":
      if (prop.items) {
        const itemSchema = convertProperty(prop.items);
        return Type.Array(itemSchema, prop.description ? { description: prop.description } : {});
      }
      return Type.Array(Type.Unknown(), prop.description ? { description: prop.description } : {});

    case "object":
      if (prop.properties) {
        const nestedRequired = new Set(prop.required || []);
        const props: Record<string, TSchema> = {};
        for (const [key, value] of Object.entries(prop.properties)) {
          const converted = convertProperty(value);
          props[key] = nestedRequired.has(key) ? converted : Type.Optional(converted);
        }
        return Type.Object(props, prop.description ? { description: prop.description } : {});
      }
      return Type.Object({}, prop.description ? { description: prop.description } : {});

    default:
      return Type.String({ description: prop.description || `Type: ${type}` });
  }
}
