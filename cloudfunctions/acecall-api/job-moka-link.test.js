const test = require('node:test');
const assert = require('node:assert/strict');
const { planMokaLinks } = require('./job-moka-link');

test('an unlinked job is matched only when one Moka job has the same name', () => {
  const links = planMokaLinks([
    { id: 'local-hr', name: '人力管培' },
    { id: 'local-server', name: '服务端开发（北京）' },
    { id: 'already', name: '法务BP', mokaJobId: 'moka-legal' }
  ], [
    { id: 'moka-hr', name: '人力管培' },
    { id: 'moka-server-a', name: '服务端开发(北京)' },
    { id: 'moka-server-b', name: '服务端开发(北京)' },
    { id: 'moka-legal', name: '法务BP' }
  ]);
  assert.deepEqual(links, [{ id: 'local-hr', name: '人力管培', mokaJobId: 'moka-hr' }]);
});
