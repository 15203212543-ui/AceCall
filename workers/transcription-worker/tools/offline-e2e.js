#!/usr/bin/env node
/**
 * 离线端到端验证：不连 CloudBase，跑通 worker 的完整转写链路。
 *
 *   node tools/offline-e2e.js <音频文件> [--segment 600]
 *
 * 它会用本地临时目录假装成对象存储，把音频切成模拟的“分片”，然后走
 *   downloadParts → probeDuration → prepareAudio → uploadSlice → provider.transcribe
 *   → mergeSliceResults
 * 全流程，最后打印转写文本、时间轴和耗时。
 *
 * 需要：
 *   - ASR 服务已启动（workers/faster-whisper-service），或任意 OpenAI 兼容端点
 *   - ffmpeg / ffprobe 可用（FFMPEG_PATH / FFPROBE_PATH 可覆盖）
 *
 * 这个脚本只用于本地联调，不参与生产运行。
 */
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createServer } = require('node:http');
const { createReadStream } = require('node:fs');

const worker = require('../worker');

const AUDIO = process.argv[2];
if (!AUDIO) {
  console.error('用法: node tools/offline-e2e.js <音频文件> [--segment 600] [--provider whisper]');
  process.exit(1);
}
const flag = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const SEGMENT = flag('segment');
if (SEGMENT) process.env.TRANSCRIPTION_SEGMENT_SECONDS = SEGMENT;
const PROVIDER = flag('provider') || process.env.TRANSCRIPTION_PROVIDER || 'whisper';

/**
 * Minimal static file server standing in for CloudBase Storage: the worker calls
 * getTempFileURL(), gets one of these URLs back, and downloads the "part".
 */
function startFileServer(directory) {
  const server = createServer(async (request, response) => {
    const name = decodeURIComponent((request.url || '/').split('?')[0].replace(/^\/+/, ''));
    const target = path.join(directory, name);
    try {
      const stat = await fs.stat(target);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Fake CloudBase document store: records every write so we can inspect the result. */
function createFakeDatabase() {
  const writes = [];
  return {
    writes,
    collection(name) {
      return {
        doc(id) {
          return {
            async set(document) {
              writes.push({ collection: name, id, document });
              return { updated: 1 };
            },
            async get() {
              return { data: writes.filter(item => item.id === id).at(-1)?.document || null };
            }
          };
        },
        where() {
          return {
            limit() {
              return { async get() { return { data: [] }; } };
            }
          };
        }
      };
    }
  };
}

function createFakeStorage(port, directory) {
  const uploads = [];
  // fileID -> real local filename, so getTempFileURL points at a file that exists.
  const fileIdToName = new Map();
  return {
    uploads,
    async getTempFileURL({ fileList }) {
      return {
        fileList: fileList.map(item => {
          const name = fileIdToName.get(item.fileID) || path.basename(item.fileID);
          return {
            fileID: item.fileID,
            code: 'SUCCESS',
            tempFileURL: `http://127.0.0.1:${port}/${encodeURIComponent(name)}`
          };
        })
      };
    },
    async uploadFile({ cloudPath, fileContent }) {
      const name = `uploaded-${String(uploads.length).padStart(5, '0')}${path.extname(cloudPath) || '.bin'}`;
      await fs.writeFile(path.join(directory, name), fileContent);
      const fileID = `fake://${cloudPath}`;
      fileIdToName.set(fileID, name);
      uploads.push({ cloudPath, bytes: fileContent.length, name });
      return { fileID };
    }
  };
}

(async () => {
  const started = Date.now();
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acecall-e2e-'));

  // Split the source into "parts" to mimic the browser's 8 MB chunked upload.
  const buffer = await fs.readFile(AUDIO);
  const partSize = Number(process.env.E2E_PART_BYTES || 4 * 1024 * 1024);
  const parts = [];
  for (let offset = 0, index = 0; offset < buffer.length; offset += partSize, index += 1) {
    const name = `part-${String(index).padStart(5, '0')}${path.extname(AUDIO)}`;
    const slice = buffer.subarray(offset, offset + partSize);
    await fs.writeFile(path.join(storageDir, name), slice);
    parts.push({ index, path: name, fileId: `fake://${name}`, size: slice.length });
  }
  console.log(`源文件   ${path.basename(AUDIO)}  ${(buffer.length / 1024 / 1024).toFixed(1)} MB  →  ${parts.length} 个分片`);

  const { server, port } = await startFileServer(storageDir);
  const fakeDb = createFakeDatabase();
  const fakeStorage = createFakeStorage(port, storageDir);
  worker.configureDependencies({ database: () => fakeDb, storage: () => fakeStorage });

  const task = {
    id: 'offline-e2e',
    tenantId: 'offline',
    candidateId: 'offline-candidate',
    fileName: path.basename(AUDIO),
    mimeType: 'audio/wav',
    engine: PROVIDER,
    status: 'queued',
    parts,
    storagePrefix: 'offline/e2e',
    result: {}
  };

  console.log(`引擎     ${PROVIDER}`);
  console.log(`切段     ${process.env.TRANSCRIPTION_SEGMENT_SECONDS ? process.env.TRANSCRIPTION_SEGMENT_SECONDS + ' 秒（显式指定）' : '自动（超 900 秒才切）'}`);
  console.log('');

  try {
    await worker.processTask(task);
  } finally {
    server.close();
  }

  const finalWrite = fakeDb.writes.at(-1)?.document || {};
  const result = finalWrite.result || {};
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('─'.repeat(64));
  console.log(`状态       ${finalWrite.status}`);
  if (finalWrite.error) console.log(`错误       ${finalWrite.error}`);
  console.log(`时长       ${Number(result.duration || 0).toFixed(1)} 秒`);
  console.log(`字数       ${result.characters || 0}`);
  console.log(`分片转写   ${result.segmentCount || 0} 次`);
  console.log(`时间轴段数 ${(result.segments || []).length}`);
  console.log(`总耗时     ${elapsed} 秒`);
  console.log(`上传切片   ${fakeStorage.uploads.length} 个  (${fakeStorage.uploads.map(item => (item.bytes / 1024).toFixed(0) + 'KB').join(', ')})`);
  console.log('─'.repeat(64));
  if (result.text) {
    console.log('转写文本:');
    console.log(result.text.slice(0, 1200) + (result.text.length > 1200 ? '\n…（已截断）' : ''));
  }
  if (result.segments?.length) {
    console.log('');
    console.log('前 5 段时间轴:');
    result.segments.slice(0, 5).forEach(item => {
      console.log(`  ${String(item.start).padStart(8)}s → ${String(item.end).padStart(8)}s  ${item.text.slice(0, 60)}`);
    });
    const last = result.segments.at(-1);
    console.log(`  最后一段 ${last.start}s → ${last.end}s  ${last.text.slice(0, 60)}`);
  }

  await fs.rm(storageDir, { recursive: true, force: true });
  process.exit(finalWrite.status === 'completed' ? 0 : 1);
})().catch(error => {
  console.error('端到端验证失败:', error.message);
  process.exit(1);
});
