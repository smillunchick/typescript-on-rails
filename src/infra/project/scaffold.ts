import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import {
  updateAppRegistrationSource,
  updateFeatureRegistrationSource,
  validateFeatureRegistrationSource,
  type FeatureArtifactCollection,
} from "./application-shape.js";
import { executeProjectEdit, planProjectEdit, type ProjectEditRequest } from "./project-edit.js";

export interface GenerationResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
}

export type ApplicationScaffoldContent = string | Uint8Array;

export interface ApplicationScaffoldFileSystem {
  createDirectory(directory: string): Promise<void>;
  createFile(file: string, content: ApplicationScaffoldContent): Promise<void>;
  removePath(target: string, recursive: boolean): Promise<void>;
}

const SOURCE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ARTIFACT_SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function words(value: string, sourcePattern: RegExp = SOURCE_NAME): string[] {
  if (!sourcePattern.test(value)) throw new Error(`Invalid name: ${value}`);
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .split(/[-_]/)
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.toLowerCase());
}

function kebabCase(value: string): string {
  return words(value).join("-");
}

function pascalCase(value: string, sourcePattern?: RegExp): string {
  return words(value, sourcePattern).map((entry) => entry[0]?.toUpperCase() + entry.slice(1)).join("");
}

function camelCase(value: string, sourcePattern?: RegExp): string {
  const pascal = pascalCase(value, sourcePattern);
  return `${pascal[0]?.toLowerCase() ?? ""}${pascal.slice(1)}`;
}

function assertGeneratedIdentifier(identifier: string, sourceName: string): void {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, identifier);
  const token = scanner.scan();
  const isKeyword = token >= ts.SyntaxKind.FirstKeyword && token <= ts.SyntaxKind.LastKeyword;
  if (token !== ts.SyntaxKind.Identifier || isKeyword || scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    throw new Error(`Invalid generated identifier for name: ${sourceName}`);
  }
}

function safeTarget(cwd: string, target: string): string {
  if (path.isAbsolute(target) || target.length === 0) throw new Error(`Invalid target directory: ${target}`);
  const segments = target.split(/[\\/]/);
  if (segments.some((entry) => !SAFE_PATH_SEGMENT.test(entry) || entry === "." || entry === "..")) {
    throw new Error(`Invalid target directory: ${target}`);
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Invalid target directory: ${target}`);
  return resolved;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertOrdinaryDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Refusing unsafe directory: ${directory}`);
}

async function writeNewFile(file: string, content: string): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, content, { flag: "wx" });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

const generatedTsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    useUnknownInCatchVariables: true,
    noEmit: true,
    baseUrl: ".",
    paths: {
      "@/features/*": ["src/features/*/index.ts"],
      "@/*": ["src/*"],
    },
  },
  include: ["src/**/*.ts", "test/**/*.ts"],
};

const generatedCorePackage = {
  name: "agent-native-app",
  private: true,
  version: "0.1.0",
  type: "module",
  typescriptOnRails: {
    packageCapabilities: {},
  },
  scripts: {
    check: "app check",
    test: "app test",
    "test:app": "node --test",
    typecheck: "tsc -p tsconfig.json",
  },
  dependencies: {
    "typescript-on-rails": "^0.1.0",
  },
  devDependencies: {
    "@types/node": "^24.10.0",
    typescript: "5.9.3",
  },
};

export type ApplicationProfile = "fullstack" | "core" | "projects-example";

export interface ApplicationScaffoldOptions {
  readonly profile?: ApplicationProfile;
  readonly fileSystem?: ApplicationScaffoldFileSystem;
}

function isScaffoldFileSystem(value: ApplicationScaffoldFileSystem | ApplicationScaffoldOptions): value is ApplicationScaffoldFileSystem {
  return "createDirectory" in value && "createFile" in value && "removePath" in value;
}

const fullStackTemplateRoot = path.resolve(import.meta.dirname, "../../../templates/fullstack");
const projectsExampleTemplateRoot = path.resolve(import.meta.dirname, "../../../templates/examples/projects");

async function applicationTemplateFiles(root: string, directory = root): Promise<ReadonlyArray<readonly [string, ApplicationScaffoldContent]>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = (await Promise.all(entries.map(async (entry): Promise<ReadonlyArray<readonly [string, ApplicationScaffoldContent]>> => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && [".next", ".typescript-on-rails", "dist", "node_modules"].includes(entry.name)) return [];
    if (entry.isDirectory()) return applicationTemplateFiles(root, target);
    if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) return [];
    if (entry.isFile()) {
      const relative = path.relative(root, target);
      return [[relative === "gitignore" ? ".gitignore" : relative, await readFile(target)]];
    }
    return [];
  }))).flat();
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function applicationPackageName(root: string): string {
  const value = path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._]+/, "");
  return value === "" ? "typescript-on-rails-app" : value;
}

function nameApplicationPackage(files: ReadonlyArray<readonly [string, ApplicationScaffoldContent]>, name: string): ReadonlyArray<readonly [string, ApplicationScaffoldContent]> {
  return files.map(([relative, content]) => {
    if (relative !== "package.json") return [relative, content] as const;
    const source = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
    const packageJson: unknown = JSON.parse(source);
    if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) throw new Error("Template package.json must contain an object");
    Reflect.set(packageJson, "name", name);
    return [relative, `${JSON.stringify(packageJson, null, 2)}\n`] as const;
  });
}

const nodeApplicationScaffoldFileSystem: ApplicationScaffoldFileSystem = {
  async createDirectory(directory) {
    await mkdir(directory, { recursive: true });
  },
  async createFile(file, content) {
    await writeFile(file, content, { flag: "wx" });
  },
  async removePath(target, recursive) {
    await rm(target, { recursive, force: true });
  },
};

async function rollbackApplicationScaffold(
  fileSystem: ApplicationScaffoldFileSystem,
  root: string,
  rootExisted: boolean,
  createdFiles: readonly string[],
  createdDirectories: readonly string[],
): Promise<void> {
  if (!rootExisted) {
    await fileSystem.removePath(root, true);
    return;
  }
  for (const file of [...createdFiles].reverse()) await fileSystem.removePath(file, false);
  for (const directory of [...createdDirectories].reverse()) await fileSystem.removePath(directory, true);
}

export async function createApplication(
  cwd: string,
  target: string,
  options: ApplicationScaffoldFileSystem | ApplicationProfile | ApplicationScaffoldOptions = {},
): Promise<GenerationResult> {
  const fileSystem = typeof options === "string"
    ? nodeApplicationScaffoldFileSystem
    : isScaffoldFileSystem(options)
      ? options
      : options.fileSystem ?? nodeApplicationScaffoldFileSystem;
  const selectedProfile = typeof options === "string"
    ? options
    : isScaffoldFileSystem(options)
      ? "fullstack"
      : options.profile ?? "fullstack";
  const root = safeTarget(cwd, target);
  const rootExisted = await exists(root);
  if (rootExisted) {
    await assertOrdinaryDirectory(root);
    if ((await readdir(root)).length > 0) throw new Error(`Target directory is not empty: ${target}`);
  }
  const templateFiles: ReadonlyArray<readonly [string, ApplicationScaffoldContent]> = selectedProfile === "core"
    ? [
        ["package.json", `${JSON.stringify({ ...generatedCorePackage, name: applicationPackageName(root) }, null, 2)}\n`],
        ["tsconfig.json", `${JSON.stringify(generatedTsconfig, null, 2)}\n`],
        ["src/app.ts", `import { defineApp } from "typescript-on-rails";\n\nexport default defineApp({});\n`],
      ]
    : await applicationTemplateFiles(selectedProfile === "projects-example" ? projectsExampleTemplateRoot : fullStackTemplateRoot);
  const files = nameApplicationPackage(templateFiles, applicationPackageName(root));
  const directories = new Set<string>(selectedProfile === "core" ? [path.join(root, "src", "features")] : []);
  for (const [relative] of files) {
    const directory = path.dirname(path.join(root, relative));
    if (directory !== root) directories.add(directory);
  }
  const orderedDirectories = [...directories].sort((left, right) => left.length - right.length || left.localeCompare(right));
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  try {
    if (!rootExisted) await fileSystem.createDirectory(root);
    for (const directory of orderedDirectories) {
      createdDirectories.push(directory);
      await fileSystem.createDirectory(directory);
    }
    for (const [relative, content] of files) {
      const file = path.join(root, relative);
      createdFiles.push(file);
      await fileSystem.createFile(file, content);
    }
  } catch (error) {
    try {
      await rollbackApplicationScaffold(fileSystem, root, rootExisted, createdFiles, createdDirectories);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Application scaffold failed and rollback was incomplete: ${target}`);
    }
    throw error;
  }
  return { created: files.map(([relative]) => path.join(target, relative)), updated: [], unchanged: [] };
}

function featurePaths(root: string, featureInput: string): { readonly feature: string; readonly directory: string; readonly boundary: string } {
  const feature = kebabCase(featureInput);
  const directory = path.resolve(root, "src", "features", feature);
  const featuresRoot = path.resolve(root, "src", "features");
  if (path.relative(featuresRoot, directory).startsWith("..")) throw new Error(`Invalid feature name: ${featureInput}`);
  return { feature, directory, boundary: path.join(directory, "index.ts") };
}

export interface ProjectGenerationOptions {
  readonly validate?: (root: string) => Promise<void> | void;
}

export type GeneratedOperationAccess =
  | { readonly public: true; readonly permission?: never }
  | { readonly permission: string; readonly public?: never };

interface GeneratedTextFile {
  readonly path: string;
  readonly content: string;
  readonly collision?: boolean;
}

async function ordinaryText(file: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Refusing unsafe file: ${file}`);
    return readFile(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function applicationBoundary(root: string): Promise<{ readonly file: string; readonly source: string }> {
  for (const relative of ["src/app-definition.ts", "src/app.ts"] as const) {
    const file = path.join(root, relative);
    const source = await ordinaryText(file);
    if (source !== undefined) return { file, source };
  }
  throw new Error("Application registration does not exist; expected src/app-definition.ts or src/app.ts");
}

function featureModule(appFile: string, boundary: string): string {
  const relative = path.relative(path.dirname(appFile), boundary).split(path.sep).join("/").replace(/\.ts$/, ".js");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function applyGeneratedFiles(
  root: string,
  files: readonly GeneratedTextFile[],
  options: ProjectGenerationOptions,
  primary: string,
): Promise<GenerationResult> {
  const requests: ProjectEditRequest[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  for (const file of files) {
    const absolute = path.join(root, file.path);
    const current = await ordinaryText(absolute);
    if (current === file.content) continue;
    if (file.collision === true && current !== undefined) throw new Error(`Generated file collision: ${file.path}`);
    if (file.collision === true) requests.push({ path: file.path, content: file.content, ifAbsent: true });
    else requests.push({ path: file.path, content: file.content });
    if (current === undefined) created.push(file.path);
    else updated.push(file.path);
  }
  if (requests.length > 0) {
    const plan = await planProjectEdit(root, requests);
    await executeProjectEdit(plan, options.validate === undefined ? {} : { validate: options.validate });
  } else {
    await options.validate?.(root);
  }
  return {
    created,
    updated,
    unchanged: requests.some(({ path: relative }) => relative === primary) ? [] : [primary],
  };
}

export async function createFeature(
  root: string,
  featureInput: string,
  options: ProjectGenerationOptions = {},
): Promise<GenerationResult> {
  const target = featurePaths(root, featureInput);
  if (await exists(target.directory)) await assertOrdinaryDirectory(target.directory);
  const boundaryRelative = path.relative(root, target.boundary);
  const binding = `${camelCase(target.feature, ARTIFACT_SOURCE_NAME)}Feature`;
  assertGeneratedIdentifier(binding, target.feature);
  const currentBoundary = await ordinaryText(target.boundary);
  const boundary = currentBoundary ?? `import { defineFeature } from "typescript-on-rails";\n\nexport const ${binding} = defineFeature({ name: "${target.feature}" });\n`;
  validateFeatureRegistrationSource(boundary, target.feature);
  const app = await applicationBoundary(root);
  const appSource = updateAppRegistrationSource(app.source, {
    symbol: binding,
    module: featureModule(app.file, target.boundary),
  });
  return applyGeneratedFiles(root, [
    { path: boundaryRelative, content: boundary, collision: currentBoundary === undefined },
    { path: path.relative(root, app.file), content: appSource },
  ], options, boundaryRelative);
}

async function createFeatureArtifact(
  root: string,
  featureInput: string,
  sourceName: string,
  collection: FeatureArtifactCollection,
  fileContent: (exportName: string) => string,
  options: ProjectGenerationOptions,
): Promise<GenerationResult> {
  const target = featurePaths(root, featureInput);
  const boundary = await ordinaryText(target.boundary);
  if (boundary === undefined) throw new Error(`Feature does not exist: ${target.feature}`);
  await assertOrdinaryDirectory(target.directory);
  const exportName = sourceName;
  assertGeneratedIdentifier(exportName, sourceName);
  const fileName = `${kebabCase(sourceName)}.ts`;
  const relative = path.relative(root, path.join(target.directory, fileName));
  const expectedContent = fileContent(exportName);
  const boundarySource = updateFeatureRegistrationSource(boundary, {
    feature: target.feature,
    symbol: exportName,
    module: `./${fileName.slice(0, -3)}.js`,
    collection,
  });
  const app = await applicationBoundary(root);
  const binding = `${camelCase(target.feature, ARTIFACT_SOURCE_NAME)}Feature`;
  const appSource = updateAppRegistrationSource(app.source, {
    symbol: binding,
    module: featureModule(app.file, target.boundary),
  });
  return applyGeneratedFiles(root, [
    { path: relative, content: expectedContent, collision: true },
    { path: path.relative(root, target.boundary), content: boundarySource },
    { path: path.relative(root, app.file), content: appSource },
  ], options, relative);
}

export async function createModel(
  root: string,
  nameInput: string,
  feature: string,
  options: ProjectGenerationOptions = {},
): Promise<GenerationResult> {
  const name = pascalCase(nameInput, ARTIFACT_SOURCE_NAME);
  return createFeatureArtifact(root, feature, name, "models", (exportName) => `import { defineModel, id } from "typescript-on-rails";\n\nexport const ${exportName} = defineModel({\n  name: "${exportName}",\n  fields: {\n    id: id("${exportName}"),\n  },\n});\n`, options);
}

function operationSource(kind: "action" | "query", exportName: string, access: GeneratedOperationAccess): string {
  const accessLine = access.public === true ? "  public: true," : `  permission: ${JSON.stringify(access.permission)},`;
  return `import { ${kind}, object } from "typescript-on-rails";\n\nexport const ${exportName} = ${kind}({\n  input: object({}),\n${accessLine}\n  run: () => undefined,\n});\n`;
}

function validateOperationAccess(access: GeneratedOperationAccess): void {
  if (access.public === true) return;
  if (access.permission.trim() === "" || !/^[a-z][a-z0-9.-]*$/.test(access.permission)) {
    throw new Error(`Invalid generated permission: ${access.permission}`);
  }
}

export async function createAction(
  root: string,
  nameInput: string,
  feature: string,
  access: GeneratedOperationAccess,
  options: ProjectGenerationOptions = {},
): Promise<GenerationResult> {
  validateOperationAccess(access);
  const name = camelCase(nameInput, ARTIFACT_SOURCE_NAME);
  return createFeatureArtifact(root, feature, name, "operations", (exportName) => operationSource("action", exportName, access), options);
}

export async function createQuery(
  root: string,
  nameInput: string,
  feature: string,
  access: GeneratedOperationAccess,
  options: ProjectGenerationOptions = {},
): Promise<GenerationResult> {
  validateOperationAccess(access);
  const name = camelCase(nameInput, ARTIFACT_SOURCE_NAME);
  return createFeatureArtifact(root, feature, name, "operations", (exportName) => operationSource("query", exportName, access), options);
}
