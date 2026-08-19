import { constants } from "node:fs";
import { access, appendFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GenerationResult {
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
}

const SOURCE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function words(value: string): string[] {
  if (!SOURCE_NAME.test(value)) throw new Error(`Invalid name: ${value}`);
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

function pascalCase(value: string): string {
  return words(value).map((entry) => entry[0]?.toUpperCase() + entry.slice(1)).join("");
}

function camelCase(value: string): string {
  const pascal = pascalCase(value);
  return `${pascal[0]?.toLowerCase() ?? ""}${pascal.slice(1)}`;
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
  },
  include: ["src/**/*.ts", "test/**/*.ts"],
};

const generatedPackage = {
  name: "agent-native-app",
  private: true,
  version: "0.1.0",
  type: "module",
  scripts: {
    "dev:app": "tsx watch src/app.ts",
    "build:app": "tsc -p tsconfig.json",
    "test:app": "node --import tsx --test test/*.test.ts",
  },
  dependencies: {
    "typescript-on-rails": "^0.1.0",
  },
  devDependencies: {
    "@types/node": "^24.10.0",
    tsx: "^4.20.6",
    typescript: "^5.9.3",
  },
};

export async function createApplication(cwd: string, target: string): Promise<GenerationResult> {
  const root = safeTarget(cwd, target);
  if (await exists(root)) {
    await assertOrdinaryDirectory(root);
    if ((await readdir(root)).length > 0) throw new Error(`Target directory is not empty: ${target}`);
  } else {
    await mkdir(root, { recursive: true });
  }
  await mkdir(path.join(root, "src", "features"), { recursive: true });
  const files: ReadonlyArray<readonly [string, string]> = [
    ["package.json", `${JSON.stringify(generatedPackage, null, 2)}\n`],
    ["tsconfig.json", `${JSON.stringify(generatedTsconfig, null, 2)}\n`],
    ["src/app.ts", `import { defineApp } from "typescript-on-rails";\n\nexport default defineApp();\n`],
  ];
  for (const [relative, content] of files) await writeFile(path.join(root, relative), content, { flag: "wx" });
  return { created: files.map(([relative]) => path.join(target, relative)), unchanged: [] };
}

function featurePaths(root: string, featureInput: string): { readonly feature: string; readonly directory: string; readonly boundary: string } {
  const feature = kebabCase(featureInput);
  const directory = path.resolve(root, "src", "features", feature);
  const featuresRoot = path.resolve(root, "src", "features");
  if (path.relative(featuresRoot, directory).startsWith("..")) throw new Error(`Invalid feature name: ${featureInput}`);
  return { feature, directory, boundary: path.join(directory, "index.ts") };
}

export async function createFeature(root: string, featureInput: string): Promise<GenerationResult> {
  const target = featurePaths(root, featureInput);
  if (await exists(target.directory)) await assertOrdinaryDirectory(target.directory);
  await mkdir(target.directory, { recursive: true });
  const created = await writeNewFile(target.boundary, "export {};\n");
  const relative = path.relative(root, target.boundary);
  return created ? { created: [relative], unchanged: [] } : { created: [], unchanged: [relative] };
}

async function appendPublicExport(boundary: string, line: string): Promise<boolean> {
  const current = await import("node:fs/promises").then(({ readFile }) => readFile(boundary, "utf8"));
  if (current.split("\n").includes(line)) return false;
  await appendFile(boundary, `${current.endsWith("\n") ? "" : "\n"}${line}\n`);
  return true;
}

async function createFeatureArtifact(
  root: string,
  featureInput: string,
  sourceName: string,
  fileContent: (exportName: string) => string,
): Promise<GenerationResult> {
  const target = featurePaths(root, featureInput);
  if (!(await exists(target.boundary))) throw new Error(`Feature does not exist: ${target.feature}`);
  await assertOrdinaryDirectory(target.directory);
  const exportName = sourceName;
  const fileName = `${kebabCase(sourceName)}.ts`;
  const file = path.join(target.directory, fileName);
  const created = await writeNewFile(file, fileContent(exportName));
  const exportLine = `export { ${exportName} } from "./${fileName.slice(0, -3)}.js";`;
  const exported = await appendPublicExport(target.boundary, exportLine);
  const relative = path.relative(root, file);
  return {
    created: [...(created ? [relative] : []), ...(exported ? [path.relative(root, target.boundary)] : [])],
    unchanged: created ? [] : [relative],
  };
}

export async function createModel(root: string, nameInput: string, feature: string): Promise<GenerationResult> {
  const name = pascalCase(nameInput);
  return createFeatureArtifact(root, feature, name, (exportName) => `import { defineModel, id } from "typescript-on-rails";\n\nexport const ${exportName} = defineModel({\n  name: "${exportName}",\n  fields: {\n    id: id("${exportName}"),\n  },\n});\n`);
}

function operationSource(kind: "action" | "query", exportName: string): string {
  const authorizationComment = kind === "action"
    ? "  // Choose public, permission, or authorize before adding protected behavior.\n"
    : "";
  return `import { ${kind}, object } from "typescript-on-rails";\n\nexport const ${exportName} = ${kind}({\n  input: object({}),\n${authorizationComment}  public: true,\n  run: () => undefined,\n});\n`;
}

export async function createAction(root: string, nameInput: string, feature: string): Promise<GenerationResult> {
  const name = camelCase(nameInput);
  return createFeatureArtifact(root, feature, name, (exportName) => operationSource("action", exportName));
}

export async function createQuery(root: string, nameInput: string, feature: string): Promise<GenerationResult> {
  const name = camelCase(nameInput);
  return createFeatureArtifact(root, feature, name, (exportName) => operationSource("query", exportName));
}
