export function captureSourceLabel(item = {}) {
  if (item.ingestSource === 'folder-watch') return '文件夹监听';
  if (item.ingestSource === 'folder') return '文件夹导入';
  if (item.ingestSource === 'manual') return '手动导入';
  if (item.resumeMeta?.source === 'local-sync-agent') return '桌面同步';
  if (item.ingestSource) return '简历导入';
  return '';
}

function personName(record, fallback = '账号未记录') {
  return String(record?.name || record?.email || fallback);
}

export function historyEvents(item = {}) {
  const events = [];
  const hasResume = Boolean(item.resume || item.resumeSummary || item.resumeMeta?.fileName || item.capturedAt || item.ingestStatus);
  if (hasResume) {
    const source = captureSourceLabel(item);
    events.push({
      at: item.capturedAt || item.createdAt || '',
      title: '简历抓取上传',
      detail: [personName(item.capturedBy), source].filter(Boolean).join(' · ')
    });
  } else if (item.createdAt) {
    events.push({ at: item.createdAt, title: '建立候选人档案', detail: '' });
  }
  if (item.jobId && item.assignedAt) {
    events.push({
      at: item.assignedAt,
      title: item.assignmentSource === 'manual-confirmation' ? '人工确认岗位' : '自动分配岗位',
      detail: item.roleName || ''
    });
  }
  if (item.preparation || item.hasPreparation) events.push({ at: item.createdAt || '', title: 'AI完成电话准备', detail: '' });
  if (item.communicationSummary || item.hasSummary) events.push({ at: item.updatedAt || '', title: '生成沟通总结', detail: '' });
  if (item.report || item.hasReport) events.push({ at: item.updatedAt || '', title: '生成综合初筛结果', detail: '' });
  if (item.report?.reviewConfirmed || item.reviewConfirmed) events.push({ at: item.updatedAt || '', title: '招聘人员确认结果', detail: item.mokaSync?.operatorName || '' });
  if (item.mokaSync?.status && item.mokaSync.status !== '草稿') {
    events.push({
      at: item.mokaSync.syncedAt || item.updatedAt || '',
      title: '同步 Moka',
      detail: [item.mokaSync.operatorName || '账号未记录', item.mokaSync.status].filter(Boolean).join(' · ')
    });
  }
  return events;
}
