// 验证 prepareAudio 的切段与归一化行为。
// 需要 FFMPEG_PATH 指向可用的 ffmpeg；测试自己合成音频，不依赖外部素材。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { prepareAudio, mergeSliceResults } = require('../worker');

const FFMPEG = process.env.FFMPEG_PATH;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => (code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-400)}`))));
  });
}

// 65 秒 16 kHz 单声道正弦波：按 10 秒切段应得 7 片（最后一片 5 秒）。
async function makeSource(directory) {
  const target = path.join(directory, 'source.wav');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=65', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', target]);
  return target;
}

const skip = FFMPEG ? false : '需要 FFMPEG_PATH';

test('splits long audio into fixed-length slices with cumulative offsets', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-slice-'));
  const previous = process.env.TRANSCRIPTION_SEGMENT_SECONDS;
  process.env.TRANSCRIPTION_SEGMENT_SECONDS = '10';
  try {
    const source = await makeSource(dir);
    const prepared = await prepareAudio(source, dir, { normalize: false, duration: 65 });
    assert.equal(prepared.sliced, true);
    assert.equal(prepared.segmentSeconds, 10);
    assert.equal(prepared.slices.length, 7, '65s 音频按 10s 应切成 7 片');
    assert.deepEqual(prepared.slices.map(item => item.offsetSeconds), [0, 10, 20, 30, 40, 50, 60]);
    for (const slice of prepared.slices) {
      const stat = await fs.stat(slice.path);
      assert.ok(stat.size > 0, `${path.basename(slice.path)} 不应为空`);
    }
    const info = await runFfmpeg(['-hide_banner', '-i', prepared.slices[0].path, '-f', 'null', '-']);
    assert.match(info, /16000 Hz/);
    assert.match(info, /mono/);
  } finally {
    if (previous === undefined) delete process.env.TRANSCRIPTION_SEGMENT_SECONDS;
    else process.env.TRANSCRIPTION_SEGMENT_SECONDS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('auto-splits only when duration exceeds the configured threshold', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-auto-'));
  const previous = process.env.TRANSCRIPTION_SEGMENT_SECONDS;
  delete process.env.TRANSCRIPTION_SEGMENT_SECONDS;
  try {
    const source = await makeSource(dir);
    // Default threshold is 900s, so a 65s recording stays whole.
    const untouched = await prepareAudio(source, dir, { normalize: false, duration: 65 });
    assert.equal(untouched.sliced, false);
    assert.equal(untouched.slices.length, 1);
    assert.equal(untouched.slices[0].path, source, '未超阈值时应原样透传，不做多余转码');
  } finally {
    if (previous !== undefined) process.env.TRANSCRIPTION_SEGMENT_SECONDS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcodes to 16k mono when the provider demands WAV', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-norm-'));
  const previous = process.env.TRANSCRIPTION_SEGMENT_SECONDS;
  delete process.env.TRANSCRIPTION_SEGMENT_SECONDS;
  try {
    const source = await makeSource(dir);
    const prepared = await prepareAudio(source, dir, { normalize: true, duration: 65 });
    assert.equal(prepared.sliced, false);
    assert.equal(path.extname(prepared.slices[0].path), '.wav');
    assert.ok((await fs.stat(prepared.slices[0].path)).size > 0);
  } finally {
    if (previous !== undefined) process.env.TRANSCRIPTION_SEGMENT_SECONDS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('merging seven slices reproduces a monotonic global timeline', () => {
  const slices = [0, 10, 20, 30, 40, 50, 60].map(offset => ({
    offsetSeconds: offset,
    result: { text: `第${offset / 10 + 1}段`, duration: offset === 60 ? 5 : 10, segments: [{ start: 1, end: 8, text: `第${offset / 10 + 1}段` }] }
  }));
  const merged = mergeSliceResults(slices);
  assert.equal(merged.segments.length, 7);
  assert.deepEqual(merged.segments.map(item => item.start), [1, 11, 21, 31, 41, 51, 61]);
  assert.ok(merged.segments.every((item, index, list) => index === 0 || item.start > list[index - 1].start));
  assert.equal(merged.text.split('\n').length, 7);
});
