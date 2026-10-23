import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { TuiAltScreen } from '@earendil-works/pi-tui';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createCommitButtonExtension } from '../extensions/commit-button.ts';

// Drive real fullscreen mouse parsing, CustomEditor and the extension runtime, stopping at the host command-submission boundary.
test('fullscreen Commit/Exit routes terminal clicks through a real Pi session', { timeout: 30_000 }, async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'sz-commit-button-'));
  const logDir = join(homedir(), '.pi', 'agent', 'logs', 'commit-button-validation');
  await mkdir(logDir, { recursive: true });
  const log = { cwd, boundaries: 'simulated terminal and Ctrl state; real fullscreen renderer, editor, extension runtime and session; host command submission recorded instead of executing /quit', screens: [] };
  let ctrl = false;
  let input;
  let session;
  let tui;
  let editor;
  let deferredShutdowns = 0;
  const commands = [];
  const prompts = [];
  const errors = [];
  const plain = text => text;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: directory, settingsManager,
      extensionFactories: [
        createCommitButtonExtension({ isCtrlPressed: () => ctrl }),
        pi => pi.on('input', event => { prompts.push(event.text); return { action: 'handled' }; }),
      ],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    });
    ({ session } = await createAgentSession({
      cwd, agentDir: directory, resourceLoader, settingsManager, modelRuntime,
      sessionManager: SessionManager.inMemory(cwd), tools: [],
    }));
    const terminal = {
      columns: 100, rows: 8, kittyProtocolActive: false,
      start(onInput) { input = onInput; }, stop() {}, write() {},
      hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {},
      clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    };
    tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
    await session.bindExtensions({
      mode: 'tui', shutdownHandler: () => { deferredShutdowns++; }, onError: error => errors.push(error),
      uiContext: {
        theme: { fg: (_color, text) => text },
        getEditorComponent: () => undefined,
        setEditorComponent(factory) {
          editor = factory(tui, {
            borderColor: plain,
            selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
          }, {});
          editor.onSubmit = text => commands.push(text);
        },
      },
    });
    assert.ok(editor);
    editor.setText('unfinished draft');
    tui.setLayoutRoot(editor);
    tui.start();
    const screen = () => tui.getScreenLines().map(stripVTControlCharacters);
    const waitFor = async label => {
      const deadline = Date.now() + 3000;
      while (!screen().some(line => line.includes(label)) && Date.now() < deadline) await delay(25);
      const lines = screen();
      assert.ok(lines.some(line => line.includes(label)), JSON.stringify(lines));
      log.screens.push(lines);
      return lines;
    };
    const click = (lines, label, modifier) => {
      const row = lines.findIndex(line => line.includes(label));
      const x = lines[row].indexOf(label) + 1;
      input(`\x1b[<${modifier};${x};${row + 1}M`);
      input(`\x1b[<${modifier};${x};${row + 1}m`);
    };
    click(await waitFor('[ commit ]'), '[ commit ]', 0);
    await delay(100);
    assert.deepEqual(prompts, ['$commit']);
    assert.deepEqual(commands, []);
    assert.equal(deferredShutdowns, 0);
    ctrl = true;
    const exitLines = await waitFor('[ exit ]');
    input('\x1b[O');
    await waitFor('[ commit ]');
    input('\x1b[I');
    await waitFor('[ exit ]');
    ctrl = false;
    await waitFor('[ commit ]');
    ctrl = true;
    await waitFor('[ exit ]');
    click(exitLines, '[ exit ]', 16);
    assert.deepEqual(commands, ['/quit'], 'one press/release submits the actual built-in quit command once');
    assert.equal(deferredShutdowns, 0, 'do not use the shutdown API that waits for idle');
    assert.deepEqual(prompts, ['$commit']);
    assert.equal(editor.getText(), 'unfinished draft');
    assert.deepEqual(errors, []);
    log.passed = true;
  } catch (error) {
    log.passed = false;
    await writeFile(join(logDir, 'crash-report.txt'), error.stack ?? String(error), 'utf8');
    throw error;
  } finally {
    tui?.stop();
    await session?.extensionRunner.emit({ type: 'session_shutdown' });
    session?.dispose();
    await writeFile(join(logDir, 'latest.json'), JSON.stringify(log, null, 2) + '\n', 'utf8');
    await rm(directory, { recursive: true, force: true });
  }
});
