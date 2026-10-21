// CloudBase's document.set() rejects payloads containing `_id` with
// INVALID_PARAM. Because that error carries no statusCode, the cloud function
// reported a generic 500 and the recording upload appeared to fail for no
// reason. These tests pin the stripping behaviour so it cannot regress.
const test = require('node:test');
const assert = require('node:assert/strict');
const { persistable, claimTask, updateTask, configureDependencies } = require('../worker');

function createRecordingDatabase() {
  const writes = [];
  return {
    writes,
    collection() {
      return {
        doc(id) {
          return {
            async set(document) {
              // Mirror the SDK guard so a regression fails loudly here instead
              // of only in production.
              if (Object.prototype.hasOwnProperty.call(document, '_id')) {
                const error = new Error('不能更新_id的值');
                error.code = 'INVALID_PARAM';
                throw error;
              }
              writes.push({ id, document });
              return { updated: 1 };
            }
          };
        }
      };
    }
  };
}

test('persistable removes _id and _openid but keeps application fields', () => {
  const stored = persistable({
    _id: 'abc123',
    _openid: 'openid-1',
    id: 'tr_1',
    tenantId: 'tenant_a',
    status: 'queued',
    parts: [{ index: 0 }]
  });
  assert.deepEqual(Object.keys(stored).sort(), ['id', 'parts', 'status', 'tenantId']);
  assert.equal(stored.id, 'tr_1');
  assert.equal(stored._id, undefined);
  assert.equal(stored._openid, undefined);
});

test('persistable tolerates empty and undefined input', () => {
  assert.deepEqual(persistable(), {});
  assert.deepEqual(persistable(null), {});
  assert.deepEqual(persistable({ _id: 'x' }), {});
});

test('claimTask writes back a document read from the database without _id', async () => {
  const db = createRecordingDatabase();
  configureDependencies({ database: () => db, storage: () => ({}) });
  try {
    // This is exactly what the worker receives from .where({status:'queued'}).get()
    const taskFromQuery = { _id: 'doc-abc', _openid: 'oid-1', id: 'tr_1', tenantId: 'tenant_a', status: 'queued', parts: [] };
    const claimed = await claimTask(taskFromQuery);
    assert.equal(claimed.status, 'transcribing');
    assert.equal(db.writes.length, 1, '认领必须成功写入，而不是抛出 INVALID_PARAM');
    assert.equal(db.writes[0].document._id, undefined);
    assert.equal(db.writes[0].document.status, 'transcribing');
  } finally {
    configureDependencies(null);
  }
});

test('updateTask writes status patches without _id', async () => {
  const db = createRecordingDatabase();
  configureDependencies({ database: () => db, storage: () => ({}) });
  try {
    const taskFromQuery = { _id: 'doc-abc', id: 'tr_1', tenantId: 'tenant_a', status: 'transcribing' };
    await updateTask(taskFromQuery, { status: 'completed', result: { text: '内容' } });
    assert.equal(db.writes.length, 1);
    assert.equal(db.writes[0].document._id, undefined);
    assert.equal(db.writes[0].document.status, 'completed');
    assert.equal(db.writes[0].document.result.text, '内容');
  } finally {
    configureDependencies(null);
  }
});

test('a raw set with _id still throws, proving the fixture catches regressions', async () => {
  const db = createRecordingDatabase();
  const doc = db.collection('x').doc('y');
  await assert.rejects(() => doc.set({ _id: 'abc', id: 'y' }), /不能更新_id的值/);
});
