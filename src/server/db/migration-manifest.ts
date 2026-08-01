/**
 * GENERATED FILE — do not edit.
 *
 * Written by `scripts/generate-migration-manifest.ts` from `db/migrations`.
 * Run `npm run migrations:manifest` after adding a migration;
 * `tests/unit/health.test.ts` fails if this is stale.
 *
 * This is what the *running build* expects the schema to be. Compared against
 * `schema_migrations` at startup and on every health check, because
 * production once ran code whose queries named a column the schema did not
 * have, and the only symptom was a 500 with no clue in it.
 */

export interface ExpectedMigration {
  version: string;
  checksum: string;
}

export const EXPECTED_MIGRATIONS: readonly ExpectedMigration[] = [
  { version: "0001_init.sql", checksum: "7168ac6660f72e280593ddfba387a6968e0e3881d9b5bc19c699682572921e25" },
  { version: "0002_mobile.sql", checksum: "c41ba3527721e3ffdf1b249e1f910993545b53b79c41edc4d2b06b35d435867d" },
  { version: "0003_native_auth.sql", checksum: "419a189227307d2cff1353e127c0b9a9ea58a4ef8add742856e2b648034e6ebc" },
  { version: "0004_invitations.sql", checksum: "b22e8e24caf1e3a3140497049573cf4c7c1bff16a6c9237be47a9867fc45e0c2" },
  { version: "0005_roles_and_services.sql", checksum: "1904232b64ffff710e052fc462aec0f2415b0ead6b83a3b7510e939eeb919b42" },
  { version: "0006_supporting_indexes.sql", checksum: "d4676202ed5dc300cdf25f188a75c143d4368af2b89b85a1784cc8afdf1f4538" },
  { version: "0007_notification_route.sql", checksum: "728ed1c593534f5840851d7ece884ead569d7413d38958b358e80c80768e375b" },
  { version: "0008_scheduler_foundation.sql", checksum: "5421f0ca95b995f8f20cf6596b59399b517a01194ce8d3c727a859fef655d184" },
  { version: "0009_schedule_operations.sql", checksum: "c36e7c7bb0eac856a662cb63f00bff35de6e6b5067aa9951392990eb065f9484" },
  { version: "0010_beta_onboarding.sql", checksum: "f768d83a868af86e3efa7ce7896c351c88d8ad94ce9971b1d31169cf53495640" },
  { version: "0011_pending_enrollment.sql", checksum: "b7f837fcab9fa68058ff104b3bdf025fb160d3c9c7b6fdd931d3b33e10f4095a" },
  { version: "0012_assisted_import.sql", checksum: "60e4a638f675bd3526aff50879c81e093ae7bb92e6e6028a78ccb6aaef7214b7" },
];
