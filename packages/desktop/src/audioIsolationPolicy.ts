/**
 * Linux screen-share audio isolation — the decisions, kept pure so they can be
 * tested without a running PulseAudio/PipeWire server.
 *
 * The desktop app's "System audio" toggle records the default sink's monitor
 * (Chromium's PulseAudio loopback). On Linux Chromium does not implement
 * `restrictOwnAudio`, so Backspace's own playback — the channel voices — lands
 * in that monitor and is republished as `ScreenShareAudio`: every participant
 * hears themselves. The isolation swaps the default sink for a private null
 * sink while a capture is live, so the recorded monitor holds every
 * application's audio except Backspace's.
 *
 * `audioIsolation.ts` owns the side effects (spawning `pactl`, timers); this
 * module only parses its output and answers what to do.
 */

/** Name of the private null sink the captured monitor comes from. */
export const AUDIO_ISOLATION_SINK_NAME = 'artium_capture';
/** `device.description`, shown by the desktop's audio OSD while sharing. */
export const AUDIO_ISOLATION_SINK_DESCRIPTION = 'Artium';

/**
 * How many consecutive reconciliation ticks may see no capturing stream before
 * the isolation is torn down. At the reconcile interval this is a few seconds —
 * long enough to ride out the moment between `getDisplayMedia()` resolving and
 * Chromium opening the loopback, and a System Audio off/on toggle.
 */
export const RELEASE_AFTER_MISSING_TICKS = 3;

// ---------------------------------------------------------------------------
// pactl JSON parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export interface PulseInfo {
  serverName: string;
  defaultSinkName: string;
}

/** `pactl -f json info`. Returns null on anything that is not a Pulse server document. */
export function parsePulseInfo(json: string): PulseInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  return {
    serverName: asString(record.server_name) ?? '',
    defaultSinkName: asString(record.default_sink_name) ?? '',
  };
}

export interface PulseEntity {
  index: number;
  name: string;
}

/** `pactl -f json list sinks` / `... list sources` — the `{ index, name }` projection. */
export function parseEntityList(json: string): PulseEntity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entities: PulseEntity[] = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    if (!record) continue;
    const index = asNumber(record.index);
    const name = asString(record.name);
    if (index === null || name === null) continue;
    entities.push({ index, name });
  }
  return entities;
}

export interface PulseSourceOutput {
  index: number;
  source: number;
  ownerModule: number | null;
}

/** `pactl -f json list source-outputs` (active record streams). */
export function parseSourceOutputs(json: string): PulseSourceOutput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const outputs: PulseSourceOutput[] = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    if (!record) continue;
    const index = asNumber(record.index);
    const source = asNumber(record.source);
    if (index === null || source === null) continue;
    outputs.push({ index, source, ownerModule: asNumber(record.owner_module) });
  }
  return outputs;
}

/**
 * How many record streams are capturing `monitorSourceIndex`. Our own
 * `module-loopback` records the same monitor and appears here with an
 * `owner_module`, so it — and any other server-side module stream — is
 * excluded; only application captures (Chromium's loopback) count.
 */
export function countApplicationRecordings(
  outputs: readonly PulseSourceOutput[],
  monitorSourceIndex: number,
  excludedModules: ReadonlySet<number>,
): number {
  let count = 0;
  for (const output of outputs) {
    if (output.source !== monitorSourceIndex) continue;
    if (output.ownerModule !== null && excludedModules.has(output.ownerModule)) continue;
    count++;
  }
  return count;
}

export interface PulseSinkInput {
  index: number;
  sink: number;
  ownerModule: number | null;
  applicationName: string | null;
  processBinary: string | null;
  processId: number | null;
}

/** `pactl -f json list sink-inputs` (active playback streams). */
export function parseSinkInputs(json: string): PulseSinkInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const inputs: PulseSinkInput[] = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    if (!record) continue;
    const index = asNumber(record.index);
    const sink = asNumber(record.sink);
    if (index === null || sink === null) continue;
    const properties = asRecord(record.properties) ?? {};
    inputs.push({
      index,
      sink,
      ownerModule: asNumber(record.owner_module),
      applicationName: asString(properties['application.name']),
      processBinary: asString(properties['application.process.binary']),
      processId: asNumber(properties['application.process.id']),
    });
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// Which streams belong to this app
// ---------------------------------------------------------------------------

/**
 * How to recognise the app's own playback. Chromium plays audio from its
 * audio-service process, which runs the same executable as the app and carries
 * the app's name, so the process binary and the announced application name are
 * enough — no process-tree walk needed.
 */
export interface OwnIdentity {
  /** Executable basenames of this app's processes. */
  binaryNames: ReadonlySet<string>;
  /** `application.name` values this app announces. */
  applicationNames: ReadonlySet<string>;
}

/** Whether a playback stream was produced by this app. One matching signal is enough. */
export function isOwnApplication(input: PulseSinkInput, identity: OwnIdentity): boolean {
  if (input.processBinary !== null && identity.binaryNames.has(input.processBinary)) return true;
  if (input.applicationName !== null && identity.applicationNames.has(input.applicationName)) return true;
  return false;
}

/**
 * The sink Backspace currently plays to, so its audio can be kept off the
 * captured null sink while its user-chosen output (headphones, a USB card, the
 * system default) is preserved. Falls back to `fallback` when the app has no
 * live playback stream to read.
 */
export function resolveAppOutputSink(
  inputs: readonly PulseSinkInput[],
  sinks: readonly PulseEntity[],
  identity: OwnIdentity,
  fallback: string,
): string {
  const nameByIndex = new Map(sinks.map((sink) => [sink.index, sink.name]));
  for (const input of inputs) {
    if (input.ownerModule !== null) continue;
    if (!isOwnApplication(input, identity)) continue;
    const name = nameByIndex.get(input.sink);
    if (name) return name;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface SinkMove {
  index: number;
  targetSink: string;
}

/**
 * Which playback streams need moving once the captured null sink is the default:
 *   - Backspace's own streams must leave the captured sink (X) and go back to
 *     the app's output sink so they are heard but not recorded;
 *   - every other application's stream must join the captured sink so it is
 *     heard (via the loopback) and recorded — including streams that were already
 *     playing before the share started, which would otherwise stay on the old
 *     physical sink and never make it into the stream.
 *
 * Server-side module streams (the loopback itself) carry an `owner_module` and
 * are left alone.
 */
export function planSinkMoves(
  inputs: readonly PulseSinkInput[],
  opts: { nullSinkIndex: number; appOutputSink: string; identity: OwnIdentity },
): SinkMove[] {
  const moves: SinkMove[] = [];
  for (const input of inputs) {
    if (input.ownerModule !== null) continue;
    const ours = isOwnApplication(input, opts.identity);
    const onCapturedSink = input.sink === opts.nullSinkIndex;
    if (ours) {
      if (onCapturedSink) moves.push({ index: input.index, targetSink: opts.appOutputSink });
    } else if (!onCapturedSink) {
      moves.push({ index: input.index, targetSink: AUDIO_ISOLATION_SINK_NAME });
    }
  }
  return moves;
}

export interface ReconcileDecision {
  missingTicks: number;
  release: boolean;
}

/**
 * Whether the capture that justified the isolation is still open. A tick with
 * no capturing stream counts toward release; a tick with one resets the count,
 * so a brief gap (System Audio toggled off and back on) does not tear the
 * isolation down.
 */
export function reconcileRelease(
  missingTicks: number,
  recordingCount: number,
  releaseAfter: number,
): ReconcileDecision {
  if (recordingCount > 0) return { missingTicks: 0, release: false };
  const next = missingTicks + 1;
  return { missingTicks: next, release: next >= releaseAfter };
}
