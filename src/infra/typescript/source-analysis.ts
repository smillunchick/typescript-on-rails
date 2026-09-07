import path from "node:path";
import ts from "typescript";

import type { ArchitectureManifest } from "../../features/architecture/manifest.js";
import type { CompositionSource, LexicalContextObservation } from "../../features/architecture/manifest-v3.js";
import { architecture, runtimeRecordId, type ApplicationGraph } from "../../features/runtime/index.js";
import { isFrameworkImport, resolvedObjectArgument, resolvedSymbol, unwrapConstSafeExpression, unwrapTransparentExpression, variableName } from "./analyze.js";

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
    const web = specifier.text === "@typescript-on-rails/web" || specifier.text === "@typescript-on-rails/web/next";
    if (!fullstack && !web && !isFrameworkImport(file, specifier.text)) continue;
    const module = checker.getSymbolAtLocation(specifier);
    if (module === undefined) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      if (fullstack && exported.name !== "processEntrypoint") continue;
      if (web && !["bindRoute", "nextRoute", "nextRouteFor", "nextRouteExports", "nextRouteExportsFor"].includes(exported.name)) continue;
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
  const value = constExpression(checker, objectMember(object, name));
  return value !== undefined && ts.isStringLiteralLike(value) ? value.text : null;
}

function objectMember(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  if (object.properties.some((property) => ts.isSpreadAssignment(property) || (property.name !== undefined && ts.isComputedPropertyName(property.name)))) return undefined;
  const members = object.properties.filter((property) => property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name);
  const member = members.length === 1 ? members[0] : undefined;
  return member !== undefined && ts.isPropertyAssignment(member) ? member.initializer
    : member !== undefined && ts.isShorthandPropertyAssignment(member) ? member.name : undefined;
}

// Resolve only immutable source references, not inferred types or arbitrary calls.
function constExpression(checker: ts.TypeChecker, expression: ts.Expression | undefined, visited = new Set<ts.Symbol>()): ts.Expression | undefined {
  if (expression === undefined) return undefined;
  const current = unwrapConstSafeExpression(expression);
  if (current === null) return undefined;
  if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) return current;
  const referenced = ts.isIdentifier(current) && ts.isShorthandPropertyAssignment(current.parent)
    ? checker.getShorthandAssignmentValueSymbol(current.parent)
    : checker.getSymbolAtLocation(ts.isPropertyAccessExpression(current) ? current.name : current);
  if (referenced === undefined) return undefined;
  const symbol = resolvedSymbol(checker, referenced);
  if (visited.has(symbol)) return undefined;
  visited.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (declaration !== undefined && ts.isVariableDeclaration(declaration) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
    return constExpression(checker, declaration.initializer, visited);
  }
  return current;
}

function arrayElements(checker: ts.TypeChecker, expression: ts.Expression | undefined): readonly ts.Expression[] | undefined {
  const value = constExpression(checker, expression);
  return value !== undefined && ts.isArrayLiteralExpression(value) && !value.elements.some(ts.isSpreadElement) ? value.elements : undefined;
}

function symbolValue(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Expression | undefined {
  const declaration = symbol === undefined ? undefined : resolvedSymbol(checker, symbol).valueDeclaration;
  return declaration !== undefined && ts.isVariableDeclaration(declaration) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 ? declaration.initializer
    : declaration !== undefined && ts.isExportAssignment(declaration) ? declaration.expression
    : declaration !== undefined && ts.isBindingElement(declaration) && ts.isIdentifier(declaration.name) ? declaration.name : undefined;
}

function applicationExpression(root: string, program: ts.Program): ts.Expression | undefined {
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path.resolve(root, "src/app.ts"));
  const module = file === undefined ? undefined : checker.getSymbolAtLocation(file);
  const exports = module === undefined ? [] : checker.getExportsOfModule(module);
  return constExpression(checker, symbolValue(exports.find(({ name }) => name === "default") ?? exports.find(({ name }) => name === "application"), checker));
}

function applicationConfig(root: string, program: ts.Program, factories: ReadonlyMap<ts.Symbol, string>): ts.ObjectLiteralExpression | null {
  const checker = program.getTypeChecker();
  let value = applicationExpression(root, program);
  const visited = new Set<ts.Symbol>();
  while (value !== undefined && ts.isCallExpression(value)) {
    const symbol = expressionSymbol(checker, value.expression);
    if (symbol === undefined || visited.has(symbol)) return null;
    visited.add(symbol);
    if (factories.get(symbol) === "defineApp") return resolvedObjectArgument(checker, value);
    // The public reference app uses a zero-argument factory with one return.
    // Parameters, branches and computed collections are not evaluated here.
    const declaration = symbol.valueDeclaration;
    if (value.arguments.length !== 0 || declaration === undefined || !ts.isFunctionDeclaration(declaration) || declaration.body?.statements.length !== 1) return null;
    const statement = declaration.body.statements[0];
    value = statement !== undefined && ts.isReturnStatement(statement) ? constExpression(checker, statement.expression) : undefined;
  }
  return null;
}

// Entrypoint maps may use a single-return factory, as in the reference app.
// Resolve its returned declarations without evaluating arguments or branches.
function entrypointMap(program: ts.Program, expression: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  const checker = program.getTypeChecker();
  let value = constExpression(checker, expression);
  const visited = new Set<ts.Symbol>();
  while (value !== undefined && ts.isCallExpression(value)) {
    const symbol = expressionSymbol(checker, value.expression);
    if (symbol === undefined || visited.has(symbol)) return undefined;
    visited.add(symbol);
    const callee = value.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && callee.name.text === "freeze"
      && checker.getSymbolAtLocation(callee.expression)?.declarations?.every((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))
      && symbol.declarations?.every((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) && value.arguments.length === 1) {
      value = constExpression(checker, value.arguments[0]);
      continue;
    }
    const declaration = symbol.valueDeclaration;
    if (declaration === undefined || !ts.isFunctionDeclaration(declaration) || declaration.body?.statements.length !== 1) return undefined;
    const statement = declaration.body.statements[0];
    value = statement !== undefined && ts.isReturnStatement(statement) ? constExpression(checker, statement.expression) : undefined;
  }
  return value !== undefined && ts.isObjectLiteralExpression(value) ? value : undefined;
}

function registrationDefinitions(root: string, program: ts.Program): ReadonlyMap<string, ts.CallExpression | null> {
  const checker = program.getTypeChecker();
  const factories = frameworkSymbols(program, checker);
  const found = new Map<string, ts.CallExpression | null>();

  const factory = (call: ts.CallExpression): string | undefined => {
    const symbol = expressionSymbol(checker, call.expression);
    return symbol === undefined ? undefined : factories.get(symbol);
  };
  const add = (kind: "entrypoint" | "consumer" | "repository" | "schedule" | "route", owner: string, name: string | null, call: ts.CallExpression): void => {
    if (name === null || name.trim() === "" || owner.trim() === "") return;
    const source = call.getSourceFile();
    const file = path.relative(root, source.fileName).split(path.sep).join("/");
    if (file.startsWith("../") || path.isAbsolute(file) || source.isDeclarationFile) return;
    const key = runtimeRecordId(kind, owner, name);
    found.set(key, found.has(key) ? null : call);
  };
  const app = applicationConfig(root, program, factories);
  const entries = app === null ? undefined : entrypointMap(program, objectMember(app, "entrypoints"));
  for (const process of ["web", "worker", "scheduler"] as const) {
    const call = entries === undefined ? undefined : constExpression(checker, objectMember(entries, process));
    if (call === undefined || !ts.isCallExpression(call) || !["entrypoint", "processEntrypoint"].includes(factory(call) ?? "")) continue;
    const object = resolvedObjectArgument(checker, call);
    if (object !== null) add("entrypoint", "application", stringMember(checker, object, "name"), call);
  }
  for (const expression of app === null ? [] : arrayElements(checker, objectMember(app, "features")) ?? []) {
    const call = constExpression(checker, expression);
    if (call === undefined || !ts.isCallExpression(call) || factory(call) !== "defineFeature") continue;
    const feature = resolvedObjectArgument(checker, call);
    if (feature === null) continue;
    const owner = stringMember(checker, feature, "name");
    if (owner === null) continue;
    for (const [member, kind, supported] of [
      ["consumers", "consumer", ["consumer"]],
      ["repositories", "repository", ["defineRepository"]],
      ["schedules", "schedule", ["schedule"]],
      ["routes", "route", ["route", "operationRoute"]],
    ] as const) {
      for (const expression of arrayElements(checker, objectMember(feature, member)) ?? []) {
        const call = constExpression(checker, expression);
        if (call === undefined || !ts.isCallExpression(call) || !supported.some((name) => name === factory(call))) continue;
        const object = resolvedObjectArgument(checker, call);
        if (object === null) continue;
        if ((kind === "repository" || kind === "schedule") && stringMember(checker, object, "feature") !== owner) continue;
        const method = stringMember(checker, object, "method");
        const routePath = stringMember(checker, object, "path");
        const name = kind === "route" ? method === null || routePath === null ? null : `${method} ${routePath}` : stringMember(checker, object, "name");
        add(kind, owner, name, call);
      }
    }
  }
  return found;
}

export function registrationSources(root: string, program: ts.Program): RegistrationSources {
  return new Map([...registrationDefinitions(root, program)].map(([key, call]) => {
    const source = call?.getSourceFile();
    return [key, call === null || source === undefined ? null : Object.freeze({
      file: path.relative(root, source.fileName).split(path.sep).join("/"),
      line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
      provenance: "static-registration" as const,
    })];
  }));
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

// Next wrappers have a bounded linkage contract: graph-based wrappers must use
// the src/app.ts application export; binding-based wrappers must use the exact
// binding referenced by its web entrypoint. Other callable code stays unknown.
function routeExportLinkage(root: string, program: ts.Program, graph: ApplicationGraph): (symbol: ts.Symbol, method: string, routePath: string) => boolean {
  const checker = program.getTypeChecker();
  const factories = frameworkSymbols(program, checker);
  const factory = (call: ts.CallExpression): string | undefined => {
    const symbol = expressionSymbol(checker, call.expression);
    return symbol === undefined ? undefined : factories.get(symbol);
  };
  const application = applicationExpression(root, program);
  const isApplicationGraph = (expression: ts.Expression | undefined): boolean => {
    const value = constExpression(checker, expression);
    return application !== undefined && value !== undefined && ts.isPropertyAccessExpression(value) && value.name.text === "graph" && constExpression(checker, value.expression) === application;
  };
  const appConfig = applicationConfig(root, program, factories);
  const entries = appConfig === null ? undefined : entrypointMap(program, objectMember(appConfig, "entrypoints"));
  const web = entries === undefined ? undefined : constExpression(checker, objectMember(entries, "web"));
  const webConfig = web !== undefined && ts.isCallExpression(web) && ["entrypoint", "processEntrypoint"].includes(factory(web) ?? "") ? resolvedObjectArgument(checker, web) : null;
  const bindings = webConfig === null ? [] : (arrayElements(checker, objectMember(webConfig, "bindings")) ?? []).map((expression) => constExpression(checker, expression));
  const routeConfig = (expression: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined => {
    const call = constExpression(checker, expression);
    if (call === undefined || !ts.isCallExpression(call) || !["route", "operationRoute"].includes(factory(call) ?? "")) return undefined;
    return resolvedObjectArgument(checker, call) ?? undefined;
  };
  const literal = (expression: ts.Expression | undefined): string | null => {
    const value = constExpression(checker, expression);
    if (value === undefined) return null;
    if (ts.isStringLiteralLike(value)) return value.text;
    if (ts.isPropertyAccessExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "metadata") {
      const config = routeConfig(value.expression.expression);
      if (config !== undefined) return stringMember(checker, config, value.name.text);
    }
    return null;
  };
  const definitions = registrationDefinitions(root, program);
  const registeredBinding = (expression: ts.Expression | undefined, method: string, routePath: string): boolean => {
    const binding = constExpression(checker, expression);
    if (binding === undefined || !bindings.includes(binding) || !ts.isCallExpression(binding) || factory(binding) !== "bindRoute") return false;
    const target = constExpression(checker, binding.arguments[0]);
    const config = routeConfig(target);
    if (target === undefined || config === undefined || stringMember(checker, config, "method") !== method || stringMember(checker, config, "path") !== routePath) return false;
    return graph.routes.some((route) => {
      if (route.name !== `${method} ${routePath}`) return false;
      return definitions.get(runtimeRecordId("route", route.owner, route.name)) === target;
    });
  };
  return (symbol, method, routePath) => {
    const visited = new Set<ts.Node>();
    const linked = (expression: ts.Expression | undefined, selected?: string): boolean => {
      const value = constExpression(checker, expression);
      if (value === undefined || visited.has(value)) return false;
      visited.add(value);
      if (ts.isIdentifier(value)) {
        const symbol = checker.getSymbolAtLocation(value);
        const declaration = symbol === undefined ? undefined : resolvedSymbol(checker, symbol).valueDeclaration;
        if (declaration !== undefined && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) && ts.isVariableDeclaration(declaration.parent.parent) && (declaration.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer === undefined && declaration.dotDotDotToken === undefined) {
          const property = declaration.propertyName ?? declaration.name;
          return selected === undefined && (ts.isIdentifier(property) || ts.isStringLiteral(property)) && linked(declaration.parent.parent.initializer, property.text);
        }
      }
      if (ts.isPropertyAccessExpression(value)) return selected === undefined && linked(value.expression, value.name.text);
      if (!ts.isCallExpression(value)) return false;
      const wrapper = factory(value);
      if (wrapper === "nextRouteFor") return selected === undefined && isApplicationGraph(value.arguments[0]) && literal(value.arguments[1]) === routePath && literal(value.arguments[2]) === method;
      if (wrapper === "nextRouteExportsFor") return selected === method && isApplicationGraph(value.arguments[0]) && literal(value.arguments[1]) === routePath;
      if (wrapper === "nextRoute") return selected === undefined && registeredBinding(value.arguments[0], method, routePath);
      if (wrapper === "nextRouteExports") {
        const handlers = arrayElements(checker, value.arguments[0]);
        const methods = new Set<string>();
        return selected === method && handlers !== undefined && handlers.every((expression) => {
          const binding = constExpression(checker, expression);
          const config = binding !== undefined && ts.isCallExpression(binding) ? routeConfig(binding.arguments[0]) : undefined;
          const name = config === undefined ? null : stringMember(checker, config, "method");
          const path = config === undefined ? null : stringMember(checker, config, "path");
          if (name === null || path === null || methods.has(name)) return false;
          methods.add(name);
          return registeredBinding(expression, name, path);
        }) && handlers.some((binding) => registeredBinding(binding, method, routePath));
      }
      return false;
    };
    return linked(symbolValue(symbol, checker));
  };
}

export function exportedRouteMethods(file: string, program: ts.Program, linkage?: { readonly root: string; readonly path: string; readonly graph: ApplicationGraph }): { readonly methods: readonly string[]; readonly unresolved: readonly string[] } {
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
  const linked = linkage === undefined ? undefined : routeExportLinkage(linkage.root, program, linkage.graph);
  for (const name of methods) {
    const exported = exports.get(name);
    const symbol = exported === undefined ? undefined : resolvedSymbol(checker, exported);
    if (symbol === undefined || !symbol.declarations?.length || checker.getSignaturesOfType(checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(symbol, source)), ts.SignatureKind.Call).length === 0) unresolved.push(`${name} export does not resolve to a callable handler`);
    else if (linkage !== undefined && linkage.graph.routes.some((route) => route.name === `${name} ${linkage.path}`) && !linked?.(symbol, name, linkage.path)) unresolved.push(`${name} export cannot be linked to its registered web binding through a supported Next wrapper`);
  }
  return { methods: Object.freeze(methods.sort()), unresolved: Object.freeze(unresolved.sort()) };
}
