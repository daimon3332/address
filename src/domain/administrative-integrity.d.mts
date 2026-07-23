export interface AdministrativeHierarchyInput {
  countryCode?: string;
  admin1?: string;
  admin1Code?: string;
}

export type AdministrativeHierarchyResult =
  | { valid: true }
  | { valid: false; reason: string };

export function validateAdministrativeHierarchy(
  input?: AdministrativeHierarchyInput
): AdministrativeHierarchyResult;

export function normalizeAddressComponents<T extends {
  locality?: string;
  postalLocality?: string;
  postcode?: string;
}>(countryCode: string, components: T): T;
