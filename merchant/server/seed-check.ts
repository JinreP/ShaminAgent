import "server-only";
import type { Db } from "mongodb";
import { demoSeedRecords } from "./seed";
import { adminCollections } from "./admin-store";
import { adminSchemas } from "../private-contracts";
import { merchantIndexes } from "./database";

// Read-only: never initializes collections/indexes, creates a database, or writes fixture/audit records.
export async function inspectSeedTarget(db: Db) {
  const existingCollections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  const warnings = new Set<string>();
  let existingRecords = 0;
  let pendingRecords = 0;
  let fixtureConflicts = 0;
  let retainedAuditConflicts = 0;
  for (const { resource, record } of demoSeedRecords()) {
    const previous = await db.collection(adminCollections[resource]).findOne({ merchantId: record.merchantId, id: record.id });
    if (previous) {
      existingRecords++;
      const { _id, _version, ...domain } = previous;
      void _id; void _version;
      const parsed = adminSchemas[resource].safeParse(domain);
      if (!parsed.success || parsed.data.mode !== "simulated" || (resource === "profile" && "kind" in parsed.data && "kind" in record && parsed.data.kind !== record.kind)) fixtureConflicts++;
    } else {
      pendingRecords++;
      if (await db.collection("merchant_audit_events").findOne({ merchantId: record.merchantId, id: `seed-${resource}-${record.id}` }, { projection: { _id: 1 } })) retainedAuditConflicts++;
    }
  }
  let collectionsMissing = 0;
  let expectedIndexesMissing = 0;
  for (const [collection, expected] of Object.entries(merchantIndexes)) {
    if (!existingCollections.has(collection)) { collectionsMissing++; expectedIndexesMissing += expected.length; continue; }
    const actual = await db.collection(collection).listIndexes().toArray();
    for (const index of expected) {
      const matchesOptions = (i: (typeof actual)[number]) => Boolean(i.unique) === Boolean(index.unique)
        && Boolean(i.sparse) === Boolean(index.sparse)
        && JSON.stringify(i.partialFilterExpression) === JSON.stringify(index.partialFilterExpression)
        && i.expireAfterSeconds === index.expireAfterSeconds
        && (!i.collation || i.collation.locale === "simple");
      const found = actual.find(i => JSON.stringify(i.key) === JSON.stringify(index.key) && matchesOptions(i));
      if (!found) expectedIndexesMissing++;
      if (index.name && actual.some(i => i.name === index.name && (JSON.stringify(i.key) !== JSON.stringify(index.key) || !matchesOptions(i)))) warnings.add("Existing named index conflicts with an expected merchant index.");
      if (actual.some(i => JSON.stringify(i.key) === JSON.stringify(index.key) && !matchesOptions(i))) warnings.add("Existing merchant index keys have conflicting uniqueness, sparse, partial, TTL or collation options.");
    }
  }
  if (fixtureConflicts) warnings.add("Existing fixture identities contain invalid or non-simulated records; do not seed.");
  if (retainedAuditConflicts) warnings.add("An absent fixture still has its deterministic seed audit; a seed would fail with duplicate key.");
  if (collectionsMissing || expectedIndexesMissing) warnings.add("Normal seeding would create collections/indexes outside the data transaction; shared-database review is required.");
  warnings.add("Read-only checks do not prove write/index permissions or absence of all duplicate data across shared collections.");
  return { databaseAlreadyExists: existingCollections.size > 0, existingRecords, pendingRecords,
    fixtureConflicts, retainedAuditConflicts, collectionsMissing, expectedIndexesMissing, warnings: Array.from(warnings) };
}
