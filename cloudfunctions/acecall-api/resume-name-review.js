const { isPlausibleCandidateName } = require('./resume-text');

const COMPOUND_SURNAMES = ['欧阳', '太史', '端木', '上官', '司马', '东方', '独孤', '南宫', '万俟', '闻人', '夏侯', '诸葛', '尉迟', '公羊', '赫连', '澹台', '皇甫', '宗政', '濮阳', '公冶', '太叔', '申屠', '公孙', '慕容', '仲孙', '钟离', '长孙', '宇文', '司徒', '鲜于', '司空', '闾丘', '子车', '亓官', '司寇', '巫马', '公西', '颛孙', '壤驷', '公良', '漆雕', '乐正', '宰父', '谷梁', '拓跋', '夹谷', '轩辕', '令狐', '段干', '百里', '呼延', '东郭', '南门', '羊舌', '微生', '梁丘', '左丘', '西门', '第五', '淳于', '单于', '归海'];
const SINGLE_SURNAMES = new Set('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公代肖闫付区朴覃欧'.split(''));

function splitChineseName(value = '') {
  const name = String(value || '').trim();
  if (!/^[\u4e00-\u9fff]{2,4}$/.test(name)) return null;
  const compound = COMPOUND_SURNAMES.find(item => name.startsWith(item));
  const surname = compound || name.slice(0, 1);
  if (!compound && !SINGLE_SURNAMES.has(surname)) return null;
  const given = name.slice(surname.length);
  if (/^(先生|女士|小姐)$/.test(given)) return { surname, given, titled: true };
  if (!/^[\u4e00-\u9fff]{1,2}$/.test(given)) return null;
  return { surname, given, titled: false };
}

function isReasonableEnglishName(value = '') {
  const name = String(value || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every(part => /^[A-Z][a-z'-]{1,20}$/.test(part));
}

function localNameReason(value = '') {
  const name = String(value || '').trim();
  if (!isPlausibleCandidateName(name)) return { reasonable: false, titled: false };
  const chinese = splitChineseName(name);
  if (chinese) return { reasonable: true, titled: chinese.titled };
  if (isReasonableEnglishName(name)) return { reasonable: true, titled: false };
  return { reasonable: false, titled: false };
}

function nameReviewPrompt(name = '') {
  return {
    instructions: '你只判断一个字符串是否是合理的人名。中文姓名必须姓氏在前，姓氏应是真实存在的中文姓氏，可以是单姓或复姓，名字通常是 1 到 2 个字。栏目名称、技能、城市、学校、公司、岗位、学历都不是人名。英文需要像真实姓名。只返回 JSON：{"reasonable":true} 或 {"reasonable":false}。',
    input: String(name || '').trim().slice(0, 40)
  };
}

function confidenceStatus(item, ranked) {
  const next = ranked.find(other => other.value !== item.value);
  return item.confidence >= 0.9 && (!next || item.confidence - next.confidence >= 0.15) ? '已识别' : '待确认';
}

function reviewedName(item, status, review) {
  return { candidateName: item?.value || '', candidateNameSource: item?.source || '', candidateNameStatus: status, candidateNameReview: review };
}

async function selectReasonableName(ranked = [], confirm = null) {
  let modelCalls = 0;
  for (const item of ranked) {
    const local = localNameReason(item.value);
    if (!local.reasonable) continue;
    if (local.titled || typeof confirm !== 'function') return reviewedName(item, local.titled ? '待确认' : confidenceStatus(item, ranked), local.titled ? 'title' : 'surname');
    if (modelCalls >= 2) return reviewedName(item, '待确认', 'surname');
    modelCalls += 1;
    try {
      const reasonable = await confirm(item.value);
      if (reasonable === true) return reviewedName(item, confidenceStatus(item, ranked), 'model');
      if (reasonable === false) continue;
    } catch {
      return reviewedName(item, '待确认', 'surname');
    }
  }
  return reviewedName(null, '待确认', 'rejected');
}

module.exports = { splitChineseName, localNameReason, nameReviewPrompt, selectReasonableName };
