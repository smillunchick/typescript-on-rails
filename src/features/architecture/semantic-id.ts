export type SemanticIdCategory =
  | "feature"
  | "public-export"
  | "model"
  | "operation"
  | "route"
  | "event"
  | "adapter-contract"
  | "adapter-implementation";

export type SemanticIdOwnerKind = "feature" | "infra" | "app";

export interface SemanticIdOwner {
  readonly kind: SemanticIdOwnerKind;
  readonly name: string;
}

export interface SemanticId {
  readonly category: SemanticIdCategory;
  readonly owner: SemanticIdOwner;
  readonly localName: string;
}

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isSemanticIdCategory(value: string): value is SemanticIdCategory {
  switch (value) {
    case "feature":
    case "public-export":
    case "model":
    case "operation":
    case "route":
    case "event":
    case "adapter-contract":
    case "adapter-implementation":
      return true;
    default:
      return false;
  }
}

function isSemanticIdOwnerKind(value: string): value is SemanticIdOwnerKind {
  return value === "feature" || value === "infra" || value === "app";
}

function isUnreservedByte(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a)
    || (byte >= 0x61 && byte <= 0x7a)
    || (byte >= 0x30 && byte <= 0x39)
    || byte === 0x2d
    || byte === 0x2e
    || byte === 0x5f
    || byte === 0x7e;
}

function assertNonempty(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must be nonempty`);
  }
}

function assertNoLoneSurrogates(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new Error(`${label} contains a lone surrogate`);
      }
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new Error(`${label} contains a lone surrogate`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${label} contains a lone surrogate`);
    }
  }
}

function validateSemanticId(value: SemanticId): void {
  if (!isSemanticIdCategory(value.category)) {
    throw new Error(`Unknown semantic ID category: ${value.category}`);
  }
  if (!isSemanticIdOwnerKind(value.owner.kind)) {
    throw new Error(`Unknown semantic ID owner kind: ${value.owner.kind}`);
  }

  assertNonempty(value.owner.name, "Semantic ID owner name");
  assertNonempty(value.localName, "Semantic ID local name");
  assertNoLoneSurrogates(value.owner.name, "Semantic ID owner name");
  assertNoLoneSurrogates(value.localName, "Semantic ID local name");

  if (value.owner.kind === "feature" && value.owner.name === "_") {
    throw new Error("A feature semantic ID owner name cannot be _");
  }
  if (value.owner.kind !== "feature" && value.owner.name !== "_") {
    throw new Error(`${value.owner.kind} semantic ID owner name must be _`);
  }
}

function encodeSegment(value: string): string {
  let encoded = "";
  for (const byte of textEncoder.encode(value)) {
    if (isUnreservedByte(byte)) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

function hexValue(codeUnit: number): number {
  if (codeUnit >= 0x30 && codeUnit <= 0x39) return codeUnit - 0x30;
  if (codeUnit >= 0x41 && codeUnit <= 0x46) return codeUnit - 0x41 + 10;
  if (codeUnit >= 0x61 && codeUnit <= 0x66) return codeUnit - 0x61 + 10;
  return -1;
}

function decodeSegment(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x25) {
      if (index + 2 >= value.length) {
        throw new Error("Malformed semantic ID percent escape");
      }
      const high = hexValue(value.charCodeAt(index + 1));
      const low = hexValue(value.charCodeAt(index + 2));
      if (high < 0 || low < 0) {
        throw new Error("Malformed semantic ID percent escape");
      }
      bytes.push((high * 16) + low);
      index += 2;
    } else if (isUnreservedByte(codeUnit)) {
      bytes.push(codeUnit);
    } else {
      throw new Error("Semantic ID segment contains a noncanonical byte");
    }
  }
  return fatalTextDecoder.decode(new Uint8Array(bytes));
}

export function encodeSemanticId(value: SemanticId): string {
  validateSemanticId(value);
  return `sid1/${value.category}/${value.owner.kind}/${encodeSegment(value.owner.name)}/${encodeSegment(value.localName)}`;
}

export function decodeSemanticId(value: string): SemanticId {
  const segments = value.split("/");
  if (segments.length !== 5) {
    throw new Error("Semantic ID must contain exactly five segments");
  }

  const [prefix, category, ownerKind, encodedOwnerName, encodedLocalName] = segments;
  if (prefix !== "sid1") throw new Error("Unknown semantic ID prefix");
  if (typeof category !== "string" || !isSemanticIdCategory(category)) {
    throw new Error("Unknown semantic ID category");
  }
  if (typeof ownerKind !== "string" || !isSemanticIdOwnerKind(ownerKind)) {
    throw new Error("Unknown semantic ID owner kind");
  }
  if (typeof encodedOwnerName !== "string" || typeof encodedLocalName !== "string") {
    throw new Error("Semantic ID is missing a segment");
  }

  const decoded: SemanticId = {
    category,
    owner: {
      kind: ownerKind,
      name: decodeSegment(encodedOwnerName),
    },
    localName: decodeSegment(encodedLocalName),
  };
  validateSemanticId(decoded);
  if (encodeSemanticId(decoded) !== value) {
    throw new Error("Semantic ID is not canonical");
  }
  return decoded;
}
