const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSliceResults, probeDuration } = require('../worker');

test('offsets segment timestamps by the slice start time', () => {
  const merged = mergeSliceResults([
    {
      offsetSeconds: 0,
      result: { text: '第一段内容', duration: 900, segments: [{ start: 0, end: 10, text: '第一段内容' }] }
    },
    {
      offsetSeconds: 900,
      result: { text: '第二段内容', duration: 900, segments: [{ start: 0, end: 12, text: '第二段内容' }, { start: 30, end: 40, text: '继续' }] }
    }
  ]);
  assert.equal(merged.text, '第一段内容\n第二段内容');
  assert.deepEqual(
    merged.segments.map(item => item.start),
    [0, 900, 930]
  );
  assert.equal(merged.duration, 1800);
});

test('keeps absolute timestamps when a provider already reports them', () => {
  const merged = mergeSliceResults([
    { offsetSeconds: 0, result: { text: 'a', duration: 10, segments: [{ start: 5, end: 8, text: 'a' }] } }
  ]);
  assert.equal(merged.segments[0].start, 5);
});

test('skips blank slice text and preserves speaker labels', () => {
  const merged = mergeSliceResults([
    { offsetSeconds: 0, result: { text: '   ', segments: [{ start: 0, end: 1, text: '   ' }] } },
    { offsetSeconds: 600, result: { text: '有效内容', segments: [{ start: 1, end: 2, text: '有效内容', speaker: 'SPEAKER_01' }] } }
  ]);
  assert.equal(merged.text, '有效内容');
  assert.equal(merged.segments.length, 1);
  assert.equal(merged.segments[0].speaker, 'SPEAKER_01');
  assert.equal(merged.segments[0].start, 601);
});

test('tolerates slices without segments', () => {
  const merged = mergeSliceResults([{ offsetSeconds: 0, result: { text: '纯文本引擎' } }]);
  assert.equal(merged.text, '纯文本引擎');
  assert.deepEqual(merged.segments, []);
  assert.equal(merged.duration, 0);
});

test('probeDuration resolves 0 when the file is missing instead of throwing', async () => {
  const seconds = await probeDuration('definitely-not-a-real-file.wav');
  assert.equal(seconds, 0);
});
