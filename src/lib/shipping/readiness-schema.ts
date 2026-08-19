export const REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT = 1786829940203;

export function privateShippingSchemaIsCurrent(
  latestMigrationAt: number,
): boolean {
  return latestMigrationAt >= REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT;
}
