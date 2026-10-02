/**
 * Linux screen-share audio isolation — the side-effecting half.
 *
 * Chromium's system-audio capture records the default sink's monitor, and on
 * Linux it ignores `restrictOwnAudio`. Without help, Backspace's own playback
 * (the channel voices) is recorded and republished as `ScreenShareAudio`, so
 * everyone hears themselves. This module makes the app inaudible to that
 * capture for as long as a capture is live:
 *
 *   1. load a private null sink       (backspace_capture)
 *   2. loop its monitor to the current physical output, so other applications
 *      are still heard
 *   3. make the null sink the default, so Chromium records its monitor
 *   4. keep every other application on the null sink and Backspace off it
 *   5. tear all of that down once no application is recording the monitor
 *
 * The live capture is detected through `pactl list source-outputs`: Chromium's
 * loopback is an application record stream on the null sink's monitor, while
 * our own `module-loopback` carries an `owner_module` and is excluded. A short
 * debounce rides out the gap while System Audio is toggled off and on.
 *
 * Policy and parsing live in `audioIsolationPolicy.ts`; this file only touches
 * the system.
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

let active = false;
let starting: Promise<boolean> | null = null;
let originalSink: string | null = null;
let appOutputSink: string | null = null;
let nullSinkIndex: number | null = null;
let monitorSourceIndex: number | null = null;
let loadedModules: number[] = [];
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconcileInFlight = false;
let missingTicks = 0;

// ---------------------------------------------------------------------------
// pactl helpers
// ---------------------------------------------------------------------------

function runPactl(args: string[], timeoutMs = PACTL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function runPactlSafe(args: string[]): Promise<string | null> {
  try {
    return await runPactl(args);
  } catch {
    return null;
  }
}

function runPactlSync(args: string[], timeoutMs = 1_500): string | null {
  try {
    return String(execFileSync('pactl', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }));
  } catch {
    return null;
  }
}

function parseModuleId(stdout: string | null): number | null {
  if (!stdout) return null;
  const n = Number(stdout.trim());
  return Number.isInteger(n) ? n : null;
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

/** Every process in this app's tree, so Chromium's audio service is included. */
function collectProcessTreePids(rootPid: number): Set<number> {
  const pids = new Set<number>([rootPid]);
  const parentOf = new Map<number, number>();
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return pids;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // "pid (comm) state ppid ..." — comm can contain spaces and parens.
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      const ppid = Number(fields[1]);
      if (Number.isInteger(ppid)) parentOf.set(pid, ppid);
    } catch {
      // Process vanished or is not readable — skip.
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of parentOf) {
      if (!pids.has(pid) && pids.has(ppid)) {
        pids.add(pid);
        changed = true;
      }
    }
  }
  return pids;
}

function collectOwnIdentity(): OwnIdentity {
  const binaryNames = new Set<string>();
  const execName = path.basename(process.execPath);
  binaryNames.add(execName);
  if (execName.endsWith('.exe')) binaryNames.add(execName.slice(0, -'.exe'.length));
  const applicationNames = new Set<string>([app.getName(), 'Backspace']);
  return {
    pids: collectProcessTreePids(process.pid),
    binaryNames,
    applicationNames,
  };
}

// ---------------------------------------------------------------------------
// Persisted crash-recovery state
// ---------------------------------------------------------------------------

interface IsolationStateFile {
  originalSink: string;
  moduleIds: number[];
}

function stateFilePath(): string | null {
  try {
    return path.join(app.getPath('userData'), 'audio-isolation.json');
  } catch {
    return null;
  }
}

function writeStateFile(): void {
  const file = stateFilePath();
  if (!file || !originalSink) return;
  const state: IsolationStateFile = { originalSink, moduleIds: loadedModules };
  try {
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch (err) {
    console.warn(`${LOG} could not persist recovery state:`, err);
  }
}

function readStateFile(): IsolationStateFile | null {
  const file = stateFilePath();
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<IsolationStateFile>;
    const originalSinkValue = typeof parsed.originalSink === 'string' ? parsed.originalSink : '';
    const moduleIds = Array.isArray(parsed.moduleIds)
      ? parsed.moduleIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
      : [];
    if (!originalSinkValue) return null;
    return { originalSink: originalSinkValue, moduleIds };
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
// Setup / teardown
// ---------------------------------------------------------------------------

async function loadNullSink(): Promise<boolean> {
  const moduleId = parseModuleId(await runPactlSafe([
    'load-module',
    'module-null-sink',
    `sink_name=${AUDIO_ISOLATION_SINK_NAME}`,
    `sink_properties=device.description=${AUDIO_ISOLATION_SINK_DESCRIPTION}`,
  ]));
  if (moduleId === null) {
    console.warn(`${LOG} could not create the isolation sink`);
    return false;
  }
  loadedModules.push(moduleId);
  return true;
}

/**
 * Start isolating Backspace from the system-audio capture. Called from the
 * display-media handler before Chromium opens the loopback, so the captured
 * monitor is already Backspace-free. Idempotent and serialized; returns true
 * when isolation is in force. A no-op away from Linux or a Pulse-compatible
 * server.
 */
export async function ensureAudioIsolation(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  if (active) return true;
  if (starting) return starting;
  starting = setup();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function setup(depth = 0): Promise<boolean> {
  if (process.platform !== 'linux') return false;

  const info = parsePulseInfo((await runPactlSafe(['-f', 'json', 'info'])) ?? '');
  if (!info || !info.defaultSinkName) {
    console.warn(`${LOG} no PulseAudio-compatible server; system audio cannot be isolated`);
    return false;
  }
  if (info.defaultSinkName === AUDIO_ISOLATION_SINK_NAME) {
    // A previous run leaked the sink (crash). Recover once, then isolate.
    if (depth > 0) return false;
    await sweepStaleAudioIsolation();
    return setup(depth + 1);
  }
  const physicalSink = info.defaultSinkName;

  const identity = collectOwnIdentity();
  const sinksBefore = parseEntityList((await runPactlSafe(['-f', 'json', 'list', 'sinks'])) ?? '');
  const inputsBefore = parseSinkInputs((await runPactlSafe(['-f', 'json', 'list', 'sink-inputs'])) ?? '');
  const resolvedAppSink = resolveAppOutputSink(inputsBefore, sinksBefore, identity, physicalSink);

  originalSink = physicalSink;
  appOutputSink = resolvedAppSink;

  try {
    if (!(await loadNullSink())) throw new Error('null sink');

    const sinks = parseEntityList((await runPactlSafe(['-f', 'json', 'list', 'sinks'])) ?? '');
    nullSinkIndex = sinks.find((sink) => sink.name === AUDIO_ISOLATION_SINK_NAME)?.index ?? null;

    const sources = parseEntityList((await runPactlSafe(['-f', 'json', 'list', 'sources'])) ?? '');
    monitorSourceIndex = sources.find((source) => source.name === `${AUDIO_ISOLATION_SINK_NAME}.monitor`)?.index ?? null;
    if (nullSinkIndex === null || monitorSourceIndex === null) throw new Error('sink introspection');

    const loopbackId = parseModuleId(await runPactlSafe([
      'load-module',
      'module-loopback',
      `source=${AUDIO_ISOLATION_SINK_NAME}.monitor`,
      `sink=${physicalSink}`,
    ]));
    if (loopbackId === null) throw new Error('loopback');
    loadedModules.push(loopbackId);

    if (await runPactlSafe(['set-default-sink', AUDIO_ISOLATION_SINK_NAME]) === null) {
      throw new Error('set-default-sink');
    }
    if (!(await waitForDefaultSink(AUDIO_ISOLATION_SINK_NAME))) {
      throw new Error('default sink did not switch');
    }
  } catch (err) {
    console.warn(`${LOG} setup failed, rolling back:`, err);
    await unloadAllModules();
    originalSink = null;
    appOutputSink = null;
    nullSinkIndex = null;
    monitorSourceIndex = null;
    return false;
  }

  active = true;
  missingTicks = 0;
  writeStateFile();
  startReconciliation();
  void reconcile();
  console.log(`${LOG} isolated system audio (physical sink: ${physicalSink})`);
  return true;
}

async function unloadAllModules(): Promise<void> {
  const ids = [...loadedModules].reverse();
  loadedModules = [];
  for (const id of ids) {
    await runPactlSafe(['unload-module', String(id)]);
  }
}

/** Restore the physical sink, unload the modules, forget the state. */
export async function releaseAudioIsolation(): Promise<void> {
  if (starting) {
    try {
      await starting;
    } catch {
      // Setup already rolled itself back.
    }
  }
  if (!active) return;
  active = false;
  stopReconciliation();

  const physical = originalSink;
  // Pull every stream off the captured sink before it disappears, so nothing
  // is left pointing at a sink that is about to be unloaded.
  if (nullSinkIndex !== null && physical) {
    const inputs = parseSinkInputs((await runPactlSafe(['-f', 'json', 'list', 'sink-inputs'])) ?? '');
    for (const input of inputs) {
      if (input.ownerModule === null && input.sink === nullSinkIndex) {
        await runPactlSafe(['move-sink-input', String(input.index), physical]);
      }
    }
  }
  if (physical) {
    const info = parsePulseInfo((await runPactlSafe(['-f', 'json', 'info'])) ?? '');
    if (info?.defaultSinkName === AUDIO_ISOLATION_SINK_NAME) {
      await runPactlSafe(['set-default-sink', physical]);
    }
  }
  await unloadAllModules();
  deleteStateFile();

  originalSink = null;
  appOutputSink = null;
  nullSinkIndex = null;
  monitorSourceIndex = null;
  missingTicks = 0;
  console.log(`${LOG} released system-audio isolation`);
}

/** Synchronous best effort for `before-quit`, where the process is going away. */
export function releaseAudioIsolationSync(): void {
  if (!active) return;
  active = false;
  stopReconciliation();
  const physical = originalSink;
  if (physical) {
    const info = parsePulseInfo(runPactlSync(['-f', 'json', 'info']) ?? '');
    if (info?.defaultSinkName === AUDIO_ISOLATION_SINK_NAME) {
      runPactlSync(['set-default-sink', physical]);
    }
  }
  for (const id of [...loadedModules].reverse()) {
    runPactlSync(['unload-module', String(id)]);
  }
  loadedModules = [];
  deleteStateFile();
}

/** Remove anything a previous (crashed) run left behind. */
export async function sweepStaleAudioIsolation(): Promise<void> {
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

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function startReconciliation(): void {
  stopReconciliation();
  reconcileTimer = setInterval(() => {
    void reconcile();
  }, RECONCILE_INTERVAL_MS);
  // Never keep the event loop (and the app) alive for a timer.
  reconcileTimer.unref?.();
}

function stopReconciliation(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

async function reconcile(): Promise<void> {
  if (!active || reconcileInFlight) return;
  reconcileInFlight = true;
  try {
    const excluded = new Set(loadedModules);
    const outputs = parseSourceOutputs((await runPactlSafe(['-f', 'json', 'list', 'source-outputs'])) ?? '');
    const recordings = monitorSourceIndex === null
      ? 0
      : countApplicationRecordings(outputs, monitorSourceIndex, excluded);

    const decision = reconcileRelease(missingTicks, recordings, RELEASE_AFTER_MISSING_TICKS);
    missingTicks = decision.missingTicks;
    if (decision.release) {
      await releaseAudioIsolation();
      return;
    }

    if (nullSinkIndex === null || !appOutputSink) return;
    const sinks = parseEntityList((await runPactlSafe(['-f', 'json', 'list', 'sinks'])) ?? '');
    const capturedSink = sinks.find((sink) => sink.name === AUDIO_ISOLATION_SINK_NAME);
    if (!capturedSink) {
      // The sink was removed out from under us; drop the isolation cleanly.
      await releaseAudioIsolation();
      return;
    }
    nullSinkIndex = capturedSink.index;

    const inputs = parseSinkInputs((await runPactlSafe(['-f', 'json', 'list', 'sink-inputs'])) ?? '');
    const moves = planSinkMoves(inputs, {
      nullSinkIndex,
      appOutputSink,
      identity: collectOwnIdentity(),
    });
    for (const move of moves) {
      await runPactlSafe(['move-sink-input', String(move.index), move.targetSink]);
    }
  } catch (err) {
    console.warn(`${LOG} reconciliation failed:`, err);
  } finally {
    reconcileInFlight = false;
  }
}
