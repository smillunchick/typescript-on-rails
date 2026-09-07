import path from "node:path";
import ts from "typescript";

import type { ArchitectureManifest } from "../../features/architecture/manifest.js";
import type { CompositionSource, LexicalContextObservation } from "../../features/architecture/manifest-v3.js";
import { architecture, runtimeRecordId } from "../../features/runtime/index.js";
import { featureNameFor, isFrameworkImport, resolvedObjectArgument, resolvedSymbol, unwrapConstSafeExpression, unwrapTransparentExpression, variableName } from "./analyze.js";

architecture.allow({
  rule: "infrastructure-feature-boundary",
  reason: "Source analysis implements the architecture feature's provenance and lexical observation contracts.",
});

export type RegistrationSources = ReadonlyMap<string, CompositionSource | null>;

// Import spelling is only used to find the framework module. Calls must resolve
// to its actual exports, including through application re-exports and aliases.
function frameworkSymbols(program: ts.Program, checker: ts.TypeChecker): ReadonlyMap<ts.Symbol, string> {
  const symbols = new Map<ts.Symbol, string>();
  for (const file of program.getSourceFiles()) for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    const fullstack = specifier.text === "@typescript-on-rails/fullstack";
    if (!fullstack && !isFrameworkImport(file, specifier.text)) continue;
    const module = checker.getSymbolAtLocation(specifier);
    if (module === undefined) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      if (fullstack && exported.name !== "processEntrypoint") continue;
      const symbol = resolvedSymbol(checker, exported);
      if (symbol.declarations?.length) symbols.set(symbol, exported.name);
    }
  }
  return symbols;
}

function expressionSymbol(checker: ts.TypeChecker, expression: ts.Expression, visited = new Set<ts.Symbol>()): ts.Symbol | undefined {
  const current = unwrapTransparentExpression(expression);
  const referenced = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(current) ? current.name : current);
  if (referenced === undefined) return undefined;
  const symbol = resolvedSymbol(checker, referenced);
  if (visited.has(symbol)) return undefined;
  visited.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
    return expressionSymbol(checker, declaration.initializer, visited) ?? symbol;
  }
  return symbol;
}

// Unlike a schema type, a source identity needs a literal value, not an asserted type.
function stringMember(checker: ts.TypeChecker, object: ts.ObjectLiteralExpression, name: string): string | null {
  const members = object.properties.filter((property) => property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name);
  if (members.length !== 1 || object.properties.some(ts.isSpreadAssignment)) return null;
  const member = members[0];
  const value = member !== undefined && ts.isPropertyAssignment(member) ? member.initializer : member !== undefined && ts.isShorthandPropertyAssignment(member) ? member.name : undefined;
  const resolve = (expression: ts.Expression, visited: Set<ts.Symbol>): string | null => {
    const current = unwrapConstSafeExpression(expression);
    if (current === null) return null;
    if (ts.isStringLiteralLike(current)) return current.text;
    const referenced = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(current) ? current.name : current);
    if (referenced === undefined) return null;
    const symbol = resolvedSymbol(checker, referenced);
    if (visited.has(symbol)) return null;
    visited.add(symbol);
    const declaration = symbol.valueDeclaration;
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      ? resolve(declaration.initializer, visited) : null;
  };
  return value === undefined ? null : resolve(value, new Set());
}

export function registrationSources(root: string, program: ts.Program): RegistrationSources {
  const checker = program.getTypeChecker();
  const factories = frameworkSymbols(program, checker);
  const found = new Map<string, CompositionSource | null>();
  for (const sourceFile of program.getSourceFiles()) {
    const relative = path.relative(path.join(root, "src"), sourceFile.fileName).split(path.sep).join("/");
    if (relative.startsWith("../") || path.isAbsolute(relative) || sourceFile.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const symbol = expressionSymbol(checker, node.expression);
        const callee = symbol === undefined ? undefined : factories.get(symbol);
        const object = resolvedObjectArgument(checker, node);
        if (object !== null) {
          let kind: "route" | "consumer" | "schedule" | "repository" | "entrypoint" | undefined;
          let owner = featureNameFor(root, sourceFile.fileName);
          let name = stringMember(checker, object, "name");
          if (callee === "operationRoute" || callee === "route") {
            kind = "route";
            const method = stringMember(checker, object, "method");
            const routePath = stringMember(checker, object, "path");
            name = method === null || routePath === null ? null : `${method} ${routePath}`;
          } else if (callee === "consumer") kind = "consumer";
          else if (callee === "schedule" || callee === "defineRepository") {
            kind = callee === "schedule" ? "schedule" : "repository";
            owner = stringMember(checker, object, "feature");
          } else if (callee === "entrypoint" || callee === "processEntrypoint") {
            kind = "entrypoint";
            owner = "application";
          }
          if (kind !== undefined && owner !== null && owner.trim() !== "" && name !== null && name.trim() !== "") {
            const key = runtimeRecordId(kind, owner, name);
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            found.set(key, found.has(key) ? null : Object.freeze({ file: `src/${relative}`, line, provenance: "static-registration" }));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}

export interface OperationStaticAnalysis {
  readonly observations: readonly LexicalContextObservation[];
  readonly resolution: "resolved" | "context-unresolved" | "source-unresolved";
}

export function operationStaticCalls(root: string, base: ArchitectureManifest, program: ts.Program): ReadonlyMap<string, OperationStaticAnalysis> {
  const checker = program.getTypeChecker();
  const output = new Map<string, OperationStaticAnalysis>();
  for (const operation of base.operations) {
    if (operation.feature === null) continue;
    const key = `${operation.feature}:${operation.name}`;
    const sourceFile = program.getSourceFile(path.resolve(root, operation.file));
    const observations: LexicalContextObservation[] = [];
    let resolution: OperationStaticAnalysis["resolution"] = "source-unresolved";
    if (sourceFile !== undefined) {
      const inspectRun = (run: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration): OperationStaticAnalysis["resolution"] => {
        const context = run.parameters[1]?.name;
        if (context === undefined) return "resolved";
        if (run.body === undefined) return "context-unresolved";
        const members = new Map<ts.Symbol, string>();
        let resolved = true;
        const bind = (name: ts.BindingName, member: string): void => {
          if (ts.isIdentifier(name)) {
            const symbol = checker.getSymbolAtLocation(name);
            if (symbol !== undefined) members.set(symbol, member);
          } else if (ts.isObjectBindingPattern(name)) {
            for (const element of name.elements) {
              const property = element.propertyName ?? element.name;
              if (element.dotDotDotToken !== undefined || element.initializer !== undefined || (!ts.isIdentifier(property) && !ts.isStringLiteral(property))) { resolved = false; continue; }
              bind(element.name, `${member}.${property.text}`);
            }
          } else resolved = false;
        };
        bind(context, ts.isIdentifier(context) ? context.text : "context");
        const memberPath = (expression: ts.Expression, resolving = new Set<ts.Symbol>()): string | undefined => {
          const current = unwrapTransparentExpression(expression);
          if (ts.isIdentifier(current)) {
            const symbol = checker.getSymbolAtLocation(current);
            if (symbol === undefined || resolving.has(symbol)) return undefined;
            if (members.has(symbol)) return members.get(symbol);
            resolving.add(symbol);
            let declaration: ts.Node | undefined = symbol.valueDeclaration;
            while (declaration !== undefined && (ts.isBindingElement(declaration) || ts.isObjectBindingPattern(declaration) || ts.isArrayBindingPattern(declaration))) declaration = declaration.parent;
            if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
              const member = memberPath(declaration.initializer, resolving);
              if (member !== undefined) bind(declaration.name, member);
            }
            return members.get(symbol);
          }
          if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
            const parent = memberPath(current.expression, resolving);
            return parent === undefined ? undefined : ts.isPropertyAccessExpression(current) ? `${parent}.${current.name.text}` : `${parent}[computed]`;
          }
          return undefined;
        };
        const observe = (node: ts.Node, member: string, state: LexicalContextObservation["state"], nested: boolean, event?: string): void => {
          observations.push(Object.freeze({ member, file: path.relative(root, node.getSourceFile().fileName).split(path.sep).join("/"),
            line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
            state, scope: nested ? "nested-function" : "run-body", runtimeReachability: "unknown",
            ...(event === undefined ? {} : { event }),
          }));
        };
        const visit = (node: ts.Node, nested: boolean): void => {
          if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
            const member = memberPath(node.initializer);
            if (member !== undefined) {
              if ((node.parent.flags & ts.NodeFlags.Const) !== 0) bind(node.name, member);
              else { observe(node, member, "alias-unresolved", nested); resolved = false; }
            }
          }
          if (ts.isCallExpression(node)) {
            const member = memberPath(node.expression);
            if (member !== undefined) {
              const argument = node.arguments[0];
              observe(node, member, member.includes("[computed]") ? "computed-unresolved" : "direct", nested,
                member.endsWith(".appendOutbox") && argument !== undefined && ts.isIdentifier(argument) ? argument.text : undefined);
            }
          }
          const childNested = nested || (ts.isFunctionLike(node) && node !== run);
          ts.forEachChild(node, (child) => visit(child, childNested));
        };
        visit(run.body, false);
        return resolved ? "resolved" : "context-unresolved";
      };
      // Reuse Manifest v2's declaration name and location, including same-line declarations.
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && variableName(node) === operation.name && sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 === operation.line) {
          const config = resolvedObjectArgument(checker, node);
          if (config !== null) for (const property of config.properties) {
            if ((!ts.isMethodDeclaration(property) && !ts.isPropertyAssignment(property)) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) || property.name.text !== "run") continue;
            if (ts.isMethodDeclaration(property)) resolution = inspectRun(property);
            else if (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) resolution = inspectRun(property.initializer);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    observations.sort((a, b) => a.line - b.line || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
    output.set(key, Object.freeze({ observations: Object.freeze(observations), resolution }));
  }
  return output;
}

export function exportedRouteMethods(file: string, program: ts.Program): { readonly methods: readonly string[]; readonly unresolved: readonly string[] } {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path.resolve(file));
  const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (source === undefined || module === undefined) return { methods: [], unresolved: ["route module is not in the TypeScript program or has no exports"] };
  const unresolved: string[] = [];
  const names = new Set<string>();
  const visited = new Set<ts.SourceFile>();
  const bindingNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name);
  };
  const inspectExports = (source: ts.SourceFile): void => {
    if (visited.has(source)) return;
    visited.add(source);
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        const target = statement.moduleSpecifier === undefined ? undefined : checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (statement.moduleSpecifier !== undefined && target === undefined) unresolved.push(`cannot resolve route re-export ${statement.moduleSpecifier.getText(source)}`);
        if (statement.exportClause !== undefined) {
          if (ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) if (!element.isTypeOnly) names.add(element.name.text);
          } else names.add(statement.exportClause.name.text);
        } else for (const declaration of target?.declarations ?? []) if (ts.isSourceFile(declaration)) inspectExports(declaration);
      } else if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name);
        else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) names.add(statement.name.text);
      }
    }
  };
  inspectExports(source);
  // Next generates HEAD from GET and OPTIONS itself only when no explicit export
  // exists. Those automatic methods are not additional application behavior.
  const methods = [...names].filter((name) => /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name));
  const exports = new Map(checker.getExportsOfModule(module).map((symbol) => [symbol.name, symbol]));
  for (const name of methods) {
    const exported = exports.get(name);
    const symbol = exported === undefined ? undefined : resolvedSymbol(checker, exported);
    if (symbol === undefined || !symbol.declarations?.length || checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, source), ts.SignatureKind.Call).length === 0) unresolved.push(`${name} export does not resolve to a callable handler`);
  }
  return { methods: Object.freeze(methods.sort()), unresolved: Object.freeze(unresolved.sort()) };
}
