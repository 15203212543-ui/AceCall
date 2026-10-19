const assert = require('node:assert/strict');
const { getMokaConfig, mokaConnectionStatus, maskSecret } = require('./moka-client');

assert.deepEqual(getMokaConfig({}), {
  apiKey: '', baseUrl: '', enterpriseId: '', apiKeyHeader: 'Authorization', authMode: 'basic', apiKeyPrefix: '', interviewsPath: '/api-platform/v1/interviews', projectName: 'QS'
  , jobsPath: '/api-platform/v1/jobs', requisitionsPath: '/api-platform/v1/requisitions', applicationsPath: '/api-platform/v1/applications', interviewInformationPath: '/api-platform/v1/interview/interview-information', interviewInfosV3Path: '/api-platform/v3/getInterviewInfos', jobNames: ['法务BP', '交易产品经理', '清结算产品经理', '行情产品经理', '账户产品经理', '数据分析师', '券商服务端开发工程师（长沙）', '结算专员', '券商客服主管', '证券设计师', '证券运维工程师', '券商测试工程师', '券商业务后端开发工程师']
});
assert.equal(mokaConnectionStatus({ MOKA_BASE_URL: 'https://example.test/', MOKA_API_KEY: '1234567890' }).configured, true);
assert.equal(mokaConnectionStatus({ MOKA_BASE_URL: 'https://example.test/' }).configured, false);
assert.equal(maskSecret('1234567890'), '1234****7890');
console.log('moka-client tests passed');
