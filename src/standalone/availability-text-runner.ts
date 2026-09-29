import type { Kysely } from "kysely";
import type { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import type { LocationScope } from "../core/model.ts";
import { AvailabilityTextRunner } from "../reference/availability-text-runner.ts";
import type Database from "../storage/generated/Database.ts";
import { createStandaloneTextComposition } from "./text-composition.ts";

export type { AvailabilityTextRequest, PreparedAvailabilityText, AvailabilityTextFailure } from "../reference/availability-text-runner.ts";

/** Strict PostgreSQL composition for the shared transient text availability flow. */
export class StandaloneAvailabilityTextRunner extends AvailabilityTextRunner {
  constructor(db: Kysely<Database>, scope: LocationScope, reader: ClinikoAvailabilityReader,
              clock: () => string = () => new Date().toISOString()) {
    super(createStandaloneTextComposition(db, reader).reception, scope, clock);
  }
}
