import ts from "typescript";

import { architecture } from "../../features/runtime/index.js";
import type {
  TypeContract,
  TypeContractDiagnostic,
  TypeContractNode,
  TypeContractPrimitive,
  TypeContractProperty,
  TypeContractTupleElement,
} from "../../features/architecture/manifest.js";

architecture.allow({
  rule: "boring-typescript",
  reason: "TypeScript 5.9 checker flags prove compiler types before the required internal type refinements.",
});

export type {
  TypeContract,
  TypeContractDiagnostic,
  TypeContractNode,
  TypeContractPrimitive,
  TypeContractProperty,
  TypeContractTupleElement,
} from "../../features/architecture/manifest.js";

/** The TypeScript contract protocol is independent of the runtime schema protocol. */
export const TYPE_CONTRACT_VERSION = 1 as const;

export type TypeContractFacet =
  | { readonly status: "resolved"; readonly contract: TypeContract; readonly labels: readonly string[] }
  | { readonly status: "unresolved"; readonly diagnostic: TypeContractDiagnostic; readonly labels: readonly string[] };

export interface CallbackTypeContracts {
  readonly input: TypeContractFacet;
  readonly output: TypeContractFacet;
}

interface DraftProperty extends Omit<TypeContractProperty, "type"> { readonly type: number }
interface DraftTupleElement extends Omit<TypeContractTupleElement, "type"> { readonly type: number }
type DraftNode =
  | { readonly kind: "primitive"; readonly name: TypeContractPrimitive }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null; readonly valueType: "bigint" | "boolean" | "number" | "string" | "null" }
  | { readonly kind: "unknown" }
  | { readonly kind: "undefined" }
  | { readonly kind: "void" }
  | { readonly kind: "date" }
  | { readonly kind: "array"; readonly element: number; readonly readonly: boolean }
  | { readonly kind: "tuple"; readonly elements: readonly DraftTupleElement[]; readonly readonly: boolean }
  | { readonly kind: "object"; readonly properties: readonly DraftProperty[] }
  | { readonly kind: "union"; readonly members: readonly number[] };

class ContractFailure extends Error {
  constructor(readonly diagnostic: TypeContractDiagnostic) {
    super(diagnostic.message);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const failures = {
  any: ["TC001", "TypeScript any cannot form a sound static contract"],
  recursion: ["TC002", "Recursive types are unsupported by type contract version 1"],
  generic: ["TC003", "The static contract contains an unresolved generic type"],
  callable: ["TC004", "Callable or constructable values are unsupported in static contracts"],
  class: ["TC005", "Only Date is supported as a class in static contracts"],
  index: ["TC006", "Index signatures are unsupported in static contracts"],
  unsupported: ["TC007", "The TypeScript type is unsupported by type contract version 1"],
  awaitable: ["TC008", "The callback return type is not a valid awaitable"],
  callback: ["TC009", "The callback must have one resolvable call signature"],
  input: ["TC010", "The callback must declare or contextually receive an input parameter"],
  computed: ["TC011", "Computed and unique-symbol types are unsupported in static contracts"],
} as const;

type FailureName = keyof typeof failures;

function fail(name: FailureName, path: string, checker: ts.TypeChecker, type?: ts.Type): never {
  const [code, message] = failures[name];
  throw new ContractFailure({
    code,
    path,
    message,
    ...(type === undefined ? {} : { detail: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation) }),
  });
}

function isApplicationLabel(symbol: ts.Symbol): boolean {
  return symbol.declarations?.some((declaration) => (
    ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
  ) && !declaration.getSourceFile().isDeclarationFile) === true;
}

function typeLabel(type: ts.Type): string | null {
  const alias = type.aliasSymbol;
  if (alias !== undefined && alias.name !== "__type" && isApplicationLabel(alias)) return alias.name;
  const symbol = type.getSymbol();
  return symbol !== undefined && symbol.name !== "__type" && isApplicationLabel(symbol) ? symbol.name : null;
}

// TypeScript 5.9.3 stores effective mapped-property readonly state on transient symbol links.
const TYPESCRIPT_5_9_READONLY_CHECK_FLAG = 8;
interface TypeScript59TransientSymbol extends ts.Symbol {
  readonly links?: { readonly checkFlags?: number };
}

function declarationIsReadonly(declaration: ts.Declaration | undefined): boolean {
  if (declaration === undefined) return false;
  if (ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) return true;
  const parent = declaration.parent;
  return ts.isMappedTypeNode(parent) && parent.readonlyToken !== undefined && parent.readonlyToken.kind !== ts.SyntaxKind.MinusToken;
}

function propertyIsReadonly(property: ts.Symbol, declaration: ts.Declaration | undefined): boolean {
  if ((property.flags & ts.SymbolFlags.Transient) !== 0) {
    const checkFlags = (property as TypeScript59TransientSymbol).links?.checkFlags ?? 0;
    return (checkFlags & TYPESCRIPT_5_9_READONLY_CHECK_FLAG) !== 0;
  }
  return declarationIsReadonly(declaration);
}

function propertyPath(path: string, name: string): string {
  return `${path}.${JSON.stringify(name)}`;
}

function isBuiltInDate(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (symbol?.name !== "Date") return false;
  return symbol.declarations?.some((declaration) => {
    const fileName = declaration.getSourceFile().fileName.replaceAll("\\", "/");
    return ts.isInterfaceDeclaration(declaration) && /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(fileName);
  }) === true;
}

type ApplicationTypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

function applicationTypeDeclaration(symbol: ts.Symbol | undefined): ApplicationTypeDeclaration | null {
  return symbol?.declarations?.find((declaration): declaration is ApplicationTypeDeclaration => (
    ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
  ) && !declaration.getSourceFile().isDeclarationFile) ?? null;
}

function unsupportedPropertyName(property: ts.Symbol): boolean {
  if (property.name.startsWith("__@")) return true;
  return property.declarations?.some((declaration) => {
    const name = (declaration as ts.NamedDeclaration).name;
    return name !== undefined && ts.isComputedPropertyName(name);
  }) === true;
}

class TypeContractBuilder {
  private readonly nodes: DraftNode[] = [];
  private readonly completed = new Map<ts.Type, number>();
  private readonly active = new Set<ts.Type>();
  private readonly activeOrigins = new Set<ApplicationTypeDeclaration>();
  private readonly referencedOrigins = new Map<ApplicationTypeDeclaration, readonly ApplicationTypeDeclaration[]>();
  private readonly recursiveOrigins = new Map<ApplicationTypeDeclaration, boolean>();
  readonly labels = new Set<string>();

  constructor(private readonly checker: ts.TypeChecker, private readonly anchor: ts.Node) {}

  build(rootType: ts.Type, path: string): TypeContract {
    const root = this.visit(rootType, path);
    return canonicalize(root, this.nodes);
  }

  private visit(type: ts.Type, path: string): number {
    if (this.active.has(type)) fail("recursion", path, this.checker, type);
    const known = this.completed.get(type);
    if (known !== undefined) return known;

    const origin = applicationTypeDeclaration(type.aliasSymbol ?? type.getSymbol());
    if (origin !== null && this.activeOrigins.has(origin) && this.originIsRecursive(origin)) {
      fail("recursion", path, this.checker, type);
    }
    const addedOrigin = origin !== null && !this.activeOrigins.has(origin);
    if (addedOrigin) this.activeOrigins.add(origin);

    const label = typeLabel(type);
    if (label !== null) this.labels.add(label);

    this.active.add(type);
    try {
      const node = this.lower(type, path);
      const index = this.nodes.length;
      this.nodes.push(node);
      this.completed.set(type, index);
      return index;
    } finally {
      this.active.delete(type);
      if (origin !== null && addedOrigin) this.activeOrigins.delete(origin);
    }
  }

  private referencesFor(origin: ApplicationTypeDeclaration): readonly ApplicationTypeDeclaration[] {
    const known = this.referencedOrigins.get(origin);
    if (known !== undefined) return known;
    const references = new Set<ApplicationTypeDeclaration>();
    const addReference = (node: ts.Node): void => {
      let name: ts.Node | undefined;
      if (ts.isTypeReferenceNode(node)) name = node.typeName;
      else if (ts.isExpressionWithTypeArguments(node)) name = node.expression;
      if (name !== undefined) {
        const symbol = this.checker.getSymbolAtLocation(name);
        const resolved = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
          ? this.checker.getAliasedSymbol(symbol)
          : symbol;
        const declaration = applicationTypeDeclaration(resolved);
        if (declaration !== null) references.add(declaration);
      }
      ts.forEachChild(node, addReference);
    };
    ts.forEachChild(origin, addReference);
    const result = [...references];
    this.referencedOrigins.set(origin, result);
    return result;
  }

  private originIsRecursive(origin: ApplicationTypeDeclaration): boolean {
    const known = this.recursiveOrigins.get(origin);
    if (known !== undefined) return known;
    const visited = new Set<ApplicationTypeDeclaration>();
    const reachesOrigin = (current: ApplicationTypeDeclaration): boolean => {
      if (visited.has(current)) return false;
      visited.add(current);
      for (const reference of this.referencesFor(current)) {
        if (reference === origin || reachesOrigin(reference)) return true;
      }
      return false;
    };
    const result = reachesOrigin(origin);
    this.recursiveOrigins.set(origin, result);
    return result;
  }

  private lower(type: ts.Type, path: string): DraftNode {
    const flags = type.flags;
    if ((flags & ts.TypeFlags.Any) !== 0) fail("any", path, this.checker, type);
    if ((flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Substitution)) !== 0) {
      fail("generic", path, this.checker, type);
    }
    if ((flags & ts.TypeFlags.Unknown) !== 0) return { kind: "unknown" };
    if ((flags & ts.TypeFlags.Undefined) !== 0) return { kind: "undefined" };
    if ((flags & ts.TypeFlags.Void) !== 0) return { kind: "void" };
    if ((flags & ts.TypeFlags.Null) !== 0) return { kind: "literal", valueType: "null", value: null };
    if ((flags & ts.TypeFlags.StringLiteral) !== 0) {
      return { kind: "literal", valueType: "string", value: (type as ts.StringLiteralType).value };
    }
    if ((flags & ts.TypeFlags.NumberLiteral) !== 0) {
      return { kind: "literal", valueType: "number", value: (type as ts.NumberLiteralType).value };
    }
    if ((flags & ts.TypeFlags.BigIntLiteral) !== 0) {
      const value = (type as ts.BigIntLiteralType).value;
      return { kind: "literal", valueType: "bigint", value: `${value.negative ? "-" : ""}${value.base10Value}` };
    }
    if ((flags & ts.TypeFlags.BooleanLiteral) !== 0) {
      return { kind: "literal", valueType: "boolean", value: (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true" };
    }
    if ((flags & ts.TypeFlags.String) !== 0) return { kind: "primitive", name: "string" };
    if ((flags & ts.TypeFlags.Number) !== 0) return { kind: "primitive", name: "number" };
    if ((flags & ts.TypeFlags.Boolean) !== 0) return { kind: "primitive", name: "boolean" };
    if ((flags & ts.TypeFlags.BigInt) !== 0) return { kind: "primitive", name: "bigint" };
    if ((flags & ts.TypeFlags.UniqueESSymbol) !== 0) fail("computed", path, this.checker, type);
    if ((flags & ts.TypeFlags.ESSymbol) !== 0) return { kind: "primitive", name: "symbol" };

    if (type.isUnion()) {
      const members: number[] = [];
      const diagnostics: TypeContractDiagnostic[] = [];
      for (const member of type.types) {
        try {
          members.push(this.visit(member, `${path}|member`));
        } catch (error) {
          if (!(error instanceof ContractFailure)) throw error;
          diagnostics.push(error.diagnostic);
        }
      }
      if (diagnostics.length > 0) {
        diagnostics.sort((left, right) => compareText(left.code, right.code)
          || compareText(left.path, right.path)
          || compareText(left.message, right.message)
          || compareText(left.detail ?? "", right.detail ?? ""));
        throw new ContractFailure(diagnostics[0]!);
      }
      return { kind: "union", members };
    }
    if (type.isIntersection()) fail("unsupported", path, this.checker, type);

    if (this.checker.isTupleType(type)) {
      const reference = type as ts.TypeReference;
      const tuple = reference.target as ts.TupleType;
      const arguments_ = this.checker.getTypeArguments(reference);
      const elements = arguments_.map((element, index): DraftTupleElement => {
        const elementFlag = tuple.elementFlags[index] ?? ts.ElementFlags.Required;
        return {
          type: this.visit(element, `${path}[${index}]`),
          optional: (elementFlag & ts.ElementFlags.Optional) !== 0,
          rest: (elementFlag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0,
        };
      });
      return { kind: "tuple", elements, readonly: tuple.readonly };
    }

    const symbolName = type.getSymbol()?.name;
    if (this.checker.isArrayType(type)) {
      const element = this.checker.getTypeArguments(type as ts.TypeReference)[0];
      if (element === undefined) fail("generic", path, this.checker, type);
      return { kind: "array", element: this.visit(element, `${path}[]`), readonly: symbolName === "ReadonlyArray" };
    }
    if (isBuiltInDate(type)) return { kind: "date" };

    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      fail("callable", path, this.checker, type);
    }
    if ((type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) fail("class", path, this.checker, type);
    if (this.checker.getIndexInfosOfType(type).length > 0) fail("index", path, this.checker, type);
    if ((flags & ts.TypeFlags.Object) === 0) fail("unsupported", path, this.checker, type);

    const typeProperties = this.checker.getPropertiesOfType(type);
    if (typeProperties.some(unsupportedPropertyName)) fail("computed", path, this.checker, type);
    const properties = typeProperties
      .sort((left, right) => compareText(left.name, right.name))
      .map((property): DraftProperty => {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        const propertyType = this.checker.getTypeOfSymbolAtLocation(property, declaration ?? this.anchor);
        return {
          name: property.name,
          type: this.visit(propertyType, propertyPath(path, property.name)),
          optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
          readonly: propertyIsReadonly(property, declaration),
        };
      });
    return { kind: "object", properties };
  }
}

function draftSignature(index: number, nodes: readonly DraftNode[], memo: Map<number, string>): string {
  const known = memo.get(index);
  if (known !== undefined) return known;
  const node = nodes[index];
  if (node === undefined) throw new Error("Invalid draft type-contract reference");
  let semantic: unknown;
  switch (node.kind) {
    case "array": semantic = { kind: node.kind, element: draftSignature(node.element, nodes, memo), readonly: node.readonly }; break;
    case "tuple": semantic = { kind: node.kind, elements: node.elements.map((element) => ({ ...element, type: draftSignature(element.type, nodes, memo) })), readonly: node.readonly }; break;
    case "object": semantic = { kind: node.kind, properties: node.properties.map((property) => ({ ...property, type: draftSignature(property.type, nodes, memo) })) }; break;
    case "union": semantic = { kind: node.kind, members: [...new Set(node.members.map((member) => draftSignature(member, nodes, memo)))].sort(compareText) }; break;
    default: semantic = node;
  }
  const signature = JSON.stringify(semantic);
  memo.set(index, signature);
  return signature;
}

function canonicalize(root: number, drafts: readonly DraftNode[]): TypeContract {
  const signatures = new Map<number, string>();
  const reachable = new Set<number>();
  const collect = (index: number): void => {
    if (reachable.has(index)) return;
    reachable.add(index);
    const node = drafts[index];
    if (node === undefined) throw new Error("Invalid draft type-contract reference");
    if (node.kind === "array") collect(node.element);
    else if (node.kind === "tuple") node.elements.forEach((element) => collect(element.type));
    else if (node.kind === "object") node.properties.forEach((property) => collect(property.type));
    else if (node.kind === "union") node.members.forEach(collect);
  };
  collect(root);
  for (const index of reachable) draftSignature(index, drafts, signatures);

  const uniqueSignatures = [...new Set([...reachable].map((index) => signatures.get(index)!))].sort(compareText);
  const idForSignature = new Map(uniqueSignatures.map((signature, index) => [signature, `n${index}`]));
  const representative = new Map<string, number>();
  for (const index of reachable) representative.set(signatures.get(index)!, index);
  const idFor = (index: number): string => idForSignature.get(signatures.get(index)!)!;

  const nodes = uniqueSignatures.map((signature): TypeContractNode => {
    const draft = drafts[representative.get(signature)!]!;
    const id = idForSignature.get(signature)!;
    switch (draft.kind) {
      case "array": return { id, kind: draft.kind, element: idFor(draft.element), readonly: draft.readonly };
      case "tuple": return { id, kind: draft.kind, elements: draft.elements.map((element) => ({ ...element, type: idFor(element.type) })), readonly: draft.readonly };
      case "object": return { id, kind: draft.kind, properties: draft.properties.map((property) => ({ ...property, type: idFor(property.type) })) };
      case "union": {
        const memberSignatures = [...new Set(draft.members.map((member) => signatures.get(member)!))].sort(compareText);
        const members = memberSignatures.map((memberSignature) => idForSignature.get(memberSignature)!);
        return { id, kind: draft.kind, members };
      }
      default: return { id, ...draft };
    }
  });
  return { version: TYPE_CONTRACT_VERSION, root: idFor(root), nodes };
}

function unresolved(diagnostic: TypeContractDiagnostic, labels: ReadonlySet<string> = new Set()): TypeContractFacet {
  return { status: "unresolved", diagnostic, labels: [...labels].sort(compareText) };
}

/** Extract one complete facet. Unsupported nested types reject the whole facet. */
export function extractTypeContract(checker: ts.TypeChecker, type: ts.Type, anchor: ts.Node, path: string): TypeContractFacet {
  const builder = new TypeContractBuilder(checker, anchor);
  try {
    return { status: "resolved", contract: builder.build(type, path), labels: [...builder.labels].sort(compareText) };
  } catch (error) {
    if (error instanceof ContractFailure) return unresolved(error.diagnostic, builder.labels);
    throw error;
  }
}

function callbackNode(definition: ts.ObjectLiteralExpression, name: string): ts.Node | undefined {
  for (const member of definition.properties) {
    const memberName = member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) ? member.name.text : undefined;
    if (memberName !== name) continue;
    if (ts.isPropertyAssignment(member)) return member.initializer;
    if (ts.isShorthandPropertyAssignment(member)) return member.name;
    if (ts.isMethodDeclaration(member)) return member;
  }
  return undefined;
}

function callbackFailure(name: "callback" | "input", path: string): TypeContractFacet {
  const [code, message] = failures[name];
  return unresolved({ code, path, message });
}

/** Resolve a run/handler signature without importing or executing the source module. */
export function extractCallbackTypeContracts(
  checker: ts.TypeChecker,
  definition: ts.ObjectLiteralExpression,
  callbackName: "handler" | "run",
): CallbackTypeContracts {
  const callback = callbackNode(definition, callbackName);
  if (callback === undefined) {
    return { input: callbackFailure("callback", "input"), output: callbackFailure("callback", "output") };
  }
  const directSignature = ts.isFunctionLike(callback) ? checker.getSignatureFromDeclaration(callback) : undefined;
  const signatures = directSignature === undefined ? checker.getTypeAtLocation(callback).getCallSignatures() : [directSignature];
  if (signatures.length !== 1) {
    return { input: callbackFailure("callback", "input"), output: callbackFailure("callback", "output") };
  }
  const signature = signatures[0]!;
  let inputSymbol = signature.parameters[0];
  if (inputSymbol === undefined && ts.isExpression(callback)) {
    const contextual = checker.getContextualType(callback)?.getCallSignatures();
    if (contextual?.length === 1) inputSymbol = contextual[0]?.parameters[0];
  }
  const input = inputSymbol === undefined
    ? callbackFailure("input", "input")
    : extractTypeContract(
      checker,
      checker.getTypeOfSymbolAtLocation(inputSymbol, inputSymbol.valueDeclaration ?? inputSymbol.declarations?.[0] ?? callback),
      callback,
      "input",
    );

  const returnType = checker.getReturnTypeOfSignature(signature);
  let output: TypeContractFacet;
  if ((returnType.flags & ts.TypeFlags.Any) !== 0) {
    output = extractTypeContract(checker, returnType, callback, "output");
  } else {
    const awaited = checker.getAwaitedType(returnType);
    output = awaited === undefined
      ? callbackFailure("callback", "output")
      : extractTypeContract(checker, awaited, callback, "output");
    if (awaited === undefined) {
      const [code, message] = failures.awaitable;
      output = unresolved({ code, path: "output", message, detail: checker.typeToString(returnType, undefined, ts.TypeFormatFlags.NoTruncation) });
    }
  }
  return { input, output };
}

/** This is the sole semantic serializer and equality representation for v1 contracts. */
export function canonicalTypeContract(contract: TypeContract): string {
  return JSON.stringify(contract);
}

export function typeContractsEqual(left: TypeContract, right: TypeContract): boolean {
  return canonicalTypeContract(left) === canonicalTypeContract(right);
}
