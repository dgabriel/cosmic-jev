/**
 * Regenerates src/experience/assets/cities.json, the bundled city list behind
 * the intake form's "Birth city" autocomplete, from GeoNames exports
 * (https://download.geonames.org/export/dump/, CC BY 4.0 -- attribution is
 * shown on the intake page):
 *
 *   curl -O https://download.geonames.org/export/dump/cities15000.zip && unzip cities15000.zip
 *   curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
 *   node scripts/build-cities.mjs cities15000.txt admin1CodesASCII.txt
 *
 * Keeps every city with population >= 100k plus every national capital
 * (feature code PPLC), sorted by population descending so array order doubles
 * as the autocomplete's tie-break rank. Each row is
 * [name, admin1 name, country code, latitude, longitude, IANA time zone];
 * coordinates are rounded to 2 decimals (~1 km), far finer than a natal
 * chart needs.
 */
import { readFileSync, writeFileSync } from "node:fs";

const MIN_POPULATION = 100_000;
const OUT_PATH = new URL("../src/experience/assets/cities.json", import.meta.url);

const [citiesPath, admin1Path] = process.argv.slice(2);
if (citiesPath === undefined || admin1Path === undefined) {
  console.error("usage: node scripts/build-cities.mjs <cities15000.txt> <admin1CodesASCII.txt>");
  process.exit(1);
}

const admin1Names = new Map();
for (const line of readFileSync(admin1Path, "utf8").split("\n")) {
  const [code, name] = line.split("\t");
  if (code && name) admin1Names.set(code, name);
}

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const rows = [];
for (const line of readFileSync(citiesPath, "utf8").split("\n")) {
  const cols = line.split("\t");
  if (cols.length < 18) continue;
  const [, name, , , lat, lon, , featureCode, countryCode, , admin1Code] = cols;
  const population = Number(cols[14]);
  const timeZone = cols[17];
  if (population < MIN_POPULATION && featureCode !== "PPLC") continue;
  if (!timeZone) continue;
  const admin1 = admin1Names.get(`${countryCode}.${admin1Code}`) ?? "";
  rows.push({ population, row: [name, admin1, countryCode, round2(lat), round2(lon), timeZone] });
}

rows.sort((a, b) => b.population - a.population);
writeFileSync(OUT_PATH, JSON.stringify(rows.map((r) => r.row)) + "\n");
console.log(`wrote ${rows.length} cities to ${OUT_PATH.pathname}`);
