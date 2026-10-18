import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, value } from "./financial-retention.ts";
import { OwnerFileFinancialSource, financialSourceSelection } from "../../src/standalone/owner-file-financial-source.ts";
import type { FinancialSourceApproval } from "../../src/standalone/owner-file-financial-source.ts";
import type { AdminAccount, AdminDirectory } from "../../src/standalone/identity/magic-link.ts";
export async function financialSourceApprovalFixture() {
  const native = fixture().config, selection = value(financialSourceSelection(native, { version: "financial-records-v1", digest: "a".repeat(64) }));
  const folder = await mkdtemp(join(tmpdir(), "abby-financial-source-")), path = join(folder, "source.json");
  const state = { now: "2026-11-02T00:00:00.000Z", account: { email: "financial-admin@example.invalid", membershipVersion: "1",
    actor: { actorRef: "financial-admin", role: "clinicAdmin", scope: selection.scope } } as AdminAccount | undefined };
  const directory: AdminDirectory = { findByRef: async () => ({ ok: true, value: state.account }), findByEmail: async () => ({ ok: true, value: state.account }) };
  const { scope, ...source } = selection;
  const approval: FinancialSourceApproval = { scope, revision: "financial-source-v1", approverRef: "financial-admin", approvedAt: "2026-11-01T00:00:00.000Z",
    effectiveFrom: "2026-11-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z", approved: true, enabled: true, source };
  try {
    await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const config = { path, scope, directory, clock: () => state.now };
    const definition = value(await OwnerFileFinancialSource.capture(config, new AbortController().signal));
    return { native, selection, approval, config, definition, directory, state, path,
      replace: (patch: Record<string, unknown>) => writeFile(path, JSON.stringify({ ...approval, ...patch })),
      close: () => rm(folder, { recursive: true, force: true }) };
  } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
}
