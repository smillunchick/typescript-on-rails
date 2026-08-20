import { readFile } from "node:fs/promises";
import path from "node:path";

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export async function hasAppOwnedScript(root: string, script: string): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(path.join(root, "package.json"), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  const packageJson: unknown = JSON.parse(source);
  if (!isRecord(packageJson)) return false;
  const scripts = packageJson["scripts"];
  return isRecord(scripts) && typeof scripts[script] === "string";
}
