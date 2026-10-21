import test from "node:test";
import { outboundMemoFixture } from "../support/outbound-memo.ts";

for (const operation of ["book", "cancel", "reschedule"] as const)
for (const mode of ["accepted", "wrongSubjectGrant", "withdrawn", "lostStored"] as const)
test(`signed outgoing ${operation} retains only the original verified patient's independent memo: ${mode}`, { timeout: 45000 }, async t => {
  const c = await outboundMemoFixture(operation, mode); t.after(c.close);
  await c.complete();
});
