import { createHash } from "node:crypto";
import { types } from "node:util";

const MAX_SERIALIZATION_DEPTH = 100;

/**
 * Produces a deterministic, cycle-safe signature for a tool call.
 * Unsupported values are rejected rather than collapsed into an ambiguous value.
 */
export function callSignature(toolName, args) {
  if (typeof toolName !== "string") {
    throw new TypeError("toolName must be a string.");
  }

  return `${JSON.stringify(toolName)}::${stableStringify(args)}`;
}

const KNOWN_NATIVES = new Set([
  "Object", "Array", "Date", "RegExp", "Map", "Set",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "ArrayBuffer", "DataView"
]);

function trySerializeURL(value) {
  try {
    return URL.prototype.toString.call(value);
  } catch {
    return null;
  }
}

function trySerializeURLSearchParams(value) {
  try {
    return URLSearchParams.prototype.toString.call(value);
  } catch {
    return null;
  }
}

function findToStringTagDescriptor(prototype) {
  let current = prototype;

  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(
      current,
      Symbol.toStringTag
    );

    if (descriptor) {
      return descriptor;
    }

    current = Object.getPrototypeOf(current);
  }

  return null;
}

export function stableStringify(value) {
  const seen = new WeakMap();
  let nextId = 1;

  function encode(current, path, depth) {
    if (depth > MAX_SERIALIZATION_DEPTH) {
      throw new TypeError(
        `Value at ${path} exceeds the maximum supported nesting depth of ${MAX_SERIALIZATION_DEPTH}.`
      );
    }

    if (current === null) return "null";

    switch (typeof current) {
      case "undefined":
        return '{"$type":"undefined"}';
      case "string":
      case "boolean":
        return JSON.stringify(current);
      case "number":
        if (Number.isNaN(current)) return '{"$type":"number","value":"NaN"}';
        if (current === Infinity) return '{"$type":"number","value":"Infinity"}';
        if (current === -Infinity) return '{"$type":"number","value":"-Infinity"}';
        if (Object.is(current, -0)) return '{"$type":"number","value":"-0"}';
        return JSON.stringify(current);
      case "bigint":
        return `{"$type":"bigint","value":${JSON.stringify(current.toString())}}`;
      case "function":
      case "symbol":
        throw new TypeError(`Unsupported ${typeof current} value at ${path}.`);
      case "object":
        break;
      default:
        throw new TypeError(`Unsupported value at ${path}.`);
    }

    const existingId = seen.get(current);
    if (existingId !== undefined) return `{"$ref":${existingId}}`;

    const id = nextId++;
    seen.set(current, id);

    const prototype = Object.getPrototypeOf(current);

    let constructorName = "Object";
    let constructorFunction = Object;

    if (prototype !== null && prototype !== Object.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");

      if (
        !descriptor ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "function"
      ) {
        throw new TypeError(
          `Unsupported object prototype at ${path}.`
        );
      }

      constructorFunction = descriptor.value;
      constructorName = constructorFunction.name;
    }

    if (!constructorName) {
      throw new TypeError(`Unsupported object value at ${path}.`);
    }

    if (typeof constructorFunction === "function") {
      const ctorStr = Function.prototype.toString.call(constructorFunction);
      if (ctorStr.includes("[native code]")) {
        if (!KNOWN_NATIVES.has(constructorName)) {
          throw new TypeError(`Unsupported native built-in ${constructorName} at ${path}.`);
        }
      }
    }

    const ownKeys = Reflect.ownKeys(current);
    const stringKeys = ownKeys.filter((key) => typeof key === "string");

    function validateDataProperties(obj, keys, currentPath) {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError(`Unsupported accessor property at ${currentPath}.${key}.`);
        }
      }
    }

    const urlValue = trySerializeURL(current);
    if (urlValue !== null) {
      validateDataProperties(current, stringKeys, path);
      return `{"$id":${id},"$type":"URL","value":${JSON.stringify(
        urlValue
      )},"properties":${encodeProperties(current, stringKeys, path, depth)}}`;
    }

    const paramsValue = trySerializeURLSearchParams(current);
    if (paramsValue !== null) {
      validateDataProperties(current, stringKeys, path);
      return `{"$id":${id},"$type":"URLSearchParams","value":${JSON.stringify(
        paramsValue
      )},"properties":${encodeProperties(current, stringKeys, path, depth)}}`;
    }

    validateDataProperties(current, stringKeys, path);

    if (types.isDate(current)) {
      if (Number.isNaN(current.getTime())) {
        throw new TypeError(`Invalid Date value at ${path}.`);
      }
      return `{"$id":${id},"$type":"Date","value":${JSON.stringify(current.toISOString())},"properties":${encodeProperties(current, stringKeys, path, depth)}}`;
    }

    if (types.isRegExp(current)) {
      const extraKeys = stringKeys.filter((key) => key !== "lastIndex");
      return `{"$id":${id},"$type":"RegExp","source":${JSON.stringify(current.source)},"flags":${JSON.stringify(current.flags)},"lastIndex":${current.lastIndex},"properties":${encodeProperties(current, extraKeys, path, depth)}}`;
    }

    if (types.isMap(current) || types.isSet(current)) {
      throw new TypeError(`Unsupported ${constructorName} value at ${path}.`);
    }

    if (types.isDataView(current)) {
      throw new TypeError(`Unsupported DataView value at ${path}.`);
    }

    if (types.isTypedArray(current)) {
      const values = Array.from(current, (item, index) =>
        encode(item, `${path}[${index}]`, depth + 1)
      );
      const indexes = new Set(Array.from({ length: current.length }, (_, index) => String(index)));
      const extraKeys = stringKeys.filter((key) => !indexes.has(key));
      return `{"$id":${id},"$type":${JSON.stringify(constructorName)},"values":[${values.join(",")}],"properties":${encodeProperties(current, extraKeys, path, depth)}}`;
    }

    if (types.isAnyArrayBuffer(current)) {
      return `{"$id":${id},"$type":"ArrayBuffer","values":${JSON.stringify(Array.from(new Uint8Array(current)))},"properties":${encodeProperties(current, stringKeys, path, depth)}}`;
    }

    if (Array.isArray(current)) {
      const values = Array.from({ length: current.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        return descriptor
          ? encode(descriptor.value, `${path}[${index}]`, depth + 1)
          : '{"$type":"array-hole"}';
      });
      const indexes = new Set(Array.from({ length: current.length }, (_, index) => String(index)));
      const extraKeys = stringKeys.filter((key) => key !== "length" && !indexes.has(key));
      return `{"$id":${id},"$type":"Array","values":[${values.join(",")}],"properties":${encodeProperties(current, extraKeys, path, depth)}}`;
    }

    const tagDescriptor = findToStringTagDescriptor(prototype);
    if (tagDescriptor) {
      if (!("value" in tagDescriptor)) {
        throw new TypeError(
          `Unsupported Symbol.toStringTag accessor at ${path}.`
        );
      }

      throw new TypeError(
        `Unsupported built-in ${String(tagDescriptor.value)} at ${path}.`
      );
    }

    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new TypeError(`Unsupported symbol-keyed property at ${path}.`);
    }

    const entries = [...stringKeys].sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      return `${JSON.stringify(key)}:{"enumerable":${descriptor.enumerable},"value":${encode(descriptor.value, `${path}.${key}`, depth + 1)}}`;
    });
    return `{"$id":${id},"$type":${JSON.stringify(constructorName)},"values":{${entries.join(",")}}}`;
  }

  function encodeProperties(object, keys, path, depth) {
    const entries = [...keys].sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return `${JSON.stringify(key)}:{"enumerable":${descriptor.enumerable},"value":${encode(descriptor.value, `${path}.${key}`, depth + 1)}}`;
    });
    return `{${entries.join(",")}}`;
  }

  return encode(value, "$", 0);
}


/**
 * Uses SHA-256 to hash signatures that exceed the max length,
 * providing collision-resistant determinism for large payloads.
 */
export function hashSignature(str) {
  return createHash("sha256").update(str).digest("hex");
}
