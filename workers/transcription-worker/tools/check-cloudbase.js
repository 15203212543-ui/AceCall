#!/usr/bin/env node
/**
 * 检查 CloudBase 凭证与转写队列状态。
 *
 *   node tools/check-cloudbase.js            只验证凭证并列出最近任务
 *   node tools/check-cloudbase.js <taskId>   查看指定任务的完整状态
 *
 * 凭证从项目根目录的 start-worker.bat 读取，不把密钥写进代码。
 * 这个脚本用于排查「worker 一直不干活」这类问题：先确认密钥能读库，
 * 再看队列里有没有 queued 任务、任务卡在哪个状态。
 */
const fs = require('node:fs');
const path = require('node:path');

function readBat(file) {
  const candidates = [
    path.join(__dirname, '..', '..', '..', '..', 'start-worker.bat'),
    path.join(process.cwd(), 'start-worker.bat')
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) {
    console.error('找不到 start-worker.bat，请在项目根目录或 worker 目录下运行');
    process.exit(1);
  }
  const text = fs.readFileSync(found, 'utf8');
  const read = name => {
    const m = text.match(new RegExp(`set "${name}=([^"]*)"`));
    return m ? m[1] : '';
  };
  return { env: read('TCB_ENV'), secretId: read('CLOUDBASE_SECRET_ID'), secretKey: read('CLOUDBASE_SECRET_KEY') };
}

const credentials = readBat();
if (!credentials.secretId || !credentials.secretKey) {
  console.error('start-worker.bat 里 SecretId / SecretKey 还没有填');
  process.exit(1);
}

const tcb = require('@cloudbase/node-sdk');
const app = tcb.init({
  env: credentials.env,
  secretId: credentials.secretId,
  secretKey: credentials.secretKey
});

const targetId = process.argv[2];

(async () => {
  const db = app.database();

  console.log('环境      :', credentials.env);
  console.log('SecretId  :', credentials.secretId.slice(0, 10) + '…' + credentials.secretId.slice(-4));
  console.log('SecretKey : 长度', credentials.secretKey.length);
  console.log('');

  if (targetId) {
    const r = await db.collection('acecall_transcription_tasks').where({ id: targetId }).get();
    const rows = r.data || [];
    if (!rows.length) {
      console.log('没有找到任务', targetId);
      return;
    }
    for (const t of rows) {
      console.log('===================================');
      console.log('_id      :', t._id);
      console.log('id       :', t.id);
      console.log('status   :', t.status);
      console.log('engine   :', t.engine);
      console.log('分片数   :', (t.parts || []).length);
      console.log('时长     :', t.durationSeconds, '秒');
      console.log('字数     :', (t.result?.text || '').length);
      console.log('错误     :', t.error || '(无)');
      console.log('更新时间 :', t.updatedAt);
      if (t.result?.text) {
        console.log('--- 文本（前 300 字）---');
        console.log(t.result.text.slice(0, 300));
      }
    }
    return;
  }

  const r = await db.collection('acecall_transcription_tasks').orderBy('createdAt', 'desc').limit(10).get();
  const rows = r.data || [];
  console.log('✅ 凭证有效，最近 10 条任务：');
  if (!rows.length) {
    console.log('  （集合为空，还没有录音）');
    return;
  }
  for (const t of rows) {
    const text = t.result?.text || '';
    const bits = [
      String(t.id).slice(0, 22).padEnd(24),
      String(t.status).padEnd(12),
      `engine=${String(t.engine).padEnd(10)}`,
      `分片=${(t.parts || []).length}`,
      `字数=${text.length}`
    ];
    console.log('  ' + bits.join(' '));
    if (t.error) console.log('      错误:', String(t.error).slice(0, 120));
  }

  const pending = rows.filter(t => t.status === 'queued').length;
  console.log('');
  if (pending) {
    console.log(`有 ${pending} 条任务等待处理。如果 worker 在运行却不动，检查它的窗口输出。`);
  } else {
    console.log('没有排队任务。录一段新的音来验证链路。');
  }
})().catch(error => {
  console.error('❌ 连接失败:', error.code || '', (error.message || '').slice(0, 300));
  if (/signature|AuthFailure|InvalidSecret/i.test((error.message || '') + (error.code || ''))) {
    console.error('→ SecretKey 可能不正确（签名校验失败）');
  } else if (/permission|ResourceNotFound|NOT_FOUND/i.test((error.message || '') + (error.code || ''))) {
    console.error('→ 密钥可用，但没有这个环境或集合的权限');
  }
  process.exit(1);
});
