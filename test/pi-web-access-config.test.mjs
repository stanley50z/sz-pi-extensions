import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../extensions/pi-web-access/config.ts', import.meta.url).href;

async function freshConfigModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

test('loads Brave and Exa API keys from .env in current working directory', async () => {
  const originalCwd = process.cwd();
  const originalExa = process.env.EXA_API_KEY;
  const originalBrave = process.env.BRAVE_API_KEY;
  delete process.env.EXA_API_KEY;
  delete process.env.BRAVE_API_KEY;

  const dir = await mkdtemp(join(tmpdir(), 'pi-web-access-env-'));
  await writeFile(join(dir, '.env'), 'EXA_API_KEY=exa-from-dotenv\nBRAVE_API_KEY=brave-from-dotenv\n', 'utf8');
  process.chdir(dir);

  try {
    const { getEnvApiKey } = await freshConfigModule();
    assert.equal(getEnvApiKey('EXA_API_KEY'), 'exa-from-dotenv');
    assert.equal(getEnvApiKey('BRAVE_API_KEY'), 'brave-from-dotenv');
  } finally {
    process.chdir(originalCwd);
    if (originalExa === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalExa;
    if (originalBrave === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = originalBrave;
  }
});

test('environment variables override .env values', async () => {
  const originalCwd = process.cwd();
  const originalBrave = process.env.BRAVE_API_KEY;
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-access-env-'));
  await writeFile(join(dir, '.env'), 'BRAVE_API_KEY=brave-from-dotenv\n', 'utf8');
  process.chdir(dir);
  process.env.BRAVE_API_KEY = 'brave-from-env';

  try {
    const { getEnvApiKey } = await freshConfigModule();
    assert.equal(getEnvApiKey('BRAVE_API_KEY'), 'brave-from-env');
  } finally {
    process.chdir(originalCwd);
    if (originalBrave === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = originalBrave;
  }
});

test('normalizes search providers to auto, exa, or brave only', async () => {
  const { normalizeSearchProvider } = await freshConfigModule();

  assert.equal(normalizeSearchProvider('auto'), 'auto');
  assert.equal(normalizeSearchProvider('exa'), 'exa');
  assert.equal(normalizeSearchProvider('brave'), 'brave');
  assert.equal(normalizeSearchProvider('perplexity'), 'auto');
  assert.equal(normalizeSearchProvider('gemini'), 'auto');
  assert.equal(normalizeSearchProvider('  BRAVE  '), 'brave');
});
