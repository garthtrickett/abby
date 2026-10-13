import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { LocationScope } from "../core/model.ts";
import { readOwnerJson } from "../shared/owner-json.ts";
import { operationalDays } from "../voice/operational-counts.ts";
import { decodeOperationalAlert, operationalAlertKey, parseAggregateAlertThresholds, validAlertScope, validOperationalAlert } from "./operational-alert.ts";
import type { OperationalAlert, AggregateAlertThresholds } from "./operational-alert.ts";

export type VoiceAlertInboxConfig = Readonly<{ scope: LocationScope; tokenHex: string; thresholds: AggregateAlertThresholds;
  directory: string; clock?: () => string }>;
const unavailable = () => new Error("operational alert inbox unavailable");
const pendingName = /^\.pending-[a-f0-9-]{36}$/;
const receiptName = /^\d{4}-\d{2}-\d{2}-[A-Za-z][A-Za-z0-9]+-[1-9][0-9]{0,15}\.json$/;
const filename = (alert: OperationalAlert) => `${alert.date}-${alert.kind}-${alert.threshold}.json`;
const equal = (left: string, right: string) => Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

/** An owner-controlled aggregate inbox, not a pager or human acknowledgment.
 * One immutable receipt per logical crossing; first count stays the first count.
 * Atomic file links deduplicate across processes and restarts without patient,
 * call, recipient, token, webhook key or event timestamp persistence. */
export class VoiceOperationalAlertInbox {
  readonly #config: VoiceAlertInboxConfig;
  readonly #directory: string;
  constructor(config: VoiceAlertInboxConfig) {
    if (!config || !validAlertScope(config.scope) || typeof config.tokenHex !== "string" || !/^[a-f0-9]{64}$/i.test(config.tokenHex) ||
        typeof config.directory !== "string" || !isAbsolute(config.directory) || resolve(config.directory) !== config.directory ||
        typeof process.getuid !== "function" || (config.clock !== undefined && typeof config.clock !== "function")) throw new RangeError("invalid operational alert inbox configuration");
    const thresholds = Object.freeze({ ...parseAggregateAlertThresholds(JSON.stringify(config.thresholds)) });
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }), thresholds });
    this.#directory = join(config.directory, createHash("sha256").update(JSON.stringify([config.scope.tenantId, config.scope.clinicId, config.scope.locationId])).digest("hex"));
  }
  #days() { return operationalDays((this.#config.clock ?? (() => new Date().toISOString()))()); }
  binding(): LocationScope { return { ...this.#config.scope }; }
  async #privateDirectory(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || await realpath(path) !== path) throw unavailable();
  }
  async #syncDirectory(path = this.#directory) {
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async #prepare() {
    await this.#privateDirectory(this.#config.directory);
    await mkdir(this.#directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await this.#privateDirectory(this.#directory); await this.#syncDirectory(this.#config.directory);
  }
  async #receipt(name: string): Promise<OperationalAlert> {
    const value = await readOwnerJson(join(this.#directory, name), 512);
    if (!validOperationalAlert(value) || filename(value) !== name) throw unavailable();
    return value;
  }
  async #scan(): Promise<OperationalAlert[]> {
    await this.#prepare(); const days = this.#days(), oldest = days[0]!, today = days.at(-1)!;
    const directory = await opendir(this.#directory), receipts: OperationalAlert[] = []; let visited = 0, pruned = false;
    try {
      for await (const entry of directory) {
        if (++visited > 512) throw unavailable();
        if (pendingName.test(entry.name)) {
          const stat = await lstat(join(this.#directory, entry.name)).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
          if (!stat) continue;
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > 512) throw unavailable();
          // Only this module's abandoned temporary names, never unknown files.
          if (Date.now() - stat.mtimeMs > 86_400_000) { await unlink(join(this.#directory, entry.name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); pruned = true; }
          continue;
        }
        if (!receiptName.test(entry.name)) throw unavailable();
        let receipt: OperationalAlert;
        try { receipt = await this.#receipt(entry.name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (receipt.date < oldest) { await unlink(join(this.#directory, entry.name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); pruned = true; }
        else if (receipt.date > today) throw unavailable();
        else receipts.push(receipt);
      }
    } finally { await directory.close().catch(() => {}); }
    if (pruned) await this.#syncDirectory();
    return receipts.sort((a, b) => filename(a).localeCompare(filename(b)));
  }

  /** Authenticate and decode before touching storage. No retry or human delivery claim. */
  async accept(value: unknown, authorization: unknown, idempotencyKey: unknown, signal: AbortSignal): Promise<"accepted" | "invalid" | "unavailable"> {
    if (!(signal instanceof AbortSignal) || signal.aborted || typeof authorization !== "string" ||
        !equal(authorization, `Bearer ${this.#config.tokenHex}`)) return "invalid";
    let alert;
    try {
      alert = decodeOperationalAlert(value);
      if (!alert || !this.#days().includes(alert.date) || this.#config.thresholds[alert.kind] !== alert.threshold ||
          typeof idempotencyKey !== "string" || idempotencyKey !== alert.alertKey ||
          !equal(alert.alertKey, operationalAlertKey(this.#config.scope, alert.date, alert.kind, alert.threshold, this.#config.tokenHex))) return "invalid";
    } catch { return "invalid"; }
    const receipt: OperationalAlert = { date: alert.date, kind: alert.kind, count: alert.count, threshold: alert.threshold };
    const destination = join(this.#directory, filename(receipt)), temporary = join(this.#directory, `.pending-${randomUUID()}`);
    let created = false;
    try {
      await this.#scan(); if (signal.aborted) return "unavailable";
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
      try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
      if (signal.aborted) return "unavailable";
      try { await link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const saved = await this.#receipt(filename(receipt));
      if (saved.date !== receipt.date || saved.kind !== receipt.kind || saved.threshold !== receipt.threshold) throw unavailable();
      await this.#syncDirectory(); return signal.aborted ? "unavailable" : "accepted";
    } catch { return "unavailable"; }
    finally { if (created) await unlink(temporary).catch(() => {}); }
  }
  async snapshot(): Promise<Readonly<{ schemaVersion: 1; alerts: readonly OperationalAlert[] }>> {
    try { return { schemaVersion: 1, alerts: await this.#scan() }; } catch { throw unavailable(); }
  }
}
