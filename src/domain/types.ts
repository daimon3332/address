export type Locale = 'en' | 'zh-CN';
export type AddressLanguage = 'native' | 'en' | 'zh-CN';

export type CountryCode =
  | 'US' | 'CA' | 'MX' | 'GB' | 'DE' | 'FR' | 'IT' | 'ES' | 'NL' | 'RU'
  | 'JP' | 'HK' | 'SG' | 'TW' | 'KR' | 'MY' | 'CN' | 'TH' | 'PH' | 'VN'
  | 'TR' | 'SA' | 'IN' | 'AU' | 'BR' | 'NG' | 'ZA';

export type CountryGroup =
  | 'north-america'
  | 'europe'
  | 'east-asia'
  | 'southeast-asia'
  | 'south-asia'
  | 'oceania'
  | 'middle-east'
  | 'south-america'
  | 'africa';

export type Readiness = 'strict' | 'partial' | 'research';
export type PropertyType = 'residential' | 'apartment' | 'commercial' | 'mixed' | 'unknown';
export type UnitStatus = 'verified' | 'building_only' | 'not_present' | 'unknown';

export interface SourceDefinition {
  id: string;
  name: string;
  url: string;
  role: 'address' | 'residential' | 'building' | 'admin' | 'secondary';
  updateCadence: string;
  priority: 'primary' | 'fallback';
}

export interface LocalizedText {
  en: string;
  'zh-CN': string;
}

export interface LocationShortcut {
  label: LocalizedText;
  value: string;
  type: 'region' | 'city' | 'postcode' | 'search';
}

export interface LocationOption {
  value: string;
  label: string;
  id?: string;
  parentId?: string;
  parentValue?: string;
  parentLabel?: string;
  regionId?: string;
  regionValue?: string;
  regionLabel?: string;
  regionCode?: string;
  native?: string;
  en?: string;
  zhCN?: string;
}

export type AddressFilterField = 'region' | 'city' | 'postcode';
export type AddressResultField =
  | 'country'
  | 'street'
  | 'completeAddress'
  | 'locality'
  | 'district'
  | 'admin1'
  | 'admin1Code'
  | 'postcode';

export interface AddressResultFieldDefinition {
  field: AddressResultField;
  label: LocalizedText;
}

export interface CountryAddressSchema {
  filters: AddressFilterField[];
  resultFields: AddressResultFieldDefinition[];
  postalAdmin1Style: 'name' | 'code';
}

export interface CountryConfig {
  code: CountryCode;
  name: Record<Locale, string>;
  nativeName: string;
  nativeLanguage: string;
  flag: string;
  callingCode: string;
  group: CountryGroup;
  order: number;
  readiness: Readiness;
  residentialCapability: boolean;
  googleAddressValidation: boolean;
  googleResidentialMetadata: boolean;
  searchLabels: {
    query: LocalizedText;
    region: LocalizedText;
    city: LocalizedText;
    postcode: LocalizedText;
  };
  addressFormat: {
    native: string;
    latin?: string;
  };
  addressSchema: CountryAddressSchema;
  fallbackCenter: {
    latitude: number;
    longitude: number;
  };
  popularCities: LocationShortcut[];
  adminShortcuts: LocationShortcut[];
  specialAreas: LocationShortcut[];
  sources: SourceDefinition[];
}

export interface AddressEvidence {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  sourceFamily: string;
  sourceLicense?: string;
  sourceLicenseUrl?: string;
  attribution?: string;
  attributionUrl?: string;
  datasetId?: string;
  type: 'address_existence' | 'residential_use' | 'coordinate' | 'building_status';
  value: string;
  observedAt: string;
}

export interface AddressComponents {
  houseNumber: string;
  buildingName?: string;
  unit?: string;
  street: string;
  locality: string;
  postalLocality?: string;
  dependentLocality?: string;
  district?: string;
  admin1?: string;
  admin1Code?: string;
  postcode: string;
}

export interface VerifiedAddress {
  id: string;
  countryCode: CountryCode;
  nativeAddress: string;
  formattedAddress: string;
  nativeLanguage: string;
  addressVariants: Record<AddressLanguage, string>;
  components: AddressComponents;
  componentVariants: Record<AddressLanguage, AddressComponents>;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  addressStatus: 'verified' | 'synthetic';
  propertyType: PropertyType;
  unitStatus: UnitStatus;
  unitProvenance?: 'official' | 'source_tagged' | 'synthetic' | 'none';
  matchLevel: 'premise' | 'subpremise';
  verificationLevel: 'L2' | 'L3';
  sourceVersion: string;
  sourceUpdatedAt: string;
  verifiedAt: string;
  expiresAt: string;
  evidence: AddressEvidence[];
  exclusionFlags: string[];
  // Real residential communities near the point (CN only, attached at read time);
  // the generator picks one deterministically for the synthetic community name.
  nearbyCommunities?: Array<{ zh: string; en: string }>;
}

export interface AddressPresentation {
  language: AddressLanguage;
  postalLines: string[];
  singleLine: string;
}

export interface GeneratedUnit {
  components: {
    building: string;
    unit: string;
    room: string;
  };
  variants: Record<AddressLanguage, string>;
  provenance: 'synthetic';
  unitProvenance: 'synthetic';
}

export interface GeneratedProfile {
  fullName: string;
  gender: 'female' | 'male' | 'unspecified';
  email: string;
  phone: string;
  dateOfBirth: string;
}

export type Iso4217Currency =
  | 'AUD' | 'BRL' | 'CAD' | 'CNY' | 'EUR' | 'GBP' | 'HKD' | 'INR' | 'JPY' | 'KRW'
  | 'MXN' | 'MYR' | 'NGN' | 'PHP' | 'RUB' | 'SAR' | 'SGD' | 'THB' | 'TRY' | 'TWD'
  | 'USD' | 'VND' | 'ZAR';

type CompanySize = '1-10' | '11-50' | '51-200' | '201-500' | '501-1000' | '1001+';

export type GeneratedEmployment = {
  employmentStatus: 'employed' | 'self-employed';
  workSchedule: 'full-time' | 'part-time';
  occupation: string;
  company: string;
  department: string;
  companySize: CompanySize;
  salary: {
    amount: number;
    currency: Iso4217Currency;
    period: 'month';
  };
} | {
  employmentStatus: 'student' | 'between-jobs' | 'retired';
};

export interface GeneratedExtensions {
  basic: {
    age: number;
    honorific: 'mr' | 'ms';
    zodiacSign: string;
    heightCm: number;
    weightKg: number;
    bmi: number;
    bloodType: 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';
    education: 'secondary' | 'associate' | 'bachelor' | 'master' | 'doctorate';
  };
  employment: GeneratedEmployment;
  finance: {
    accountDisplayName: string;
    incomeRange?: {
      min: number;
      max: number;
      currency: Iso4217Currency;
      period: 'month';
    };
    transactionDescription: string;
  };
  internet: {
    username: string;
    testPassword: string;
    url: string;
    os: string;
    userAgent: string;
    uuid: string;
    ipAddress: string;
    macAddress: string;
    securityQuestion: string;
    securityAnswer: string;
  };
}

export interface SandboxCard {
  network: 'Visa' | 'Mastercard';
  number: string;
  expiry: string;
  cvc: string;
  testDataOnly: true;
}

export interface GeneratedBundle {
  id: string;
  seed: string;
  generatedAt: string;
  residential: boolean;
  profile: GeneratedProfile;
  extensions: GeneratedExtensions;
  address: VerifiedAddress;
  addressFormats: Record<AddressLanguage, AddressPresentation>;
  generatedUnit?: GeneratedUnit;
  googleMaps: {
    status: 'resolved' | 'map_query';
    placeId?: string;
    resultType?: 'street_address' | 'premise' | 'subpremise';
    locationType?: 'ROOFTOP' | 'GEOMETRIC_CENTER';
    embedUrl: string;
    openUrl: string;
    searchUrl?: string;
    amapUrl?: string;
  };
  card: SandboxCard;
}
