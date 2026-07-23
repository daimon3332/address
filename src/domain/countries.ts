import type {
  AddressResultFieldDefinition,
  AddressResultField,
  CountryAddressSchema,
  CountryCode,
  CountryConfig,
  CountryGroup,
  LocalizedText,
  LocationShortcut,
  Readiness,
  SourceDefinition
} from './types.ts';

const text = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh });

const shortcuts = (
  type: LocationShortcut['type'],
  entries: Array<[string, string, string]>
): LocationShortcut[] => entries.map(([en, zh, value]) => ({ label: text(en, zh), value, type }));

const source = (
  id: string,
  name: string,
  url: string,
  role: SourceDefinition['role'],
  updateCadence: string,
  priority: SourceDefinition['priority'] = 'primary'
): SourceDefinition => ({ id, name, url, role, updateCadence, priority });

const fallbacks = (residential: boolean): SourceDefinition[] => [
  source(
    'osm-overpass',
    'OpenStreetMap / Overpass',
    'https://wiki.openstreetmap.org/wiki/Overpass_API',
    residential ? 'residential' : 'address',
    'live',
    'fallback'
  )
];

interface Definition {
  code: CountryCode;
  en: string;
  zh: string;
  nativeName: string;
  nativeLanguage: string;
  flag: string;
  callingCode: string;
  group: CountryGroup;
  order: number;
  readiness: Readiness;
  residential: boolean;
  googleValidation: boolean;
  googleResidential: boolean;
  format: string;
  latinFormat?: string;
  center: [number, number];
  adminLabel: [string, string];
  postcodeLabel?: [string, string];
  primary: SourceDefinition[];
  cities: Array<[string, string, string]>;
  admins: Array<[string, string, string]>;
  special?: Array<[string, string, string, LocationShortcut['type']]>;
}

const localityLabels: Partial<Record<CountryCode, LocalizedText>> = {
  US: text('Postal city', '邮政城市'),
  JP: text('Municipality', '市区町村'),
  HK: text('Locality', '区域'),
  SG: text('Planning area', '规划区'),
  TW: text('City / township', '市/乡镇'),
  CN: text('City', '城市')
};

const districtLabels: Partial<Record<CountryCode, LocalizedText>> = {
  MX: text('Municipality / borough', '市镇/区'),
  JP: text('Ward / town', '区市町村'),
  HK: text('District', '分区'),
  TW: text('District / township', '区/乡镇'),
  KR: text('District', '区/郡'),
  MY: text('District', '县/区'),
  CN: text('District / county', '区/县'),
  PH: text('District / barangay', '区/描笼涯'),
  VN: text('District / ward', '郡县/坊'),
  IN: text('District', '县区')
};

const detailFields: Record<CountryCode, Array<'locality' | 'district' | 'admin1' | 'postcode'>> = {
  US: ['locality', 'admin1', 'postcode'],
  CA: ['locality', 'admin1', 'postcode'],
  MX: ['district', 'locality', 'admin1', 'postcode'],
  GB: ['locality', 'postcode'],
  DE: ['locality', 'postcode'],
  FR: ['locality', 'postcode'],
  IT: ['locality', 'admin1', 'postcode'],
  ES: ['locality', 'admin1', 'postcode'],
  NL: ['locality', 'postcode'],
  RU: ['locality', 'admin1', 'postcode'],
  JP: ['admin1', 'locality', 'district', 'postcode'],
  HK: ['admin1', 'locality', 'district'],
  SG: ['postcode'],
  TW: ['admin1', 'locality', 'district', 'postcode'],
  KR: ['admin1', 'locality', 'district', 'postcode'],
  MY: ['district', 'locality', 'admin1', 'postcode'],
  CN: ['admin1', 'locality', 'district', 'postcode'],
  TH: ['locality', 'admin1', 'postcode'],
  PH: ['district', 'locality', 'admin1', 'postcode'],
  VN: ['district', 'locality', 'admin1', 'postcode'],
  TR: ['locality', 'admin1', 'postcode'],
  SA: ['locality', 'postcode'],
  IN: ['district', 'locality', 'admin1', 'postcode'],
  AU: ['locality', 'admin1', 'postcode'],
  BR: ['locality', 'admin1', 'postcode'],
  NG: ['locality', 'admin1', 'postcode'],
  ZA: ['locality', 'postcode']
};

const addressSchema = (definition: Definition): CountryAddressSchema => {
  const labelFor = (field: AddressResultField): LocalizedText => {
    if (field === 'country') return text('Country / region', '国家/地区');
    if (field === 'street') return text('Street address', '街道地址');
    if (field === 'completeAddress') return text('Complete address', '完整地址');
    if (field === 'locality') return localityLabels[definition.code] || text('City / locality', '城市/地区');
    if (field === 'district') return districtLabels[definition.code] || text('District / dependent locality', '区/下级地区');
    if (field === 'admin1') return text(...definition.adminLabel);
    if (field === 'admin1Code') return text('State / province abbreviation', '州/省缩写');
    return text(...(definition.postcodeLabel || ['Postcode', '邮编']));
  };
  const configuredDetails = new Set(detailFields[definition.code]);
  const hierarchy: AddressResultField[] = ['district', 'locality', 'admin1', 'postcode'];
  const details = hierarchy.flatMap((field): AddressResultField[] => {
    if (!configuredDetails.has(field as 'locality' | 'district' | 'admin1' | 'postcode')) return [];
    return field === 'admin1' ? [field, 'admin1Code'] : [field];
  });
  const fields: AddressResultField[] = ['street', ...details, 'completeAddress'];
  const resultFields: AddressResultFieldDefinition[] = fields.map((field) => ({ field, label: labelFor(field) }));
  return {
    filters: ['CN', 'HK'].includes(definition.code)
      ? ['region', 'city']
      : definition.code === 'SG'
        ? ['postcode']
        : ['region', 'city', 'postcode'],
    resultFields,
    postalAdmin1Style: ['US', 'AU', 'CA', 'BR'].includes(definition.code) ? 'code' : 'name'
  };
};

const makeCountry = (definition: Definition): CountryConfig => ({
  code: definition.code,
  name: { en: definition.en, 'zh-CN': definition.zh },
  nativeName: definition.nativeName,
  nativeLanguage: definition.nativeLanguage,
  flag: definition.flag,
  callingCode: definition.callingCode,
  group: definition.group,
  order: definition.order,
  readiness: definition.readiness,
  residentialCapability: definition.residential,
  googleAddressValidation: definition.googleValidation,
  googleResidentialMetadata: definition.googleResidential,
  searchLabels: {
    query: text('City, state/province or postcode', '搜索城市、州省或邮编'),
    region: text(...definition.adminLabel),
    city: text('City', '城市'),
    postcode: text(...(definition.postcodeLabel || ['Postcode', '邮编'] as [string, string]))
  },
  addressFormat: { native: definition.format, latin: definition.latinFormat },
  addressSchema: addressSchema(definition),
  fallbackCenter: { latitude: definition.center[0], longitude: definition.center[1] },
  popularCities: shortcuts('city', definition.cities),
  adminShortcuts: shortcuts('region', definition.admins),
  specialAreas: (definition.special || []).map(([en, zh, value, type]) => ({
    label: text(en, zh), value, type
  })),
  sources: [...definition.primary, ...fallbacks(definition.residential)]
});

export const countries: CountryConfig[] = [
  makeCountry({
    code: 'US', en: 'United States', zh: '美国', nativeName: 'United States', nativeLanguage: 'en', flag: '🇺🇸', callingCode: '+1',
    group: 'north-america', order: 1, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%C, %S %Z', center: [40.681, -73.975], adminLabel: ['State', '州'], postcodeLabel: ['ZIP code', '邮政编码'],
    primary: [source('nad', 'National Address Database', 'https://www.transportation.gov/gis/national-address-database', 'address', 'release-triggered')],
    cities: [
      ['New York', '纽约', 'New York'], ['Los Angeles', '洛杉矶', 'Los Angeles'], ['Chicago', '芝加哥', 'Chicago'],
      ['Houston', '休斯敦', 'Houston'], ['Phoenix', '菲尼克斯', 'Phoenix'], ['Philadelphia', '费城', 'Philadelphia'],
      ['San Antonio', '圣安东尼奥', 'San Antonio'], ['San Diego', '圣迭戈', 'San Diego'], ['Dallas', '达拉斯', 'Dallas'],
      ['San Francisco', '旧金山', 'San Francisco'], ['Seattle', '西雅图', 'Seattle'], ['Boston', '波士顿', 'Boston']
    ],
    admins: [
      ['Alabama', '阿拉巴马州', 'AL'], ['Alaska', '阿拉斯加州', 'AK'], ['Arizona', '亚利桑那州', 'AZ'],
      ['Arkansas', '阿肯色州', 'AR'], ['California', '加利福尼亚州', 'CA'], ['Colorado', '科罗拉多州', 'CO'],
      ['Connecticut', '康涅狄格州', 'CT'], ['Delaware', '特拉华州', 'DE'], ['Florida', '佛罗里达州', 'FL'],
      ['Georgia', '佐治亚州', 'GA'], ['Hawaii', '夏威夷州', 'HI'], ['Idaho', '爱达荷州', 'ID'],
      ['Illinois', '伊利诺伊州', 'IL'], ['Indiana', '印第安纳州', 'IN'], ['Iowa', '艾奥瓦州', 'IA'],
      ['Kansas', '堪萨斯州', 'KS'], ['Kentucky', '肯塔基州', 'KY'], ['Louisiana', '路易斯安那州', 'LA'],
      ['Maine', '缅因州', 'ME'], ['Maryland', '马里兰州', 'MD'], ['Massachusetts', '马萨诸塞州', 'MA'],
      ['Michigan', '密歇根州', 'MI'], ['Minnesota', '明尼苏达州', 'MN'], ['Mississippi', '密西西比州', 'MS'],
      ['Missouri', '密苏里州', 'MO'], ['Montana', '蒙大拿州', 'MT'], ['Nebraska', '内布拉斯加州', 'NE'],
      ['Nevada', '内华达州', 'NV'], ['New Hampshire', '新罕布什尔州', 'NH'], ['New Jersey', '新泽西州', 'NJ'],
      ['New Mexico', '新墨西哥州', 'NM'], ['New York', '纽约州', 'NY'], ['North Carolina', '北卡罗来纳州', 'NC'],
      ['North Dakota', '北达科他州', 'ND'], ['Ohio', '俄亥俄州', 'OH'], ['Oklahoma', '俄克拉何马州', 'OK'],
      ['Oregon', '俄勒冈州', 'OR'], ['Pennsylvania', '宾夕法尼亚州', 'PA'], ['Rhode Island', '罗得岛州', 'RI'],
      ['South Carolina', '南卡罗来纳州', 'SC'], ['South Dakota', '南达科他州', 'SD'], ['Tennessee', '田纳西州', 'TN'],
      ['Texas', '得克萨斯州', 'TX'], ['Utah', '犹他州', 'UT'], ['Vermont', '佛蒙特州', 'VT'],
      ['Virginia', '弗吉尼亚州', 'VA'], ['Washington', '华盛顿州', 'WA'], ['West Virginia', '西弗吉尼亚州', 'WV'],
      ['Wisconsin', '威斯康星州', 'WI'], ['Wyoming', '怀俄明州', 'WY'], ['Washington, D.C.', '华盛顿哥伦比亚特区', 'DC']
    ],
    special: [
      ['No sales tax: Alaska', '免销售税：阿拉斯加州', 'AK', 'region'],
      ['No sales tax: Delaware', '免销售税：特拉华州', 'DE', 'region'],
      ['No sales tax: Montana', '免销售税：蒙大拿州', 'MT', 'region'],
      ['No sales tax: New Hampshire', '免销售税：新罕布什尔州', 'NH', 'region'],
      ['No sales tax: Oregon', '免销售税：俄勒冈州', 'OR', 'region']
    ]
  }),
  makeCountry({
    code: 'CA', en: 'Canada', zh: '加拿大', nativeName: 'Canada', nativeLanguage: 'en', flag: '🇨🇦', callingCode: '+1',
    group: 'north-america', order: 2, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%C %S %Z', center: [43.653, -79.383], adminLabel: ['Province', '省'], postcodeLabel: ['Postal code', '邮政编码'],
    primary: [source('nar', 'Statistics Canada National Address Register', 'https://www.statcan.gc.ca/en/lode/databases/oda', 'address', 'semiannual')],
    cities: [['Toronto', '多伦多', 'Toronto'], ['Vancouver', '温哥华', 'Vancouver'], ['Montréal', '蒙特利尔', 'Montréal']],
    admins: [['Ontario', '安大略省', 'ON'], ['British Columbia', '不列颠哥伦比亚省', 'BC'], ['Québec', '魁北克省', 'QC']]
  }),
  makeCountry({
    code: 'MX', en: 'Mexico', zh: '墨西哥', nativeName: 'México', nativeLanguage: 'es', flag: '🇲🇽', callingCode: '+52',
    group: 'north-america', order: 3, readiness: 'partial', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%D%n%Z %C, %S', center: [19.4326, -99.1332], adminLabel: ['State', '州'], postcodeLabel: ['Código postal', '邮编'],
    primary: [source('inegi', 'INEGI', 'https://www.inegi.org.mx/app/mapa/espacioydatos/default.aspx', 'address', 'version-triggered')],
    cities: [['Mexico City', '墨西哥城', 'Ciudad de México'], ['Guadalajara', '瓜达拉哈拉', 'Guadalajara'], ['Monterrey', '蒙特雷', 'Monterrey']],
    admins: [['Ciudad de México', '墨西哥城', 'Ciudad de México'], ['Jalisco', '哈利斯科州', 'Jalisco']]
  }),

  makeCountry({
    code: 'GB', en: 'United Kingdom', zh: '英国', nativeName: 'United Kingdom', nativeLanguage: 'en', flag: '🇬🇧', callingCode: '+44',
    group: 'europe', order: 4, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%C%n%Z', center: [51.507, -0.127], adminLabel: ['Country / county', '地区/郡'], postcodeLabel: ['Postcode', '邮编'],
    primary: [source('uprn', 'OS Open UPRN', 'https://www.ordnancesurvey.co.uk/products/os-open-uprn', 'address', 'six-weekly')],
    cities: [['London', '伦敦', 'London'], ['Manchester', '曼彻斯特', 'Manchester'], ['Edinburgh', '爱丁堡', 'Edinburgh']],
    admins: [['England', '英格兰', 'England'], ['Scotland', '苏格兰', 'Scotland'], ['Wales', '威尔士', 'Wales']]
  }),
  makeCountry({
    code: 'DE', en: 'Germany', zh: '德国', nativeName: 'Deutschland', nativeLanguage: 'de', flag: '🇩🇪', callingCode: '+49',
    group: 'europe', order: 5, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%Z %C', center: [52.52, 13.405], adminLabel: ['State', '联邦州'], postcodeLabel: ['Postleitzahl', '邮编'],
    primary: [source('hkde', 'BKG House Coordinates', 'https://gdz.bkg.bund.de/', 'address', 'version-triggered')],
    cities: [['Berlin', '柏林', 'Berlin'], ['Munich', '慕尼黑', 'München'], ['Frankfurt', '法兰克福', 'Frankfurt am Main']],
    admins: [['Berlin', '柏林州', 'Berlin'], ['Bavaria', '巴伐利亚州', 'Bayern'], ['Hesse', '黑森州', 'Hessen']]
  }),
  makeCountry({
    code: 'FR', en: 'France', zh: '法国', nativeName: 'France', nativeLanguage: 'fr', flag: '🇫🇷', callingCode: '+33',
    group: 'europe', order: 6, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%O%n%N%n%A%n%Z %C', center: [48.856, 2.352], adminLabel: ['Region', '大区'], postcodeLabel: ['Code postal', '邮编'],
    primary: [source('ban', 'Base Adresse Nationale', 'https://adresse.data.gouv.fr/', 'address', 'twice-weekly'), source('bdnb', 'BDNB', 'https://bdnb.io/', 'residential', 'version-triggered')],
    cities: [['Paris', '巴黎', 'Paris'], ['Lyon', '里昂', 'Lyon'], ['Marseille', '马赛', 'Marseille']],
    admins: [['Île-de-France', '法兰西岛大区', 'Île-de-France'], ['Auvergne-Rhône-Alpes', '奥弗涅-罗讷-阿尔卑斯大区', 'Auvergne-Rhône-Alpes']]
  }),
  makeCountry({
    code: 'IT', en: 'Italy', zh: '意大利', nativeName: 'Italia', nativeLanguage: 'it', flag: '🇮🇹', callingCode: '+39',
    group: 'europe', order: 7, readiness: 'partial', residential: true, googleValidation: true, googleResidential: false,
    format: '%N%n%O%n%A%n%Z %C %S', center: [41.902, 12.496], adminLabel: ['Province / region', '省/大区'], postcodeLabel: ['CAP', '邮编'],
    primary: [source('anncsu', 'ANNCSU', 'https://www.anncsu.gov.it/', 'address', 'version-triggered')],
    cities: [['Rome', '罗马', 'Roma'], ['Milan', '米兰', 'Milano'], ['Florence', '佛罗伦萨', 'Firenze']],
    admins: [['Lazio', '拉齐奥大区', 'Lazio'], ['Lombardy', '伦巴第大区', 'Lombardia']]
  }),
  makeCountry({
    code: 'ES', en: 'Spain', zh: '西班牙', nativeName: 'España', nativeLanguage: 'es', flag: '🇪🇸', callingCode: '+34',
    group: 'europe', order: 8, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%Z %C %S', center: [40.416, -3.703], adminLabel: ['Province', '省'], postcodeLabel: ['Código postal', '邮编'],
    primary: [source('cartociudad', 'CartoCiudad', 'https://www.cartociudad.es/', 'address', 'version-triggered'), source('catastro', 'Catastro', 'https://www.sedecatastro.gob.es/', 'residential', 'version-triggered')],
    cities: [['Madrid', '马德里', 'Madrid'], ['Barcelona', '巴塞罗那', 'Barcelona'], ['Valencia', '瓦伦西亚', 'València']],
    admins: [['Madrid', '马德里自治区', 'Comunidad de Madrid'], ['Catalonia', '加泰罗尼亚', 'Cataluña']]
  }),
  makeCountry({
    code: 'NL', en: 'Netherlands', zh: '荷兰', nativeName: 'Nederland', nativeLanguage: 'nl', flag: '🇳🇱', callingCode: '+31',
    group: 'europe', order: 9, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%O%n%N%n%A%n%Z %C', center: [52.37, 4.895], adminLabel: ['Province', '省'], postcodeLabel: ['Postcode', '邮编'],
    primary: [source('bag', 'BAG / PDOK', 'https://api.pdok.nl/kadaster/bag/ogc/v2', 'residential', 'daily')],
    cities: [['Amsterdam', '阿姆斯特丹', 'Amsterdam'], ['Rotterdam', '鹿特丹', 'Rotterdam'], ['The Hague', '海牙', 'Den Haag']],
    admins: [['North Holland', '北荷兰省', 'Noord-Holland'], ['South Holland', '南荷兰省', 'Zuid-Holland']]
  }),
  makeCountry({
    code: 'RU', en: 'Russia', zh: '俄罗斯', nativeName: 'Россия', nativeLanguage: 'ru', flag: '🇷🇺', callingCode: '+7',
    group: 'europe', order: 10, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%S%n%Z', latinFormat: '%N%n%O%n%A%n%C%n%S%n%Z', center: [55.755, 37.617], adminLabel: ['Federal subject', '联邦主体'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('fias', 'GAR / FIAS', 'https://www.nalog.gov.ru/opendata/7707329152-fias', 'address', 'weekly')],
    cities: [['Moscow', '莫斯科', 'Москва'], ['Saint Petersburg', '圣彼得堡', 'Санкт-Петербург'], ['Kazan', '喀山', 'Казань']],
    admins: [['Moscow', '莫斯科', 'Москва'], ['Saint Petersburg', '圣彼得堡', 'Санкт-Петербург']]
  }),

  makeCountry({
    code: 'JP', en: 'Japan', zh: '日本', nativeName: '日本', nativeLanguage: 'ja', flag: '🇯🇵', callingCode: '+81',
    group: 'east-asia', order: 14, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '〒%Z%n%S%C%D%n%A%n%O%n%N', latinFormat: '%N%n%O%n%A%n%D%n%C, %S%n%Z', center: [35.676, 139.65], adminLabel: ['Prefecture', '都道府县'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('abr', 'Address Base Registry', 'https://www.digital.go.jp/en/policies/base_registry_address', 'address', 'version-triggered')],
    cities: [['Tokyo', '东京', '東京都'], ['Osaka', '大阪', '大阪市'], ['Yokohama', '横滨', '横浜市']],
    admins: [['Tokyo', '东京都', '東京都'], ['Osaka', '大阪府', '大阪府'], ['Kanagawa', '神奈川县', '神奈川県']]
  }),
  makeCountry({
    code: 'HK', en: 'Hong Kong', zh: '香港', nativeName: '香港', nativeLanguage: 'zh-HK', flag: '🇭🇰', callingCode: '+852',
    group: 'east-asia', order: 12, readiness: 'strict', residential: true, googleValidation: false, googleResidential: false,
    format: '%S%n%C%n%D%n%A%n%O%n%N', latinFormat: '%N%n%O%n%D%n%A%n%C%n%S', center: [22.319, 114.169], adminLabel: ['Area', '地区'], postcodeLabel: ['Postcode (not used)', '邮编（不使用）'],
    primary: [source('hk-als', 'Hong Kong Address Lookup Service', 'https://www.als.gov.hk/', 'address', 'live')],
    cities: [['Hong Kong Island', '香港岛', '香港'], ['Kowloon', '九龙', '九龍'], ['New Territories', '新界', '新界']],
    admins: [['Hong Kong Island', '香港岛', '香港島'], ['Kowloon', '九龙', '九龍'], ['New Territories', '新界', '新界']]
  }),
  makeCountry({
    code: 'SG', en: 'Singapore', zh: '新加坡', nativeName: 'Singapore', nativeLanguage: 'en', flag: '🇸🇬', callingCode: '+65',
    group: 'east-asia', order: 15, readiness: 'strict', residential: true, googleValidation: true, googleResidential: false,
    format: '%N%n%O%n%A%nSINGAPORE %Z', center: [1.352, 103.819], adminLabel: ['Planning area', '规划区'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('onemap', 'OneMap', 'https://www.onemap.gov.sg/apidocs/search', 'address', 'live'), source('hdb', 'HDB Property Information', 'https://data.gov.sg/datasets/d_17f5382f26140b1fdae0ba2ef6239d2f/view', 'residential', 'version-triggered')],
    cities: [['Central Area', '中央区', 'Central Area'], ['Bedok', '勿洛', 'Bedok'], ['Ang Mo Kio', '宏茂桥', 'Ang Mo Kio']],
    admins: [['Central Region', '中区', 'Central Region'], ['East Region', '东区', 'East Region']]
  }),
  makeCountry({
    code: 'TW', en: 'Taiwan', zh: '台湾', nativeName: '臺灣', nativeLanguage: 'zh-TW', flag: '🇹🇼', callingCode: '+886',
    group: 'east-asia', order: 13, readiness: 'strict', residential: true, googleValidation: false, googleResidential: false,
    format: '%Z%n%S%C%n%A%n%O%n%N', latinFormat: '%N%n%O%n%A%n%C, %S %Z', center: [25.033, 121.565], adminLabel: ['County / city', '县市'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('tgos', 'TGOS Address Locator', 'https://api.tgos.tw/TGOS_MAP_API/docs/site/web/Locate', 'address', 'live')],
    cities: [['Taipei', '台北', '臺北市'], ['Kaohsiung', '高雄', '高雄市'], ['Taichung', '台中', '臺中市']],
    admins: [['Taipei City', '台北市', '臺北市'], ['New Taipei City', '新北市', '新北市']]
  }),
  makeCountry({
    code: 'KR', en: 'South Korea', zh: '韩国', nativeName: '대한민국', nativeLanguage: 'ko', flag: '🇰🇷', callingCode: '+82',
    group: 'east-asia', order: 16, readiness: 'strict', residential: true, googleValidation: false, googleResidential: false,
    format: '%S %C%n%A%n%O%n%N%n(%Z)', latinFormat: '%N%n%O%n%A%n%C%n%S%n%Z', center: [37.566, 126.978], adminLabel: ['Province / metropolitan city', '道/广域市'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('juso', 'Juso Road Address API', 'https://www.data.go.kr/data/15057017/openapi.do', 'residential', 'live')],
    cities: [['Seoul', '首尔', '서울특별시'], ['Busan', '釜山', '부산광역시'], ['Incheon', '仁川', '인천광역시']],
    admins: [['Seoul', '首尔特别市', '서울특별시'], ['Gyeonggi', '京畿道', '경기도']]
  }),
  makeCountry({
    code: 'MY', en: 'Malaysia', zh: '马来西亚', nativeName: 'Malaysia', nativeLanguage: 'ms', flag: '🇲🇾', callingCode: '+60',
    group: 'southeast-asia', order: 20, readiness: 'research', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%D%n%Z %C%n%S', center: [3.139, 101.686], adminLabel: ['State / territory', '州/联邦直辖区'], postcodeLabel: ['Postcode', '邮编'],
    primary: [source('mygeoportal', 'MyGeoportal', 'https://www.mygeoportal.gov.my/', 'address', 'provider-managed')],
    cities: [['Kuala Lumpur', '吉隆坡', 'Kuala Lumpur'], ['George Town', '乔治市', 'George Town'], ['Johor Bahru', '新山', 'Johor Bahru']],
    admins: [['Kuala Lumpur', '吉隆坡', 'Kuala Lumpur'], ['Selangor', '雪兰莪州', 'Selangor']]
  }),
  makeCountry({
    code: 'CN', en: 'China', zh: '中国', nativeName: '中国', nativeLanguage: 'zh-CN', flag: '🇨🇳', callingCode: '+86',
    group: 'east-asia', order: 11, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%S%C%D%n%A%n%O%n%N', latinFormat: '%N%n%O%n%A%n%D%n%C%n%S', center: [31.23, 121.47], adminLabel: ['Province / municipality', '省/直辖市'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('ngcc', 'National Platform for Common Geospatial Information Services', 'https://www.tianditu.gov.cn/', 'address', 'provider-managed')],
    cities: [['Shanghai', '上海', '上海市'], ['Beijing', '北京', '北京市'], ['Shenzhen', '深圳', '深圳市']],
    admins: [['Shanghai', '上海市', '上海市'], ['Beijing', '北京市', '北京市'], ['Guangdong', '广东省', '广东省']]
  }),
  makeCountry({
    code: 'TH', en: 'Thailand', zh: '泰国', nativeName: 'ประเทศไทย', nativeLanguage: 'th', flag: '🇹🇭', callingCode: '+66',
    group: 'southeast-asia', order: 18, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%S %Z', latinFormat: '%N%n%O%n%A%n%C%n%S %Z', center: [13.756, 100.501], adminLabel: ['Province', '府'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('thai-post', 'Thailand Post Address Data', 'https://www.thailandpost.co.th/', 'address', 'provider-managed')],
    cities: [['Bangkok', '曼谷', 'กรุงเทพมหานคร'], ['Chiang Mai', '清迈', 'เชียงใหม่'], ['Phuket', '普吉', 'ภูเก็ต']],
    admins: [['Bangkok', '曼谷', 'กรุงเทพมหานคร'], ['Chiang Mai', '清迈府', 'เชียงใหม่']]
  }),
  makeCountry({
    code: 'PH', en: 'Philippines', zh: '菲律宾', nativeName: 'Pilipinas', nativeLanguage: 'fil', flag: '🇵🇭', callingCode: '+63',
    group: 'southeast-asia', order: 19, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%Z %S', center: [14.5995, 120.9842], adminLabel: ['Province / region', '省/大区'], postcodeLabel: ['ZIP code', '邮编'],
    primary: [source('psgc', 'Philippine Standard Geographic Code', 'https://psa.gov.ph/classification/psgc', 'admin', 'version-triggered')],
    cities: [['Manila', '马尼拉', 'Manila'], ['Quezon City', '奎松市', 'Quezon City'], ['Cebu City', '宿务市', 'Cebu City']],
    admins: [['Metro Manila', '马尼拉大都会', 'Metro Manila'], ['Cebu', '宿务省', 'Cebu']]
  }),
  makeCountry({
    code: 'VN', en: 'Vietnam', zh: '越南', nativeName: 'Việt Nam', nativeLanguage: 'vi', flag: '🇻🇳', callingCode: '+84',
    group: 'southeast-asia', order: 17, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%S %Z', latinFormat: '%N%n%O%n%A%n%C%n%S %Z', center: [10.823, 106.629], adminLabel: ['Province / municipality', '省/直辖市'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('vnpost', 'Vietnam Post Address Data', 'https://vnpost.vn/', 'address', 'provider-managed')],
    cities: [['Ho Chi Minh City', '胡志明市', 'Thành phố Hồ Chí Minh'], ['Hanoi', '河内', 'Hà Nội'], ['Da Nang', '岘港', 'Đà Nẵng']],
    admins: [['Ho Chi Minh City', '胡志明市', 'Hồ Chí Minh'], ['Hanoi', '河内市', 'Hà Nội']]
  }),

  makeCountry({
    code: 'TR', en: 'Türkiye', zh: '土耳其', nativeName: 'Türkiye', nativeLanguage: 'tr', flag: '🇹🇷', callingCode: '+90',
    group: 'middle-east', order: 23, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%Z %C/%S', center: [41.008, 28.978], adminLabel: ['Province', '省'], postcodeLabel: ['Posta kodu', '邮编'],
    primary: [source('uavt', 'National Address Database / MAKS', 'https://adres.nvi.gov.tr/', 'address', 'provider-managed')],
    cities: [['Istanbul', '伊斯坦布尔', 'İstanbul'], ['Ankara', '安卡拉', 'Ankara'], ['İzmir', '伊兹密尔', 'İzmir']],
    admins: [['Istanbul', '伊斯坦布尔省', 'İstanbul'], ['Ankara', '安卡拉省', 'Ankara']]
  }),
  makeCountry({
    code: 'SA', en: 'Saudi Arabia', zh: '沙特阿拉伯', nativeName: 'المملكة العربية السعودية', nativeLanguage: 'ar', flag: '🇸🇦', callingCode: '+966',
    group: 'middle-east', order: 24, readiness: 'research', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%Z%n%C', latinFormat: '%N%n%O%n%A%n%Z%n%C', center: [24.7136, 46.6753], adminLabel: ['Province', '省'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('spl', 'SPL National Address', 'https://portal.splonline.com.sa/en/national-address', 'address', 'live')],
    cities: [['Riyadh', '利雅得', 'Riyadh'], ['Jeddah', '吉达', 'Jeddah'], ['Dammam', '达曼', 'Dammam']],
    admins: [['Riyadh Province', '利雅得省', 'Riyadh Province'], ['Makkah Province', '麦加省', 'Makkah Province']]
  }),

  makeCountry({
    code: 'IN', en: 'India', zh: '印度', nativeName: 'India', nativeLanguage: 'en', flag: '🇮🇳', callingCode: '+91',
    group: 'south-asia', order: 21, readiness: 'partial', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%C %Z%n%S', center: [12.9716, 77.5946], adminLabel: ['State / territory', '邦/中央直辖区'], postcodeLabel: ['PIN code', '邮编'],
    primary: [source('digipin', 'India Post DIGIPIN / PIN Directory', 'https://www.indiapost.gov.in/', 'address', 'release-triggered')],
    cities: [['Bengaluru', '班加罗尔', 'Bengaluru'], ['Mumbai', '孟买', 'Mumbai'], ['Delhi', '德里', 'Delhi']],
    admins: [['Karnataka', '卡纳塔克邦', 'Karnataka'], ['Maharashtra', '马哈拉施特拉邦', 'Maharashtra']]
  }),
  makeCountry({
    code: 'AU', en: 'Australia', zh: '澳大利亚', nativeName: 'Australia', nativeLanguage: 'en', flag: '🇦🇺', callingCode: '+61',
    group: 'oceania', order: 22, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%O%n%N%n%A%n%C %S %Z', center: [-33.8688, 151.2093], adminLabel: ['State / territory', '州/领地'], postcodeLabel: ['Postcode', '邮编'],
    primary: [source('gnaf', 'G-NAF', 'https://data.gov.au/data/dataset/geocoded-national-address-file-g-naf', 'address', 'quarterly')],
    cities: [['Sydney', '悉尼', 'Sydney'], ['Melbourne', '墨尔本', 'Melbourne'], ['Brisbane', '布里斯班', 'Brisbane']],
    admins: [['New South Wales', '新南威尔士州', 'NSW'], ['Victoria', '维多利亚州', 'VIC']]
  }),

  makeCountry({
    code: 'BR', en: 'Brazil', zh: '巴西', nativeName: 'Brasil', nativeLanguage: 'pt-BR', flag: '🇧🇷', callingCode: '+55',
    group: 'south-america', order: 25, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%O%n%N%n%A%n%C-%S%n%Z', center: [-23.55, -46.633], adminLabel: ['State', '州'], postcodeLabel: ['CEP', '邮编'],
    primary: [source('cnefe', 'IBGE CNEFE', 'https://www.ibge.gov.br/estatisticas/sociais/populacao/38734-cadastro-nacional-de-enderecos-para-fins-estatisticos.html', 'residential', 'release-triggered')],
    cities: [['São Paulo', '圣保罗', 'São Paulo'], ['Rio de Janeiro', '里约热内卢', 'Rio de Janeiro'], ['Brasília', '巴西利亚', 'Brasília']],
    admins: [['São Paulo', '圣保罗州', 'São Paulo'], ['Rio de Janeiro', '里约热内卢州', 'Rio de Janeiro']]
  }),
  makeCountry({
    code: 'NG', en: 'Nigeria', zh: '尼日利亚', nativeName: 'Nigeria', nativeLanguage: 'en', flag: '🇳🇬', callingCode: '+234',
    group: 'africa', order: 26, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C %Z%n%S', center: [6.5244, 3.3792], adminLabel: ['State', '州'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('grid3', 'GRID3 Nigeria', 'https://grid3.org/', 'building', 'version-triggered')],
    cities: [['Lagos', '拉各斯', 'Lagos'], ['Abuja', '阿布贾', 'Abuja'], ['Port Harcourt', '哈科特港', 'Port Harcourt']],
    admins: [['Lagos', '拉各斯州', 'Lagos'], ['Federal Capital Territory', '联邦首都区', 'Federal Capital Territory']]
  }),
  makeCountry({
    code: 'ZA', en: 'South Africa', zh: '南非', nativeName: 'South Africa', nativeLanguage: 'en', flag: '🇿🇦', callingCode: '+27',
    group: 'africa', order: 27, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%Z', center: [-33.9249, 18.4241], adminLabel: ['Province', '省'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('nad-za', 'South African National Address Database', 'https://www.csir.co.za/', 'address', 'version-triggered')],
    cities: [['Cape Town', '开普敦', 'Cape Town'], ['Johannesburg', '约翰内斯堡', 'Johannesburg'], ['Durban', '德班', 'Durban']],
    admins: [['Western Cape', '西开普省', 'Western Cape'], ['Gauteng', '豪登省', 'Gauteng']]
  })
].sort((left, right) => left.order - right.order);

export const countryByCode = new Map<CountryCode, CountryConfig>(
  countries.map((country) => [country.code, country])
);

export const countryCodes = countries.map((country) => country.code);

export const isCountryCode = (value: string): value is CountryCode =>
  countryByCode.has(value as CountryCode);
