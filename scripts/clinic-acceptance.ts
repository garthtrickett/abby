import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readOwnerJson } from "../src/shared/owner-json.ts";
import { assessClinicAcceptance, clinicSetupAreas, prepareClinicAcceptance, validClinicTrialBinding } from "../src/standalone/clinic-acceptance-workbook.ts";
import type { ClinicTrialBinding } from "../src/standalone/clinic-acceptance-workbook.ts";

const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Reads only the six explicitly named owner configuration files. It does not
 * read .env, contact Cliniko, submit payments, send alerts or grant authority. */
export async function readClinicTrialBinding(configPath: string): Promise<ClinicTrialBinding> {
  const config = await readOwnerJson(configPath, 8192);
  if (!exact(config, ["schemaVersion", "scope", "country", "files"]) || config.schemaVersion !== 1 || !exact(config.files, clinicSetupAreas))
    throw Error("clinic worksheet unavailable");
  const files = config.files;
  const snapshot = async () => {
    const configuration = {} as Record<typeof clinicSetupAreas[number], string | null>;
    for (const area of clinicSetupAreas) {
      const path = files[area];
      if (path !== null && (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || !path.endsWith(".json"))) throw Error("clinic worksheet unavailable");
      configuration[area] = path === null ? null : hash(await readOwnerJson(path as string, 8192));
    }
    return configuration;
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  const source = () => {
    const changes = git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(line => line && line !== "?? node_modules");
    if (changes.length) throw Error("clinic worksheet unavailable");
    return git(["rev-parse", "HEAD"]);
  };
  const sourceCommit = source(), configuration = await snapshot();
  // Config/checkout drift during capture is unavailable rather than a mixed snapshot.
  if (hash(await readOwnerJson(configPath, 8192)) !== hash(config) || hash(await snapshot()) !== hash(configuration) || source() !== sourceCommit)
    throw Error("clinic worksheet unavailable");
  const binding = { sourceCommit, scope: config.scope, country: config.country, configuration };
  if (!validClinicTrialBinding(binding)) throw Error("clinic worksheet unavailable");
  return binding;
}

export async function runClinicAcceptance(args: readonly string[]): Promise<ReturnType<typeof assessClinicAcceptance>> {
  const [mode, configArg, fileArg] = args;
  if (args.length !== 3 || !["prepare", "check"].includes(String(mode)) || !configArg?.startsWith("--config=") ||
      !fileArg?.startsWith(mode === "prepare" ? "--out=" : "--report=")) throw Error("clinic worksheet unavailable");
  const config = configArg.slice(9), path = fileArg.slice(fileArg.indexOf("=") + 1);
  if (!isAbsolute(path)) throw Error("clinic worksheet unavailable");
  const binding = await readClinicTrialBinding(config), now = new Date().toISOString();
  if (mode === "prepare") {
    const workbook = prepareClinicAcceptance(binding, now);
    // Refuse overwrite: a new candidate/configuration gets a distinct worksheet.
    await writeFile(path, `${JSON.stringify(workbook, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return assessClinicAcceptance(workbook, binding, now);
  }
  const workbook = await readOwnerJson(path, 16384), current = await readClinicTrialBinding(config);
  return assessClinicAcceptance(workbook, current, new Date().toISOString());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runClinicAcceptance(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (process.argv[2] === "check" && result.status !== "observationsRecorded") process.exitCode = 2;
  }).catch(() => { process.stderr.write("Clinic acceptance worksheet unavailable\n"); process.exitCode = 1; });
}
