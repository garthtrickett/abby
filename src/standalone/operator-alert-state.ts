import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { LocationScope } from "../core/model.ts";
import { readOwnerJson } from "../shared/owner-json.ts";
import { approvalInstant, approvalRef } from "./owner-file-clinic-approval.ts";
import { validAlertScope, validOperationalAlert } from "./operational-alert.ts";
import type { OperationalAlert } from "./operational-alert.ts";

export type OperatorAlertState = Readonly<{ schemaVersion: 1; version: number; alert: OperationalAlert;
  policyFingerprint: string; firstObservedAt: string;
  acknowledgment: Readonly<{ actorRef: string; membershipFingerprint: string; at: string }> | null }>;
const unavailable = () => new Error("operator alert state unavailable");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (alert: OperationalAlert) => hash([alert.date, alert.kind, alert.threshold]);
const validHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function valid(value: unknown): value is OperatorAlertState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>, ack = row.acknowledgment as Record<string, unknown> | null;
  return Object.keys(row).sort().join("|") === "acknowledgment|alert|firstObservedAt|policyFingerprint|schemaVersion|version" && row.schemaVersion === 1 &&
    Number.isSafeInteger(row.version) && Number(row.version) >= 0 && Number(row.version) <= 16384 && validOperationalAlert(row.alert) &&
    validHash(row.policyFingerprint) && approvalInstant(row.firstObservedAt) !== undefined &&
    (ack === null || (!!ack && typeof ack === "object" && !Array.isArray(ack) && Object.keys(ack).sort().join("|") === "actorRef|at|membershipFingerprint" &&
      approvalRef(ack.actorRef) && validHash(ack.membershipFingerprint) && approvalInstant(ack.at) !== undefined && Date.parse(String(ack.at)) >= Date.parse(String(row.firstObservedAt))));
}

/** Non-patient operator governance only. Immutable versions provide one-winner
 * publication across processes without retaining a session, credential, call,
 * patient, note or clinical-action key. Operator observation/action times are
 * separate from the timestamp-free transport receipt. */
export class OperatorAlertStateStore {
  readonly #root: string;
  readonly #scopeRoot: string;
  constructor(directory: string, scope: LocationScope) {
    if (!isAbsolute(directory) || resolve(directory) !== directory || !validAlertScope(scope) || typeof process.getuid !== "function") throw unavailable();
    this.#root = directory; this.#scopeRoot = join(directory, hash([scope.tenantId, scope.clinicId, scope.locationId]));
  }
  async #private(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || await realpath(path) !== path) throw unavailable();
  }
  async #sync(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await file.sync(); } finally { await file.close(); }
  }
  async #directory(alert?: OperationalAlert) {
    await this.#private(this.#root);
    await mkdir(this.#scopeRoot, { mode: 0o700 }).catch(e => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; });
    await this.#private(this.#scopeRoot); await this.#sync(this.#root);
    if (!alert) return this.#scopeRoot;
    const path = join(this.#scopeRoot, identity(alert));
    await mkdir(path, { mode: 0o700 }).catch(e => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; });
    await this.#private(path); await this.#sync(this.#scopeRoot); return path;
  }
  async read(alert: OperationalAlert): Promise<OperatorAlertState | undefined> {
    if (!validOperationalAlert(alert)) throw unavailable();
    const path = await this.#directory(alert), directory = await opendir(path), versions: number[] = []; let count = 0;
    for await (const entry of directory) {
      if (++count > 16448) throw unavailable();
      const stat = await lstat(join(path, entry.name)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && entry.name.startsWith(".pending-")) return undefined;
        throw error;
      });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > 2048) throw unavailable();
      if (/^\.pending-[a-f0-9-]{36}$/.test(entry.name)) {
        if (Date.now() - stat.mtimeMs > 86_400_000) await unlink(join(path, entry.name)).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        continue;
      }
      if (!/^(?:0|[1-9][0-9]{0,4})\.json$/.test(entry.name)) throw unavailable();
      const version = Number(entry.name.split(".")[0]); if (version > 16384) throw unavailable(); versions.push(version);
    }
    versions.sort((a, b) => a - b); if (!versions.length) return undefined;
    if (versions.some((v, i) => v !== i)) throw unavailable();
    const record = await readOwnerJson(join(path, `${versions.at(-1)}.json`), 2048), first = await readOwnerJson(join(path, "0.json"), 2048);
    if (!valid(record) || !valid(first) || record.version !== versions.at(-1) || first.version !== 0 ||
        identity(record.alert) !== identity(alert) || record.alert.count !== alert.count || hash(record.alert) !== hash(first.alert) ||
        record.firstObservedAt !== first.firstObservedAt) throw unavailable();
    return record;
  }
  async compareAndSet(expected: number | undefined, next: OperatorAlertState): Promise<boolean> {
    if (!valid(next) || next.version !== (expected === undefined ? 0 : expected + 1)) throw unavailable();
    const current = await this.read(next.alert);
    if (current?.version !== expected || (current && (hash(current.alert) !== hash(next.alert) || current.firstObservedAt !== next.firstObservedAt))) return false;
    const path = await this.#directory(next.alert), temporary = join(path, `.pending-${randomUUID()}`); let created = false;
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, join(path, `${next.version}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
      await this.#sync(path); return true;
    } finally { if (created) await unlink(temporary).catch(() => {}); }
  }
  async prune(oldestDay: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(oldestDay) || new Date(`${oldestDay}T00:00:00.000Z`).toISOString().slice(0, 10) !== oldestDay) throw unavailable();
    const path = await this.#directory(), directory = await opendir(path); let count = 0;
    for await (const entry of directory) {
      if (++count > 512 || !/^[a-f0-9]{64}$/.test(entry.name)) throw unavailable();
      const child = join(path, entry.name); await this.#private(child);
      let first: unknown;
      try { first = await readOwnerJson(join(child, "0.json"), 2048); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const pending = await opendir(child); let visited = 0;
        for await (const file of pending) {
          if (++visited > 64 || !/^\.pending-[a-f0-9-]{36}$/.test(file.name)) throw unavailable();
          const stat = await lstat(join(child, file.name)).catch(e => {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e;
          });
          if (stat && (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > 2048)) throw unavailable();
        }
        continue;
      }
      if (!valid(first) || first.version !== 0 || identity(first.alert) !== entry.name) throw unavailable();
      if (first.alert.date < oldestDay) {
        const files = await opendir(child), names: string[] = [];
        for await (const file of files) {
          // Never remove a live writer's temporary file or unknown owner data.
          if (file.name.startsWith(".pending-")) {
            const stat = await lstat(join(child, file.name));
            if (!/^\.pending-[a-f0-9-]{36}$/.test(file.name) || !stat.isFile() || stat.uid !== process.getuid!() ||
                (stat.mode & 0o077) !== 0 || stat.size > 2048 || Date.now() - stat.mtimeMs <= 86_400_000) throw unavailable();
            await unlink(join(child, file.name)); continue;
          }
          if (names.length >= 16385) throw unavailable();
          const record = await readOwnerJson(join(child, file.name), 2048);
          if (!valid(record) || hash(record.alert) !== hash(first.alert) || record.firstObservedAt !== first.firstObservedAt ||
              `${record.version}.json` !== file.name) throw unavailable();
          names.push(file.name);
        }
        // Keep the expired initial record until last so interrupted pruning
        // remains recoverable without treating unknown data as our own.
        names.sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
        for (const name of names) await unlink(join(child, name));
        await rmdir(child); await this.#sync(path);
      }
    }
  }
}
