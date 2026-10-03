// Prints the daily digest to the console from live data — checks the data sources without Discord.
// Usage: npm run preview [-- days]
import { addDays, firstBuyableDate, nowParts, upcoming } from "./dividends.js";
import { digestEmbed } from "./embeds.js";
import { createFeed } from "./feed.js";
import { buildProviders } from "./providers.js";
import { getQuotes } from "./yahoo.js";

const days = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 7;
const now = nowParts();
const today = now.date;

const feed = createFeed({ providers: buildProviders() });
await feed.refresh();
const status = feed.status();
console.log(`Source: ${status.source ?? "-"} · health: ${status.health} · ${status.records.length} rows`);
for (const e of status.errors) console.log(`  ${e.provider} failed: ${e.message}`);
if (!status.fetchedAt) process.exit(1);

const records = upcoming(status.records, firstBuyableDate(now), { until: addDays(today, days) });
const quotes = await getQuotes(records.map((r) => r.ticker));
const embed = digestEmbed({ records, quotes, today, days, status }).toJSON();

console.log(`\n${embed.title}\n${embed.description}\n`);
for (const field of embed.fields ?? []) console.log(`${field.name}\n${field.value}\n`);
console.log(embed.footer.text);
