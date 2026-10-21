import type { LocationScope } from "../../src/core/model.ts";
import { validRecallMarker } from "../../src/cliniko/recall-note.ts";

class Counter {
  #value: number = 0;
  next(): number { return ++this.#value; }
}
const scope: Readonly<LocationScope> = { tenantId: "loader-fixture", clinicId: "fixture", locationId: "fixture" };
const result = { sourceUrl: import.meta.url, scope: scope.tenantId, marker: validRecallMarker("11111111-1111-4111-8111-111111111111"), count: new Counter().next() };
if (process.send) process.send(result, () => process.disconnect?.());
else process.stdout.write(JSON.stringify(result) + "\n");
