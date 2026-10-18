import fs from 'node:fs';
const catalog = JSON.parse(fs.readFileSync(new URL('../public/data/catalog.json', import.meta.url), 'utf8'));
const health = catalog.sportsHealth;
if (!health?.checkedAt || health.degraded) {
  throw new Error(`Sports refresh incomplete: ${(health?.failedSources || ['unknown']).join(', ')}. Retained data was published, but this run is not a successful sports refresh.`);
}
console.log(`Sports refreshed: ${catalog.sportsTotal} events, checked ${health.checkedAt}`);
