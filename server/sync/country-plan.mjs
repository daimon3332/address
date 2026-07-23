const dayMilliseconds = 24 * 60 * 60 * 1000;

const timestamp = (value) => {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

export const successfulAt = (entry) => {
  if (!entry) return 0;
  const legacySuccess = ['imported', 'unchanged', 'ready'].includes(entry.status) ? entry.lastChecked : null;
  return timestamp(entry.lastSuccessfulAt || entry.completedAt || legacySuccess);
};

export const isCountryDue = (entry, intervalDays, now) => {
  if (entry?.status === 'failed') return true;
  const lastSuccess = successfulAt(entry);
  return !lastSuccess || now.getTime() - lastSuccess >= intervalDays * dayMilliseconds;
};

const dailyOrder = (state) => (left, right) => {
  const leftState = state.shards[left.id];
  const rightState = state.shards[right.id];
  const leftFailed = leftState?.status === 'failed';
  const rightFailed = rightState?.status === 'failed';
  if (leftFailed !== rightFailed) return leftFailed ? -1 : 1;
  const leftSuccess = successfulAt(leftState);
  const rightSuccess = successfulAt(rightState);
  return leftSuccess - rightSuccess || left.countryCode.localeCompare(right.countryCode)
    || left.id.localeCompare(right.id);
};

export const planCountryShards = ({
  shards,
  state = { shards: {} },
  mode = 'daily',
  now = new Date(),
  maxCountries = mode === 'daily' ? 1 : Number.MAX_SAFE_INTEGER
}) => {
  if (!['initial', 'daily', 'manual'].includes(mode)) throw new Error(`Unknown country sync mode: ${mode}`);
  const entries = state.shards || {};
  let selected;
  if (mode === 'initial') {
    selected = shards.filter((shard) => !successfulAt(entries[shard.id]));
  } else if (mode === 'daily') {
    selected = shards
      .filter((shard) => isCountryDue(entries[shard.id], shard.intervalDays, now))
      .sort(dailyOrder(state));
  } else {
    selected = [...shards];
  }
  return selected.slice(0, maxCountries);
};

export const countryPlanStatus = ({ shards, state = { shards: {} }, now = new Date() }) => {
  const entries = state.shards || {};
  const countries = shards.map((shard) => {
    const entry = entries[shard.id];
    const lastSuccess = successfulAt(entry);
    return {
      shardId: shard.id,
      countryCode: shard.countryCode,
      status: entry?.status || 'pending',
      initialized: Boolean(lastSuccess),
      lastSuccessfulAt: lastSuccess ? new Date(lastSuccess).toISOString() : null,
      due: isCountryDue(entry, shard.intervalDays, now)
    };
  });
  return {
    total: countries.length,
    initialized: countries.filter((country) => country.initialized).length,
    pending: countries.filter((country) => !country.initialized).length,
    countries
  };
};
