import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const skillPath = join(process.cwd(), "skills", "firecrawl-specialist", "SKILL.md");

test("compact Firecrawl skill keeps Ketch as the default research path", () => {
  const skill = readFileSync(skillPath, "utf8");

  assert.match(skill, /^name: firecrawl-specialist$/m);
  assert.match(skill, /General web discovery uses Ketch/);
  assert.match(skill, /firecrawl --status/);
  assert.match(skill, /credits/i);
  assert.doesNotMatch(skill, /firecrawl-(?:search|scrape|crawl)\/SKILL\.md/);
});
