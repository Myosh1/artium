/**
 * Linux screen-share audio isolation — the side-effecting half.
 *
 * Chromium's system-audio capture records the default sink's monitor, and on
 * Linux it ignores `restrictOwnAudio`. Without help, the app's own playback
 * (the channel voices) is recorded and republished as `ScreenShareAudio`, so
 * everyone hears themselves. This manager makes the app inaudible to that
 * capture for as long as a capture is live:
 *
 *   1. load a private null sink       (artium_capture)
 *   2. loop its monitor to the current physical output, so other applications
 *      are still heard
 *   3. make the null sink the default, so Chromium records its monitor
 *   4. keep every other application on the null sink and the app off it
 *   5. tear all of that down once no application is recording the monitor
 *
 * The live capture is detected through `pactl list source-outputs`: Chromium's
 * loopback is an application record stream on the null sink's monitor, while
 * our own `module-loopback` carries an `owner_module` and is excluded. A short
 * debounce rides out the gap while System Audio is toggled off and on.
 *
 * The decisions and `pactl` parsing live in `audioIsolationPolicy.ts`; this file
 * only touches the system. One `AudioIsolation` instance (`audioIsolation`)
 * owns a session's state, mirroring `AudioManager` and `KeybindManager`.
 */

import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import {
  AUDIO_ISOLATION_SINK_DESCRIPTION,
  AUDIO_ISOLATION_SINK_NAME,
  RELEASE_AFTER_MISSING_TICKS,
  countApplicationRecordings,
  parseEntityList,
  parsePulseInfo,
  parseSinkInputs,
  parseSourceOutputs,
  planSinkMoves,
  reconcileRelease,
  resolveAppOutputSink,
  type OwnIdentity,
} from './audioIsolationPolicy';

const LOG = '[audioIsolation]';
const PACTL_TIMEOUT_MS = 3_000;
const RECONCILE_INTERVAL_MS = 2_000;
const STATE_FILE = 'audio-isolation.json';

// ---------------------------------------------------------------------------
// pactl
// ---------------------------------------------------------------------------

function runPactl(args: string[], timeoutMs = PACTL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Runs `pactl`, returning null instead of throwing — a missing server is not fatal. */
async function runPactlSafe(args: string[]): Promise<string | null> {
  try {
    return await runPactl(args);
  } catch {
    return null;
  }
}

/** Synchronous variant for `before-quit`, where the event loop is going away. */
function runPactlSync(args: string[], timeoutMs = 1_500): string | null {
  try {
    return String(execFileSync('pactl', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }));
  } catch {
    return null;
  }
}

function parseModuleId(stdout: string | null): number | null {
  if (!stdout) return null;
  const id = Number(stdout.trim());
  return Number.isInteger(id) ? id : null;
}

async function currentDefaultSink(): Promise<string | null> {
  const direct = (await runPactlSafe(['get-default-sink']))?.trim();
  if (direct) return direct;
  const info = parsePulseInfo((await runPactlSafe(['-f', 'json', 'info'])) ?? '');
  return info?.defaultSinkName ?? null;
}

/**
 * The default sink is server-side metadata that PipeWire can report a beat
 * after `set-default-sink` returns. Wait until it is actually in force, so the
 * loopback Chromium opens next records the isolated monitor rather than the
 * physical one.
 */
async function waitForDefaultSink(expected: string, attempts = 10, delayMs = 100): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await currentDefaultSink()) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

/** `pactl list short modules` → `{ id, args }`, for the crash-recovery sweep. */
function parseShortModules(text: string): Array<{ id: number; args: string }> {
  const modules: Array<{ id: number; args: string }> = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+\S+\s*(.*)$/.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    if (Number.isInteger(id)) modules.push({ id, args: match[2] ?? '' });
  }
  return modules;
}

// ---------------------------------------------------------------------------
// Own-process identity
// ---------------------------------------------------------------------------

/**
 * The app's own playback streams. Chromium plays audio from its audio-service
 * process, which runs the same executable as the app and announces the app
 * name, so the executable basename and `app.getName()` are enough to tell the
 * app's audio apart from everything else.
 */
function collectOwnIdentity(): OwnIdentity {
  const binaryNames = new Set<string>();
  const executable = path.basename(process.execPath);
  binaryNames.add(executable);
  if (executable.endsWith('.exe')) binaryNames.add(executable.slice(0, -'.exe'.length));
  return {
    binaryNames,
    applicationNames: new Set([app.getName()]),
  };
}

// ---------------------------------------------------------------------------
// Persisted crash-recovery state
// ---------------------------------------------------------------------------

interface IsolationState {
  originalSink: string;
  moduleIds: number[];
}

function stateFilePath(): string | null {
  try {
    return path.join(app.getPath('userData'), STATE_FILE);
  } catch {
    return null;
  }
}

function writeStateFile(state: IsolationState): void {
  const file = stateFilePath();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch (err) {
    console.warn(`${LOG} could not persist recovery state:`, err);
  }
}

function readStateFile(): IsolationState | null {
  const file = stateFilePath();
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<IsolationState>;
    const originalSink = typeof parsed.originalSink === 'string' ? parsed.originalSink : '';
    if (!originalSink) return null;
    const moduleIds = Array.isArray(parsed.moduleIds)
      ? parsed.moduleIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
      : [];
    return { originalSink, moduleIds };
  } catch {
    return null;
  }
}

function deleteStateFile(): void {
  const file = stateFilePath();
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort; the next sweep re-derives everything from the server.
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Owns one isolation session: the sink it created, its modules and its timer. */
class AudioIsolation {
  private active = false;
  private starting: Promise<boolean> | null = null;
  private originalSink: string | null = null;
  private appOutputSink: string | null = null;
  private nullSinkIndex: number | null = null;
  private monitorSourceIndex: number | null = null;
  private ownIdentity: OwnIdentity | null = null;
  private loadedModules: number[] = [];
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileInFlight = false;
  private missingTicks = 0;

  /**
   * Start isolating the app from the system-audio capture. Called from the
   * display-media handler before Chromium opens the loopback, so the captured
   * monitor already excludes the app's audio. Idempotent and serialized;
   * returns true when isolation is in force. A no-op away from Linux or a
   * Pulse-compatible server.
   */
  async ensure(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    if (this.active) return true;
    if (this.starting) return this.starting;
    this.starting = this.setup();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async setup(depth = 0): Promise<boolean> {
    if (process.platform !== 'linux') return false;

    const info = parsePulseInfo((await runPactlSafe(['-f', 'json', 'info'])) ?? '');
    if (!info?.defaultSinkName) {
      console.warn(`${LOG} no PulseAudio-compatible server; system audio cannot be isolated`);
      return false;
    }
    if (info.defaultSinkName === AUDIO_ISOLATION_SINK_NAME) {
      // A previous run leaked the sink (crash). Recover once, then isolate.
      if (depth > 0) return false;
      await this.sweepStale();
      return this.setup(depth + 1);
    }

    const physicalSink = info.defaultSinkName;
    const identity = collectOwnIdentity();
    this.ownIdentity = identity;
    const sinks = parseEntityList((await runPactlSafe(['-f', 'json', 'list', 'sinks'])) ?? '');
    const inputs = parseSinkInputs((await runPactlSafe(['-f', 'json', 'list', 'sink-inputs'])) ?? '');
    this.originalSink = physicalSink;
    this.appOutputSink = resolveAppOutputSink(inputs, sinks, identity, physicalSink);

    try {
      if (!(await this.createSink())) throw new Error('could not create the isolation sink');
      [this.nullSinkIndex, this.monitorSourceIndex] = await this.resolveSinkIndexes();
      if (this.nullSinkIndex === null || this.monitorSourceIndex === null) {
        throw new Error('could not resolve the isolation sink indexes');
      }
      if (!(await this.createLoopback(physicalSink))) throw new Error('could not create the loopback');
      await this.switchDefaultSink();
    } catch (err) {
      console.warn(`${LOG} setup failed, rolling back:`, err);
      await this.unloadModules();
      this.reset();
      return false;
    }

    this.active = true;
    this.missingTicks = 0;
    writeStateFile({ originalSink: physicalSink, moduleIds: this.loadedModules });
    this.startReconciliation();
    void this.reconcile();
    console.log(`${LOG} isolated system audio (physical sink: ${physicalSink})`);
    return true;
  }

  private async createSink(): Promise<boolean> {
    const moduleId = parseModuleId(await runPactlSafe([
      'load-module',
      'module-null-sink',
      `sink_name=${AUDIO_ISOLATION_SINK_NAME}`,
      `sink_properties=device.description=${AUDIO_ISOLATION_SINK_DESCRIPTION}`,
    ]));
    if (moduleId === null) return false;
    this.loadedModules.push(moduleId);
    return true;
  }

  private async createLoopback(physicalSink: string): Promise<boolean> {
    const moduleId = parseModuleId(await runPactlSafe([
      'load-module',
      'module-loopback',
      `source=${AUDIO_ISOLATION_SINK_NAME}.monitor`,
      `sink=${physicalSink}`,
    ]));
    if (moduleId === null) return false;
    this.loadedModules.push(moduleId);
    return true;
  }

  /** The created sink and its monitor source, once the server reports them. */
  private async resolveSinkIndexes(): Promise<[number | null, number | null]> {
    const sinks = parseEntityList((await runPactlSafe(['-f', 'json', 'list', 'sinks'])) ?? '');
    const sources = parseEntityList((await runPactlSafe(['-f', 'json', 'list', 'sources'])) ?? '');
    return [
      sinks.find((sink) => sink.name === AUDIO_ISOLATION_SINK_NAME)?.index ?? null,
      sources.find((source) => source.name === `${AUDIO_ISOLATION_SINK_NAME}.monitor`)?.index ?? null,
    ];
  }

  private async switchDefaultSink(): Promise<void> {
    if (await runPactlSafe(['set-default-sink', AUDIO_ISOLATION_SINK_NAME]) === null) {
      throw new Error('set-default-sink failed');
    }
    if (!(await waitForDefaultSink(AUDIO_ISOLATION_SINK_NAME))) {
      throw new Error('the default sink did not switch');
    }
  }

  /** Restore the physical sink, unload the modules, forget the session. */
  async release(): Promise<void> {
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        // Setup already rolled itself back.
      }
    }
    if (!this.active) return;
    this.active = false;
    this.stopReconciliation();

    await this.moveStreamsOffCapturedSink();
    await this.restoreDefaultSink();
    await this.unloadModules();
    deleteStateFile();
    this.reset();
    console.log(`${LOG} released system-audio isolation`);
  }

  /** Synchronous best effort for `before-quit`, where the process is going away. */
  releaseSync(): void {
    if (!this.active) return;
    this.active = false;
    this.stopReconciliation();

    if (this.originalSink) {
      const info = parsePulseInfo(runPactlSync(['-f', 'json', 'info']) ?? '');
      if (info?.defaultSinkName === AUDIO_ISOLATION_SINK_NAME) {
        runPactlSync(['set-default-sink', this.originalSink]);
      }
    }
    for (const id of [...this.loadedModules].reverse()) {
      runPactlSync(['unload-module', String(id)]);
    }
    this.loadedModules = [];
    deleteStateFile();
    this.reset();
  }

  /**
   * Pull every stream off the captured sink before it disappears, so nothing
   * is left pointing at a sink that is about to be unloaded.
   */
  private async moveStreamsOffCapturedSink(): Promise<void> {
    if (this.nullSinkIndex === null || !this.originalSink) return;
    const inputs = parseSinkInputs((await runPactlSafe(['-f', 'json', 'list', 'sink-inputs'])) ?? '');
    for (const input of inputs) {
      if (input.ownerModule === null && input.sink === this.nullSinkIndex) {
        await runPactlSafe(['move-sink-input', String(input.index), this.originalSink]);
      }
    }
  }

  private async restoreDefaultSink(): Promise<void> {
    if (!this.originalSink) return;
    const info = parsePulseInfo((await runPactlSafe(['-f', 'json', 'info'])) ?? '');
    if (info?.defaultSinkName === AUDIO_ISOLATION_SINK_NAME) {
      await runPactlSafe(['set-default-sink', this.originalSink]);
    }
  }

  private async unloadModules(): Promise<void> {
    const ids = [...this.loadedModules].reverse();
    this.loadedModules = [];
    for (const id of ids) {
      await runPactlSafe(['unload-module', String(id)]);
    }
  }

  private reset(): void {
    this.originalSink = null;
    this.appOutputSink = null;
    this.nullSinkIndex = null;
    this.monitorSourceIndex = null;
    this.ownIdentity = null;
    this.missingTicks = 0;
  }

  /** Remove anything a previous (crashed) run left behind. */
  async sweepStale(): Promise<void> {
    if (process.platform !== 'linux') return;

    const saved = readStateFile();
    const sinks = parseEntityList((await runPactlSafe(['-f', 'json', 'list', 'sinks'])) ?? '');
    const physical = saved?.originalSink && sinks.some((sink) => sink.name === saved.originalSink)
      ? saved.originalSink
      : sinks.find((sink) => sink.name !== AUDIO_ISOLATION_SINK_NAME)?.name ?? null;

    const info = parsePulseInfo((await runPactlSafe(['-f', 'json', 'info'])) ?? '');
    if (info?.defaultSinkName === AUDIO_ISOLATION_SINK_NAME && physical) {
      await runPactlSafe(['set-default-sink', physical]);
    }

    const ids = new Set<number>(saved?.moduleIds ?? []);
    const moduleList = await runPactlSafe(['list', 'short', 'modules']);
    if (moduleList) {
      for (const module of parseShortModules(moduleList)) {
        if (module.args.includes(AUDIO_ISOLATION_SINK_NAME)) ids.add(module.id);
      }
    }
    for (const id of ids) {
      await runPactlSafe(['unload-module', String(id)]);
    }
    deleteStateFile();
    if (ids.size > 0) console.log(`${LOG} swept ${ids.size} stale isolation module(s)`);
  }

  private startReconciliation(): void {
    this.stopReconciliation();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, RECONCILE_INTERVAL_MS);
    // Never keep the event loop (and the app) alive for a timer.
    this.reconcileTimer.unref?.();
  }

  private stopReconciliation(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  private async reconcile(): Promise<void> {
    if (!this.active || this.reconcileInFlight) return;
    this.reconcileInFlight = true;
    try {
      // Is the capture still open? A few empty ticks mean the share ended.
      const outputs = parseSourceOutputs((await runPactlSafe(['-f', 'json', 'list', 'source-outputs'])) ?? '');
      const recordings = this.monitorSourceIndex === null
        ? 0
        : countApplicationRecordings(outputs, this.monitorSourceIndex, new Set(this.loadedModules));
      const decision = reconcileRelease(this.missingTicks, recordings, RELEASE_AFTER_MISSING_TICKS);
      this.missingTicks = decision.missingTicks;
      if (decision.release) {
        await this.release();
        return;
      }

      // Keep other applications on the captured sink and this app off it. The
      // sink and identity are cached for the session, so each tick costs two
      // `pactl` calls and no process scan.
      if (this.nullSinkIndex === null || !this.appOutputSink || !this.ownIdentity) return;
      const inputs = parseSinkInputs((await runPactlSafe(['-f', 'json', 'list', 'sink-inputs'])) ?? '');
      const moves = planSinkMoves(inputs, {
        nullSinkIndex: this.nullSinkIndex,
        appOutputSink: this.appOutputSink,
        identity: this.ownIdentity,
      });
      for (const move of moves) {
        await runPactlSafe(['move-sink-input', String(move.index), move.targetSink]);
      }
    } catch (err) {
      console.warn(`${LOG} reconciliation failed:`, err);
    } finally {
      this.reconcileInFlight = false;
    }
  }
}

/** The app's single isolation manager. */
export const audioIsolation = new AudioIsolation();
