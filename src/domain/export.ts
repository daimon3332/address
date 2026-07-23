import type { GeneratedBundle } from './types';

export const bundleToJson = (bundle: GeneratedBundle): string => JSON.stringify(bundle, null, 2);

const csvCell = (value: string | number | boolean): string => {
  const valueAsText = String(value);
  return /[",\n]/.test(valueAsText) ? `"${valueAsText.replace(/"/g, '""')}"` : valueAsText;
};

export const bundleToCsv = (bundle: GeneratedBundle): string => {
  const row = {
    seed: bundle.seed,
    full_name: bundle.profile.fullName,
    gender: bundle.profile.gender,
    email: bundle.profile.email,
    phone: bundle.profile.phone,
    date_of_birth: bundle.profile.dateOfBirth,
    native_address: bundle.addressFormats.native.singleLine,
    english_address: bundle.addressFormats.en.singleLine,
    chinese_address: bundle.addressFormats['zh-CN'].singleLine,
    property_type: bundle.address.propertyType,
    latitude: bundle.address.coordinates.latitude,
    longitude: bundle.address.coordinates.longitude,
    source_version: bundle.address.sourceVersion,
    google_place_id: bundle.googleMaps.placeId || '',
    test_card: bundle.card.number,
    card_network: bundle.card.network,
    test_data_only: bundle.card.testDataOnly
  };
  const headers = Object.keys(row);
  return `${headers.join(',')}\n${Object.values(row).map(csvCell).join(',')}\n`;
};
