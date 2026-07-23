import type { Faker } from '@faker-js/faker';
import type {
  CountryCode, GeneratedExtensions, Iso4217Currency
} from './types';

type RandomSource = () => number;
type Education = GeneratedExtensions['basic']['education'];
type ActiveEmployment = Extract<GeneratedExtensions['employment'], { employmentStatus: 'employed' | 'self-employed' }>;
type CompanySize = ActiveEmployment['companySize'];
type EmploymentStatus = GeneratedExtensions['employment']['employmentStatus'];
type BloodType = GeneratedExtensions['basic']['bloodType'];

const currencyByCountry: Record<CountryCode, Iso4217Currency> = {
  US: 'USD', CA: 'CAD', MX: 'MXN', GB: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR',
  ES: 'EUR', NL: 'EUR', RU: 'RUB', JP: 'JPY', HK: 'HKD', SG: 'SGD', TW: 'TWD',
  KR: 'KRW', MY: 'MYR', CN: 'CNY', TH: 'THB', PH: 'PHP', VN: 'VND', TR: 'TRY',
  SA: 'SAR', IN: 'INR', AU: 'AUD', BR: 'BRL', NG: 'NGN', ZA: 'ZAR'
};

const medianMonthlySalary: Record<CountryCode, number> = {
  US: 5_500, CA: 5_000, MX: 18_000, GB: 3_200, DE: 3_800, FR: 3_300, IT: 2_600,
  ES: 2_500, NL: 3_800, RU: 90_000, JP: 350_000, HK: 26_000, SG: 5_500, TW: 48_000,
  KR: 3_500_000, MY: 4_000, CN: 10_000, TH: 30_000, PH: 35_000, VN: 15_000_000,
  TR: 40_000, SA: 9_000, IN: 50_000, AU: 6_500, BR: 5_000, NG: 350_000, ZA: 25_000
};

const heightMeans: Record<CountryCode, readonly [male: number, female: number]> = {
  US: [176, 162], CA: [175, 162], MX: [170, 158], GB: [175, 162], DE: [180, 166],
  FR: [176, 163], IT: [175, 162], ES: [176, 163], NL: [183, 170], RU: [176, 164],
  JP: [171, 158], HK: [174, 160], SG: [173, 160], TW: [173, 160], KR: [175, 162],
  MY: [169, 157], CN: [172, 160], TH: [170, 158], PH: [165, 154], VN: [168, 156],
  TR: [176, 162], SA: [171, 158], IN: [166, 154], AU: [179, 165], BR: [174, 161],
  NG: [171, 159], ZA: [169, 158]
};

const bmiMeans: Record<CountryCode, number> = {
  US: 27.8, CA: 26.5, MX: 28, GB: 27, DE: 26, FR: 25, IT: 25, ES: 26, NL: 25,
  RU: 27, JP: 23, HK: 23, SG: 23.5, TW: 24, KR: 24, MY: 25.5, CN: 24,
  TH: 24.5, PH: 23.5, VN: 22.5, TR: 27.5, SA: 29, IN: 23, AU: 27, BR: 27,
  NG: 25, ZA: 28
};

const educationRank: Record<Education, number> = {
  secondary: 0, associate: 1, bachelor: 2, master: 3, doctorate: 4
};

interface OccupationFamily {
  education: Education;
  department: string;
  salaryFactor: number;
  titles: readonly string[];
}

const occupations: readonly OccupationFamily[] = [
  { education: 'secondary', department: 'Customer Operations', salaryFactor: 0.72, titles: ['Customer Service Representative', 'Retail Store Supervisor'] },
  { education: 'secondary', department: 'Operations', salaryFactor: 0.82, titles: ['Warehouse Coordinator', 'Administrative Assistant', 'Maintenance Technician'] },
  { education: 'associate', department: 'Information Technology', salaryFactor: 1.02, titles: ['Network Support Specialist', 'Systems Support Technician'] },
  { education: 'associate', department: 'Finance', salaryFactor: 0.95, titles: ['Accounting Technician', 'Payroll Specialist'] },
  { education: 'associate', department: 'Legal', salaryFactor: 1.02, titles: ['Paralegal', 'Legal Operations Specialist'] },
  { education: 'bachelor', department: 'Engineering', salaryFactor: 1.35, titles: ['Software Engineer', 'Civil Engineer', 'Quality Engineer'] },
  { education: 'bachelor', department: 'Finance', salaryFactor: 1.22, titles: ['Financial Analyst', 'Management Accountant'] },
  { education: 'bachelor', department: 'People Operations', salaryFactor: 1.05, titles: ['Human Resources Specialist', 'Talent Acquisition Specialist'] },
  { education: 'bachelor', department: 'Marketing', salaryFactor: 1.08, titles: ['Marketing Specialist', 'Communications Specialist'] },
  { education: 'master', department: 'Product', salaryFactor: 1.48, titles: ['Product Manager', 'Business Intelligence Manager'] },
  { education: 'master', department: 'Research', salaryFactor: 1.52, titles: ['Data Scientist', 'Clinical Research Coordinator', 'Urban Planner'] },
  { education: 'doctorate', department: 'Research', salaryFactor: 1.7, titles: ['Research Scientist', 'University Lecturer', 'Clinical Psychologist'] }
];

const userAgents = [
  {
    os: 'Windows 11',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
  },
  {
    os: 'Windows 11',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0'
  },
  {
    os: 'Windows 11',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0'
  },
  {
    os: 'macOS 15.7',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'
  },
  {
    os: 'macOS 15.7',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:152.0) Gecko/20100101 Firefox/152.0'
  },
  {
    os: 'Android 16',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36'
  },
  {
    os: 'iOS 18.6',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
  }
] as const;

const passwordWords = [
  'Amber', 'Bridge', 'Cedar', 'Cloud', 'Harbor', 'Maple', 'Meadow', 'River',
  'Silver', 'Stone', 'Summer', 'Willow'
] as const;

const usernameWords = [
  'amber', 'cedar', 'harbor', 'maple', 'meadow', 'river', 'silver', 'willow'
] as const;

const integer = (random: RandomSource, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const pick = <T>(values: readonly T[], random: RandomSource): T =>
  values[integer(random, 0, values.length - 1)];

const weightedPick = <T>(
  values: readonly { value: T; weight: number }[],
  random: RandomSource
): T => {
  const total = values.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = random() * total;
  for (const entry of values) {
    cursor -= entry.weight;
    if (cursor < 0) return entry.value;
  }
  return values[values.length - 1].value;
};

const normal = (random: RandomSource): number => {
  const first = Math.max(Number.EPSILON, random());
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * random());
};

const ageAt = (birthDate: Date, now: Date): number => {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const birthdayPassed = now.getUTCMonth() > birthDate.getUTCMonth()
    || (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() >= birthDate.getUTCDate());
  if (!birthdayPassed) age -= 1;
  return age;
};

export const generateBirthDate = (random: RandomSource, now: Date): Date => {
  const ageBand = weightedPick([
    { value: [18, 24] as const, weight: 18 },
    { value: [25, 34] as const, weight: 24 },
    { value: [35, 44] as const, weight: 22 },
    { value: [45, 54] as const, weight: 18 },
    { value: [55, 64] as const, weight: 12 },
    { value: [65, 74] as const, weight: 6 }
  ], random);
  const age = integer(random, ageBand[0], ageBand[1]);
  const boundaryFor = (year: number): number => {
    const month = now.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay));
  };
  const dayMs = 86_400_000;
  const earliest = boundaryFor(now.getUTCFullYear() - age - 1) + dayMs;
  const latest = boundaryFor(now.getUTCFullYear() - age);
  return new Date(earliest + integer(random, 0, Math.floor((latest - earliest) / dayMs)) * dayMs);
};

const zodiacFor = (birthDate: Date): string => {
  const month = birthDate.getUTCMonth() + 1;
  const day = birthDate.getUTCDate();
  const boundary = [20, 19, 21, 20, 21, 21, 23, 23, 23, 23, 22, 22][month - 1];
  const signs = [
    'capricorn', 'aquarius', 'pisces', 'aries', 'taurus', 'gemini',
    'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn'
  ];
  return day < boundary ? signs[month - 1] : signs[month];
};

const educationFor = (age: number, random: RandomSource): Education => weightedPick([
  { value: 'secondary', weight: 28 },
  { value: 'associate', weight: age >= 20 ? 22 : 0 },
  { value: 'bachelor', weight: age >= 21 ? 35 : 0 },
  { value: 'master', weight: age >= 23 ? 13 : 0 },
  { value: 'doctorate', weight: age >= 28 ? 2 : 0 }
], random);

const employmentStatusFor = (age: number, random: RandomSource): EmploymentStatus => {
  if (age <= 22) return weightedPick([
    { value: 'employed' as const, weight: 42 },
    { value: 'self-employed' as const, weight: 5 },
    { value: 'student' as const, weight: 45 },
    { value: 'between-jobs' as const, weight: 8 }
  ], random);
  if (age <= 29) return weightedPick([
    { value: 'employed' as const, weight: 70 },
    { value: 'self-employed' as const, weight: 9 },
    { value: 'student' as const, weight: 12 },
    { value: 'between-jobs' as const, weight: 9 }
  ], random);
  if (age <= 59) return weightedPick([
    { value: 'employed' as const, weight: 80 },
    { value: 'self-employed' as const, weight: 12 },
    { value: 'student' as const, weight: 1 },
    { value: 'between-jobs' as const, weight: 7 }
  ], random);
  if (age <= 64) return weightedPick([
    { value: 'employed' as const, weight: 65 },
    { value: 'self-employed' as const, weight: 12 },
    { value: 'student' as const, weight: 1 },
    { value: 'between-jobs' as const, weight: 5 },
    { value: 'retired' as const, weight: 17 }
  ], random);
  return weightedPick([
    { value: 'employed' as const, weight: 18 },
    { value: 'self-employed' as const, weight: 6 },
    { value: 'student' as const, weight: 1 },
    { value: 'between-jobs' as const, weight: 3 },
    { value: 'retired' as const, weight: 72 }
  ], random);
};

const anthropometricsFor = (
  countryCode: CountryCode,
  gender: 'female' | 'male',
  random: RandomSource
): Pick<GeneratedExtensions['basic'], 'heightCm' | 'weightKg' | 'bmi'> => {
  const meanHeight = heightMeans[countryCode][gender === 'male' ? 0 : 1];
  const heightCm = Math.round(clamp(meanHeight + normal(random) * (gender === 'male' ? 7.2 : 6.6), 150, 200));
  const sampledBmi = clamp(bmiMeans[countryCode] + normal(random) * 3.2, 18.5, 36);
  const weightKg = Math.round(clamp(sampledBmi * (heightCm / 100) ** 2, 45, 110));
  const bmi = Number((weightKg / (heightCm / 100) ** 2).toFixed(1));
  return { heightCm, weightKg, bmi };
};

const bloodTypeFor = (countryCode: CountryCode, random: RandomSource): BloodType => {
  const lowRhNegative = ['CN', 'HK', 'JP', 'KR', 'TW', 'SG', 'MY', 'TH', 'PH', 'VN']
    .includes(countryCode);
  const distribution = lowRhNegative
    ? [
        { value: 'O+' as const, weight: 38 }, { value: 'A+' as const, weight: 30 },
        { value: 'B+' as const, weight: 24 }, { value: 'AB+' as const, weight: 7 },
        { value: 'O-' as const, weight: 0.4 }, { value: 'A-' as const, weight: 0.3 },
        { value: 'B-' as const, weight: 0.2 }, { value: 'AB-' as const, weight: 0.1 }
      ]
    : [
        { value: 'O+' as const, weight: 38 }, { value: 'A+' as const, weight: 34 },
        { value: 'B+' as const, weight: 9 }, { value: 'AB+' as const, weight: 3 },
        { value: 'O-' as const, weight: 7 }, { value: 'A-' as const, weight: 6 },
        { value: 'B-' as const, weight: 2 }, { value: 'AB-' as const, weight: 1 }
      ];
  return weightedPick(distribution, random);
};

const companySizeFor = (random: RandomSource): CompanySize => weightedPick([
  { value: '1-10', weight: 10 }, { value: '11-50', weight: 18 },
  { value: '51-200', weight: 24 }, { value: '201-500', weight: 18 },
  { value: '501-1000', weight: 12 }, { value: '1001+', weight: 18 }
], random);

const salaryFor = (
  countryCode: CountryCode,
  age: number,
  factor: number,
  random: RandomSource
): number => {
  const ageFactor = age < 30 ? 0.82 : age < 45 ? 1 : 1.1;
  const sampled = medianMonthlySalary[countryCode] * factor * ageFactor * (0.84 + random() * 0.32);
  const currency = currencyByCountry[countryCode];
  const unit = currency === 'VND' ? 100_000
    : currency === 'KRW' ? 10_000
      : currency === 'JPY' || currency === 'NGN' ? 1_000
        : 10;
  return Math.max(unit, Math.round(sampled / unit) * unit);
};

const usernameFor = (
  fullName: string,
  suffix: string,
  random: RandomSource
): string => {
  const ascii = fullName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (ascii.length === 0) {
    const firstIndex = integer(random, 0, usernameWords.length - 1);
    const secondIndex = (firstIndex + integer(random, 1, usernameWords.length - 1)) % usernameWords.length;
    return `${usernameWords[firstIndex]}.${usernameWords[secondIndex]}${suffix.slice(-2)}`;
  }
  const first = ascii[0];
  const last = ascii[ascii.length - 1];
  const username = pick([
    `${first}.${last}`, `${first}_${last}`, `${first[0]}${last}`, `${first}${suffix.slice(-2)}`
  ], random);
  return `${username}${username.length < 4 ? suffix.slice(-2) : ''}`.slice(0, 30);
};

const accountTypesFor = (countryCode: CountryCode): readonly string[] => {
  if (countryCode === 'US' || countryCode === 'CA') return ['Checking Account', 'Savings Account'];
  if (countryCode === 'AU') return ['Everyday Account', 'Savings Account'];
  return ['Current Account', 'Savings Account'];
};

const securityFor = (
  faker: Faker,
  random: RandomSource
): Pick<GeneratedExtensions['internet'], 'securityQuestion' | 'securityAnswer'> => {
  return pick([
    { securityQuestion: 'What was the name of your first pet?', securityAnswer: faker.animal.petName() },
    { securityQuestion: 'What was your childhood nickname?', securityAnswer: faker.person.firstName() },
    { securityQuestion: 'In what city did your parents meet?', securityAnswer: faker.location.city() },
    { securityQuestion: 'What was your favorite teacher\'s surname?', securityAnswer: faker.person.lastName() }
  ], random);
};

const documentationIp = (random: RandomSource): string => {
  const prefix = pick(['192.0.2', '198.51.100', '203.0.113'] as const, random);
  return `${prefix}.${integer(random, 1, 254)}`;
};

const locallyAdministeredMac = (random: RandomSource): string => {
  const bytes = Array.from({ length: 6 }, () => integer(random, 0, 255));
  bytes[0] = (bytes[0] | 0x02) & 0xfe;
  return bytes.map((value) => value.toString(16).padStart(2, '0')).join(':');
};

export const generateExtensions = (
  countryCode: CountryCode,
  gender: 'female' | 'male',
  fullName: string,
  birthDate: Date,
  suffix: string,
  faker: Faker,
  random: RandomSource,
  now: Date
): GeneratedExtensions => {
  const age = ageAt(birthDate, now);
  const education = educationFor(age, random);
  const employmentStatus = employmentStatusFor(age, random);
  let employment: GeneratedExtensions['employment'];
  let incomeRange: GeneratedExtensions['finance']['incomeRange'];
  if (employmentStatus === 'employed' || employmentStatus === 'self-employed') {
    const rank = educationRank[education];
    const eligibleOccupations = occupations.filter((occupation) => {
      const occupationRank = educationRank[occupation.education];
      return occupationRank <= rank && occupationRank >= Math.max(0, rank - 1);
    });
    const occupationFamily = pick(eligibleOccupations, random);
    const occupation = pick(occupationFamily.titles, random);
    const workSchedule = weightedPick([
      { value: 'full-time' as const, weight: age <= 22 ? 58 : 82 },
      { value: 'part-time' as const, weight: age <= 22 ? 42 : 18 }
    ], random);
    const salary = salaryFor(
      countryCode, age, occupationFamily.salaryFactor * (workSchedule === 'part-time' ? 0.58 : 1), random
    );
    const currency = currencyByCountry[countryCode];
    employment = {
      occupation: employmentStatus === 'self-employed' ? `Independent ${occupation}` : occupation,
      company: employmentStatus === 'self-employed' ? `${fullName} Consulting` : faker.company.name(),
      department: employmentStatus === 'self-employed' ? 'Owner' : occupationFamily.department,
      employmentStatus,
      workSchedule,
      companySize: employmentStatus === 'self-employed' ? '1-10' : companySizeFor(random),
      salary: { amount: salary, currency, period: 'month' }
    };
    incomeRange = {
      min: Math.floor(salary * 0.85),
      max: Math.ceil(salary * 1.15),
      currency,
      period: 'month'
    };
  } else {
    employment = { employmentStatus };
  }
  const username = usernameFor(fullName, suffix, random);
  const urlLabel = username.replace(/[^a-z0-9-]/g, '-');
  const userAgent = pick(userAgents, random);
  const security = securityFor(faker, random);
  const accountType = pick(accountTypesFor(countryCode), random);
  const websiteHost = faker.internet.domainName();
  const merchant = faker.company.name().replace(/\s+/g, ' ').trim().slice(0, 64);
  return {
    basic: {
      age,
      honorific: gender === 'male' ? 'mr' : 'ms',
      zodiacSign: zodiacFor(birthDate),
      ...anthropometricsFor(countryCode, gender, random),
      bloodType: bloodTypeFor(countryCode, random),
      education
    },
    employment,
    finance: {
      accountDisplayName: `${fullName} · ${accountType}`,
      ...(incomeRange ? { incomeRange } : {}),
      transactionDescription: `CARD PURCHASE · ${merchant}`
    },
    internet: {
      username,
      testPassword: `${pick(passwordWords, random)}${pick(passwordWords, random)}${integer(random, 10, 99)}!`,
      url: `https://${websiteHost}/profiles/${urlLabel || suffix}`,
      os: userAgent.os,
      userAgent: userAgent.userAgent,
      uuid: faker.string.uuid(),
      ipAddress: documentationIp(random),
      macAddress: locallyAdministeredMac(random),
      ...security
    }
  };
};
