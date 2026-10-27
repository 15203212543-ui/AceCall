(() => {
  const icons = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    folder: '<path d="M3 7h7l2-2h9v14H3z"/><path d="M3 9h18"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-4 2.5-6 5.5-6s5 2 5.5 6"/><circle cx="17" cy="9" r="2.3"/><path d="M15.5 14c2.8 0 4.6 1.6 5 4.5"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    building: '<path d="M4 21V5l8-3v19M12 8h8v13M7 7h2M7 11h2M7 15h2M15 11h2M15 15h2M2 21h20"/>',
    structure: '<path d="M12 4v5M6 20v-5M18 20v-5M6 15h12M6 15V9h12v6"/><circle cx="12" cy="3" r="1.5"/><circle cx="6" cy="21" r="1.5"/><circle cx="18" cy="21" r="1.5"/>',
    skill: '<path d="m12 2 2.2 5.8L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-2.2z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
    risk: '<path d="M12 2.5 20 6v5.5c0 5-3.2 8.2-8 10-4.8-1.8-8-5-8-10V6z"/><path d="M12 7v6M12 17h.01"/>',
    trend: '<path d="m3 17 6-6 4 4 8-9"/><path d="M15 6h6v6"/>',
    message: '<path d="M4 4h16v12H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    sync: '<path d="M20 7h-6V1M4 17h6v6"/><path d="M19 12a7 7 0 0 0-12-5l-3 3M5 12a7 7 0 0 0 12 5l3-3"/>',
    rules: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h7M15 18h5"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="13" cy="18" r="2"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 6-7"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>'
  };
  const pages = {
    '招聘工作台': ['dashboard', 'blue'], '简历中心': ['file', 'blue'], '候选人': ['users', 'cyan'], '岗位': ['building', 'violet'],
    '内部人才分析': ['structure', 'violet'], '人才市场洞察': ['search', 'blue'], '招聘分析': ['chart', 'cyan'],
    '面试官分析': ['message', 'green'], '行业情报': ['trend', 'amber'], '数据连接': ['sync', 'cyan'], '企业与团队': ['users', 'violet']
  };
  const sections = {
    '岗位推进': ['chart', 'blue'], '优先处理': ['risk', 'amber'], '人才池结构': ['structure', 'violet'], '招聘漏斗': ['filter', 'cyan'],
    '文件处理队列': ['file', 'blue'], '文件来源': ['folder', 'cyan'], '导入批次': ['layers', 'violet'], '桌面同步助手': ['sync', 'green'],
    '团队规则库': ['rules', 'violet'], '人才总览': ['dashboard', 'blue'], '人才结构分析': ['structure', 'violet'],
    '能力与人才缺口': ['skill', 'green'], '稀缺技能与能力缺口': ['skill', 'green'], '人才流动与风险': ['risk', 'amber'],
    '人才流动与重点发现': ['trend', 'amber'], '人才明细': ['users', 'cyan'], '外部人才搜索': ['search', 'green'],
    '竞品公司人才分布': ['building', 'violet'], '岗位招聘分析': ['chart', 'blue'], '岗位招聘表现': ['chart', 'blue'],
    '职位类别对比': ['structure', 'violet'], '个人筛选偏好': ['filter', 'violet'], '面试官筛选偏好': ['filter', 'violet'],
    '面试量趋势': ['trend', 'blue'], '面试问题与偏好': ['message', 'cyan'], '面试官阶段评分': ['target', 'green'],
    '面试转写记录': ['file', 'blue'], '面试转写复盘': ['file', 'blue'], '团队面试官对比': ['users', 'violet'],
    '筛选规则': ['rules', 'violet'], '自动筛选策略': ['target', 'green'], '企业列表': ['building', 'blue'],
    '近期公司动态': ['trend', 'amber'], '当前企业工作区': ['building', 'blue'], '团队成员': ['users', 'cyan'],
    '邀请团队成员': ['users', 'green'], 'AI与数据服务': ['sync', 'violet'], '人工决策边界': ['lock', 'amber'],
    '候选人摘要': ['file', 'blue'], '岗位匹配': ['target', 'green'], '匹配与风险': ['risk', 'amber'],
    '本次核验问题': ['check', 'blue'], '电话记录': ['message', 'cyan'], '结论依据': ['check', 'green']
  };
  const metrics = {
    '已建立档案': ['file', 'blue'], '解析中': ['sync', 'cyan'], '待岗位确认': ['target', 'amber'], '重复待确认': ['layers', 'violet'], '解析异常': ['risk', 'red'],
    '人才总量': ['users', 'blue'], '员工总数': ['users', 'blue'], '核心人才': ['target', 'violet'], '高潜人才': ['skill', 'green'],
    '关键岗位覆盖率': ['building', 'cyan'], '人才流失率': ['trend', 'red'], '高风险人才': ['risk', 'amber'],
    '高匹配人才量': ['target', 'green'], '人才活跃度': ['trend', 'cyan'], '市场趋势': ['trend', 'violet'],
    '已完成面试': ['check', 'blue'], '推进人选': ['trend', 'green'], '追问信号': ['message', 'amber'], '转写记录': ['file', 'cyan'],
    '筛选规则': ['rules', 'violet'], '评价完成率': ['check', 'green'], '平均面试时长': ['clock', 'cyan'],
    '面试通过率': ['target', 'green'], 'Offer 接受率': ['check', 'violet'], '已入职': ['users', 'blue']
  };
  const icon = (name, tone, className) => `<span class="${className} tone-${tone}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.dashboard}</svg></span>`;
  function decorate(root = document) {
    root.querySelectorAll?.('.page-title h1').forEach(heading => {
      const config = pages[heading.textContent.trim()];
      if (!config || heading.dataset.visualIcon) return;
      heading.dataset.visualIcon = 'true'; heading.classList.add('page-title-with-icon');
      heading.insertAdjacentHTML('afterbegin', icon(config[0], config[1], 'page-title-icon'));
    });
    root.querySelectorAll?.('.surface-head h2, .job-analytics-grid h3, .candidate-list-head h3').forEach(heading => {
      const config = sections[heading.textContent.trim()];
      if (!config || heading.dataset.visualIcon) return;
      heading.dataset.visualIcon = 'true'; heading.classList.add('section-title-with-icon');
      heading.insertAdjacentHTML('afterbegin', icon(config[0], config[1], 'section-icon'));
    });
    root.querySelectorAll?.('.metric').forEach(metric => {
      if (metric.dataset.visualIcon) return;
      const label = [...metric.children].find(child => child.tagName === 'SPAN')?.textContent.trim();
      const config = metrics[label];
      if (!config) return;
      metric.dataset.visualIcon = 'true'; metric.classList.add('visual-metric');
      metric.insertAdjacentHTML('afterbegin', icon(config[0], config[1], 'metric-visual-icon'));
    });
  }
  function start() {
    decorate(document);
    new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) decorate(node);
    }))).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
