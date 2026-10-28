const test = require('node:test');
const assert = require('node:assert/strict');
const { planMokaLinks } = require('./job-moka-link');

test('an unlinked job is matched only when one Moka job has the same name', () => {
  const links = planMokaLinks([
    { id: 'local-hr', name: '人力管培' },
    { id: 'local-server', name: '服务端开发（北京）' },
    { id: 'already', name: '法务BP', mokaJobId: 'moka-legal' }
  ], [
    { id: 'moka-hr', name: '人力管培', code: 'MJ005759' },
    { id: 'moka-server-a', name: '服务端开发(北京)' },
    { id: 'moka-server-b', name: '服务端开发(北京)' },
    { id: 'moka-legal', name: '法务BP' }
  ]);
  assert.deepEqual(links, [{ id: 'local-hr', name: '人力管培', mokaJobId: 'moka-hr', mokaJobCode: 'MJ005759' }]);
});

test('a Moka job already linked without hyphens is not linked again', () => {
  const links = planMokaLinks([
    { id: 'linked', name: '券商测试工程师', mokaJobId: 'aabbccddeeff00112233445566778899' },
    { id: 'extra', name: '券商测试工程师' }
  ], [
    { id: 'aabbccdd-eeff-0011-2233-445566778899', name: '券商测试工程师', code: 'MJ005714' }
  ]);
  assert.deepEqual(links, []);
});
