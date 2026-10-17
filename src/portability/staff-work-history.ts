import { outboundEffectArchiveRecord, validOutboundEffectHistory } from "./outbound-effect-history.ts";
import { createHash } from "node:crypto";
import type { TenantConfigArchiveData } from "./config-archive.ts";
import { confirmationResendArchiveRecord, validConfirmationResendArchiveHistory } from "./confirmation-resend-history.ts";
import { financialEffectArchiveRecord, validFinancialEffectHistory } from "./financial-effect-history.ts";

/** All barrier families share one section. Verify its entire canonical bytes;
 * verifying only one family's projection would reject valid mixed imports or
 * allow another family's retained history to escape digest checking. */
export function validStaffWorkHistoryManifest(data: TenantConfigArchiveData): boolean {
  try {
    const records: (ReturnType<typeof confirmationResendArchiveRecord> | ReturnType<typeof financialEffectArchiveRecord> | ReturnType<typeof outboundEffectArchiveRecord>)[] = [];
    const resend = new Set<string>(), financial = new Set<string>(), outbound = new Set<string>();
    for (const location of data.locations) {
      if (!validConfirmationResendArchiveHistory(location.confirmationResends) || !validFinancialEffectHistory(location.financialEffects) || !validOutboundEffectHistory(location.outboundEffects)) return false;
      for (const row of location.confirmationResends ?? []) {
        if (resend.has(row.requestRef)) return false;
        resend.add(row.requestRef); records.push(confirmationResendArchiveRecord(location.sourceScope, row));
      }
      for (const row of location.financialEffects ?? []) {
        if (financial.has(row.effectRef)) return false;
        financial.add(row.effectRef); records.push(financialEffectArchiveRecord(location.sourceScope, row));
      }
      for (const row of location.outboundEffects ?? []) {
        if (outbound.has(row.effectRef)) return false;
        outbound.add(row.effectRef); records.push(outboundEffectArchiveRecord(location.sourceScope, row));
      }
    }
    records.sort((a, b) => Buffer.compare(Buffer.from(a.recordId), Buffer.from(b.recordId)));
    const hash = createHash("sha256"); let bytes = 0;
    for (const row of records) {
      const next = Buffer.from(JSON.stringify(row) + "\n"); bytes += next.byteLength;
      if (bytes > 64 * 1024 * 1024) return false;
      hash.update(next);
    }
    const manifest = data.sectionManifests.staffWork;
    return manifest.version === 1 && manifest.recordCount === records.length && manifest.byteCount === bytes && manifest.sha256 === hash.digest("hex");
  } catch { return false; }
}
