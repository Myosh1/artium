import { describe, it, expect } from 'vitest';
import {
  AUDIO_ISOLATION_SINK_NAME,
  countApplicationRecordings,
  isOwnApplication,
  parseEntityList,
  parsePulseInfo,
  parseSinkInputs,
  parseSourceOutputs,
  planSinkMoves,
  reconcileRelease,
  resolveAppOutputSink,
  type OwnIdentity,
  type PulseSinkInput,
} from './audioIsolationPolicy';

const identity: OwnIdentity = {
  binaryNames: new Set(['Artium', 'electron']),
  applicationNames: new Set(['Artium']),
};

function sinkInput(overrides: Partial<PulseSinkInput>): PulseSinkInput {
  return {
    index: 1,
    sink: 10,
    ownerModule: null,
    applicationName: null,
    processBinary: null,
    processId: null,
    ...overrides,
  };
}

describe('parsePulseInfo', () => {
  it('reads the server and default sink names', () => {
    expect(parsePulseInfo('{"server_name":"PulseAudio (on PipeWire 1.6.8)","default_sink_name":"bluez_output"}'))
      .toEqual({ serverName: 'PulseAudio (on PipeWire 1.6.8)', defaultSinkName: 'bluez_output' });
  });

  it('returns null for non-JSON and array payloads', () => {
    expect(parsePulseInfo('not json')).toBeNull();
    expect(parsePulseInfo('[]')).toBeNull();
  });

  it('reports empty names for an object without them', () => {
    expect(parsePulseInfo('{}')).toEqual({ serverName: '', defaultSinkName: '' });
  });
});

describe('parseEntityList', () => {
  it('projects index and name, coercing numeric strings', () => {
    expect(parseEntityList('[{"index":5,"name":"a"},{"index":"6","name":"b"},{"index":7},{"name":"c"}]'))
      .toEqual([{ index: 5, name: 'a' }, { index: 6, name: 'b' }]);
  });

  it('returns an empty list for a malformed payload', () => {
    expect(parseEntityList('oops')).toEqual([]);
    expect(parseEntityList('{"index":1}')).toEqual([]);
  });
});

describe('parseSourceOutputs + countApplicationRecordings', () => {
  const outputs = parseSourceOutputs(JSON.stringify([
    { index: 1, source: 42, owner_module: null },       // Chromium's capture
    { index: 2, source: 42, owner_module: '536870917' }, // our loopback module
    { index: 3, source: 99, owner_module: null },        // capture of some other monitor
  ]));

  it('counts only application captures of the given monitor', () => {
    expect(countApplicationRecordings(outputs, 42, new Set([536870917]))).toBe(1);
  });

  it('ignores everything when the monitor has no records', () => {
    expect(countApplicationRecordings(outputs, 1234, new Set())).toBe(0);
  });
});

describe('parseSinkInputs', () => {
  it('extracts the ownership properties and tolerates missing ones', () => {
    expect(parseSinkInputs(JSON.stringify([
      {
        index: 134,
        sink: 169,
        owner_module: null,
        properties: {
          'application.name': 'Artium',
          'application.process.binary': 'Artium',
          'application.process.id': '2898',
        },
      },
      { index: 1448, sink: 169, owner_module: '536870917', properties: {} },
    ]))).toEqual([
      {
        index: 134,
        sink: 169,
        ownerModule: null,
        applicationName: 'Artium',
        processBinary: 'Artium',
        processId: 2898,
      },
      {
        index: 1448,
        sink: 169,
        ownerModule: 536870917,
        applicationName: null,
        processBinary: null,
        processId: null,
      },
    ]);
  });
});

describe('isOwnApplication', () => {
  it('matches by binary name or application name', () => {
    expect(isOwnApplication(sinkInput({ processBinary: 'Artium' }), identity)).toBe(true);
    expect(isOwnApplication(sinkInput({ processBinary: 'electron' }), identity)).toBe(true);
    expect(isOwnApplication(sinkInput({ applicationName: 'Artium' }), identity)).toBe(true);
  });

  it('rejects unrelated applications', () => {
    expect(isOwnApplication(sinkInput({ processBinary: 'firefox', applicationName: 'Firefox' }), identity)).toBe(false);
    expect(isOwnApplication(sinkInput({}), identity)).toBe(false);
  });
});

describe('resolveAppOutputSink', () => {
  const sinks = [{ index: 10, name: 'headphones' }, { index: 11, name: 'speakers' }];

  it('reads the sink the app is currently playing to', () => {
    const inputs = [
      sinkInput({ index: 1, sink: 11, ownerModule: 7 }),
      sinkInput({ index: 2, sink: 10, processBinary: 'Artium' }),
    ];
    expect(resolveAppOutputSink(inputs, sinks, identity, 'speakers')).toBe('headphones');
  });

  it('falls back when the app has no live playback stream', () => {
    const inputs = [sinkInput({ index: 1, sink: 11, processBinary: 'firefox' })];
    expect(resolveAppOutputSink(inputs, sinks, identity, 'speakers')).toBe('speakers');
  });
});

describe('planSinkMoves', () => {
  const opts = { nullSinkIndex: 20, appOutputSink: 'speakers', identity };

  it('moves Artium off the captured sink and other apps onto it', () => {
    const inputs = [
      sinkInput({ index: 1, sink: 20, processBinary: 'Artium' }), // ours, captured → out
      sinkInput({ index: 2, sink: 11, processBinary: 'Artium' }), // ours, already out
      sinkInput({ index: 3, sink: 11, processBinary: 'firefox' }),   // other, not captured → in
      sinkInput({ index: 4, sink: 20, processBinary: 'firefox' }),   // other, already captured
      sinkInput({ index: 5, sink: 11, ownerModule: 536870917 }),     // module stream → untouched
    ];
    expect(planSinkMoves(inputs, opts)).toEqual([
      { index: 1, targetSink: 'speakers' },
      { index: 3, targetSink: AUDIO_ISOLATION_SINK_NAME },
    ]);
  });
});

describe('reconcileRelease', () => {
  it('keeps the isolation while a capture is open, resetting the miss count', () => {
    expect(reconcileRelease(2, 1, 3)).toEqual({ missingTicks: 0, release: false });
  });

  it('releases only after the configured number of empty ticks', () => {
    expect(reconcileRelease(0, 0, 3)).toEqual({ missingTicks: 1, release: false });
    expect(reconcileRelease(1, 0, 3)).toEqual({ missingTicks: 2, release: false });
    expect(reconcileRelease(2, 0, 3)).toEqual({ missingTicks: 3, release: true });
  });
});
