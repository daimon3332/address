export interface NonResidentialMatchInput {
  countryCode?: string;
  buildingName?: string;
  buildingNames?: string[];
  formattedAddress?: string;
  formattedAddresses?: string[];
  street?: string;
  streets?: string[];
  propertyType?: string;
  classifications?: string[];
}

export type NonResidentialCategory =
  | 'government'
  | 'military_law_justice'
  | 'education_research'
  | 'healthcare_care'
  | 'finance'
  | 'fire_utilities'
  | 'transport_logistics'
  | 'religious_funeral_public'
  | 'hospitality_commercial_industrial';

export type NonResidentialMatch =
  | { excluded: false }
  | { excluded: true; category: NonResidentialCategory; term: string; field: 'classification' | 'buildingName' | 'formattedAddress' };

export function findNonResidentialMatch(input?: NonResidentialMatchInput): NonResidentialMatch;
export function isNonResidentialAddress(input: NonResidentialMatchInput): boolean;
export function isVerifiedAddressNonResidential(address: import('./types').VerifiedAddress): boolean;
