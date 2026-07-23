const PI = Math.PI;
const A = 6378245;
const EE = 0.006693421622965943;

const outsideChina = (latitude: number, longitude: number): boolean =>
  longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;

const transformLatitude = (longitude: number, latitude: number): number => {
  let value = -100 + 2 * longitude + 3 * latitude + 0.2 * latitude * latitude + 0.1 * longitude * latitude + 0.2 * Math.sqrt(Math.abs(longitude));
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3;
  value += (20 * Math.sin(latitude * PI) + 40 * Math.sin(latitude / 3 * PI)) * 2 / 3;
  value += (160 * Math.sin(latitude / 12 * PI) + 320 * Math.sin(latitude * PI / 30)) * 2 / 3;
  return value;
};

const transformLongitude = (longitude: number, latitude: number): number => {
  let value = 300 + longitude + 2 * latitude + 0.1 * longitude * longitude + 0.1 * longitude * latitude + 0.1 * Math.sqrt(Math.abs(longitude));
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3;
  value += (20 * Math.sin(longitude * PI) + 40 * Math.sin(longitude / 3 * PI)) * 2 / 3;
  value += (150 * Math.sin(longitude / 12 * PI) + 300 * Math.sin(longitude / 30 * PI)) * 2 / 3;
  return value;
};

export const gcj02ToWgs84 = (latitude: number, longitude: number): { latitude: number; longitude: number } => {
  if (outsideChina(latitude, longitude)) return { latitude, longitude };
  let deltaLatitude = transformLatitude(longitude - 105, latitude - 35);
  let deltaLongitude = transformLongitude(longitude - 105, latitude - 35);
  const radianLatitude = latitude / 180 * PI;
  let magic = Math.sin(radianLatitude);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  deltaLatitude = deltaLatitude * 180 / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  deltaLongitude = deltaLongitude * 180 / (A / sqrtMagic * Math.cos(radianLatitude) * PI);
  return { latitude: latitude * 2 - (latitude + deltaLatitude), longitude: longitude * 2 - (longitude + deltaLongitude) };
};
