#!/usr/bin/env node
/**
 * 渲染层与发信层的快照测试。
 *
 * Apps Script 没有本地运行时，所以这里把 SpreadsheetApp / GmailApp / ScriptApp
 * 等全局对象打桩，再把 src/Code.gs 整个求值进一个函数作用域里跑。
 * 这样多城市的分区、空状态、订阅路由这些逻辑在部署到线上之前就能验证——
 * 之前这一层只能靠人工打开网页肉眼看（见 功能文档 §4.5）。
 *
 * 用法: node tests/render_test.js
 * 退出码: 0 全过 / 1 有失败
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HEADER = ['City','WeekId','Zone','SubGroup','Category','Title','DateInfo',
                'Location','Status','PriceInfo','MapLink','Note','Pick'];

function row(o) { return HEADER.map(h => o[h] === undefined ? '' : o[h]); }

// ---- 测试夹具：两个城市、三期数据 ----
const FIXTURE = [
  HEADER,
  row({City:'三藩市湾区', WeekId:'2026-08-26', Zone:'三藩市市内', SubGroup:'吃',
       Category:'吃', Title:'上期旧店', DateInfo:'08.26', Location:'SF', Status:'已核实'}),
  row({City:'三藩市湾区', WeekId:'2026-09-02', Zone:'三藩市市内', SubGroup:'吃',
       Category:'吃', Title:'SF 精选餐厅', DateInfo:'09.09 开业', Location:'185 Berry St',
       Status:'场地已核实', PriceInfo:'免费', MapLink:'https://www.google.com/maps/search/?api=1&query=x',
       Note:'信源A', Pick:'★'}),
  row({City:'三藩市湾区', WeekId:'2026-09-02', Zone:'湾区市外', SubGroup:'玩·Oakland',
       Category:'集市', Title:'SF 市外活动', DateInfo:'09.04', Location:'Oakland', Status:'已核实'}),
  row({City:'香港', WeekId:'2026-09-02', Zone:'港岛', SubGroup:'展',
       Category:'展', Title:'HK 港岛展览', DateInfo:'09.05', Location:'中环', Status:'已核实', Pick:'★'}),
  row({City:'香港', WeekId:'2026-09-02', Zone:'新界', SubGroup:'玩',
       Category:'玩', Title:'HK 新界活动', DateInfo:'09.06', Location:'沙田', Status:'未核实'}),
];

// ---- 打桩 ----
function makeApp(sheetValues) {
  const sentMail = [];
  const logged = [];
  const stubs = {
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: () => ({ getDataRange: () => ({ getValues: () => sheetValues }) }) })
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://stub/exec' }) },
    HtmlService: {
      createHtmlOutput: (html) => {
        const o = { html, title: null };
        o.setTitle = (t) => { o.title = t; return o; };
        o.addMetaTag = () => o;
        return o;
      }
    },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
    Session: { getScriptTimeZone: () => 'America/Los_Angeles' },
    GmailApp: { sendEmail: (to, subject, body, opts) => sentMail.push({ to, subject, body, opts }) },
    Logger: { log: (m) => logged.push(String(m)) },
  };
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
  const factory = new Function(...Object.keys(stubs),
    src + '\n; return { doGet, sendWeeklyEmail, previewWeeklyEmail, sendIssueTo_, CONFIG };');
  const app = factory(...Object.values(stubs));
  return { app, sentMail, logged };
}

// ---- 迷你断言 ----
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function contains(hay, needle, msg) {
  assert(hay.indexOf(needle) !== -1, (msg || '') + ' 期望包含: ' + needle);
}
function notContains(hay, needle, msg) {
  assert(hay.indexOf(needle) === -1, (msg || '') + ' 期望不包含: ' + needle);
}

console.log('\n=== 网页渲染 ===');
{
  const { app } = makeApp(FIXTURE);

  check('缺省参数 → 默认城市（配置里第一个），显示最新一期', () => {
    const out = app.doGet({});
    assert(out.title === '三藩市 & 湾区周报', '标题应为 SF 的 siteTitle，实际 ' + out.title);
    contains(out.html, 'SF 精选餐厅');
    notContains(out.html, '上期旧店', '不应显示上一期的内容');
    notContains(out.html, 'HK 港岛展览', '不应混入其他城市');
  });

  check('?city=hk → 切到香港，标题与分区都跟着换', () => {
    const out = app.doGet({ parameter: { city: 'hk' } });
    assert(out.title === '香港周报', '标题应为香港，实际 ' + out.title);
    contains(out.html, 'HK 港岛展览');
    contains(out.html, 'HK 新界活动');
    contains(out.html, '港岛');
    notContains(out.html, 'SF 精选餐厅', '不应混入三藩市内容');
    notContains(out.html, '湾区市外', '不应出现别的城市的分区名');
  });

  check('非法 city 参数 → 回落默认城市，不报错', () => {
    const out = app.doGet({ parameter: { city: 'nonexistent' } });
    assert(out.title === '三藩市 & 湾区周报');
    contains(out.html, 'SF 精选餐厅');
  });

  check('城市切换 tab 渲染正确，当前城市为 active', () => {
    const out = app.doGet({ parameter: { city: 'hk' } });
    contains(out.html, 'class="city-tab active" href="https://stub/exec?city=hk"');
    contains(out.html, '?city=sf');
  });

  check('往期链接带上 city，切城市不会串到别的城市的期次', () => {
    const out = app.doGet({});
    contains(out.html, '?city=sf&week=2026-08-26');
    notContains(out.html, 'href="https://stub/exec?week=', '旧的无 city 链接不该再出现');
  });

  check('往期列表按城市隔离：香港只有一期', () => {
    const out = app.doGet({ parameter: { city: 'hk' } });
    contains(out.html, '09.02 那一周');
    notContains(out.html, '08.26 那一周', '香港没有 08.26 那一期，不该出现');
  });

  check('?week 指定历史期次可正常回看', () => {
    const out = app.doGet({ parameter: { city: 'sf', week: '2026-08-26' } });
    contains(out.html, '上期旧店');
    notContains(out.html, 'SF 精选餐厅');
  });

  check('精选条目带金色高亮与徽章', () => {
    const out = app.doGet({});
    contains(out.html, 'ticket pick');
    contains(out.html, '给你挑的');
  });

  check('核实等级徽章按状态渲染', () => {
    const out = app.doGet({ parameter: { city: 'hk' } });
    contains(out.html, '未核实', '未核实的条目必须照常展示并标注');
  });
}

console.log('\n=== 空状态 ===');
{
  // 只有三藩市的数据，香港一条都没有
  const onlySF = FIXTURE.filter((r, i) => i === 0 || r[0] === '三藩市湾区');
  const { app } = makeApp(onlySF);

  check('城市还没有任何一期 → 出空状态而不是白屏或空壳', () => {
    const out = app.doGet({ parameter: { city: 'hk' } });
    assert(out.title === '香港周报');
    contains(out.html, 'empty-state');
    contains(out.html, '香港还没有内容');
    contains(out.html, '城市');           // 城市 tab 仍在，用户能切回去
    contains(out.html, '?city=sf');
  });
}

console.log('\n=== 发信与订阅路由 ===');
{
  const { app, sentMail, logged } = makeApp(FIXTURE);
  app.sendWeeklyEmail();

  check('按城市各发一封，不把多城市混在一封里', () => {
    assert(sentMail.length === 2, '应发出 2 封（sf + hk），实际 ' + sentMail.length);
  });

  check('只订阅 sf 的读者收不到香港那封', () => {
    const sf = sentMail.filter(m => m.subject.indexOf('湾区') !== -1)[0];
    const hk = sentMail.filter(m => m.subject.indexOf('香港') !== -1)[0];
    assert(sf, '没有发出三藩市那封');
    assert(hk, '没有发出香港那封');
    contains(sf.to, 'reader-sf@example.com');
    contains(sf.to, 'reader-both@example.com');
    notContains(hk.to, 'reader-sf@example.com', '只订阅 sf 的人不该收到香港');
    contains(hk.to, 'reader-both@example.com');
  });

  check('三藩市的邮件主题保持原样，现有读者无感', () => {
    const sf = sentMail.filter(m => m.to.indexOf('reader-sf') !== -1)[0];
    assert(sf.subject === '这周的湾区，我给你留了几张票 · 09.02 那一周',
           '实际: ' + sf.subject);
  });

  check('邮件链接带 city 参数，点开直达对应城市', () => {
    const hk = sentMail.filter(m => m.subject.indexOf('香港') !== -1)[0];
    contains(hk.body, 'city=hk');
    contains(hk.body, 'week=2026-09-02');
  });

  check('邮件内容不含 emoji（非 BMP 字符过不了邮件头编码）', () => {
    sentMail.forEach(m => {
      const all = m.subject + m.body + (m.opts && m.opts.htmlBody || '');
      const bad = [...all].filter(c => c.codePointAt(0) > 0xFFFF);
      assert(bad.length === 0, '发现非 BMP 字符: ' + bad.join(','));
    });
  });

  check('精选条目在邮件里优先列出', () => {
    const sf = sentMail.filter(m => m.to.indexOf('reader-sf') !== -1)[0];
    const iPick = sf.body.indexOf('SF 精选餐厅');
    const iOther = sf.body.indexOf('SF 市外活动');
    assert(iPick !== -1 && iOther !== -1, '两条都应出现在邮件里');
    assert(iPick < iOther, '精选应排在前面');
  });
}

console.log('\n=== 不发空邮件 ===');
{
  const onlySF = FIXTURE.filter((r, i) => i === 0 || r[0] === '三藩市湾区');
  const { app, sentMail, logged } = makeApp(onlySF);
  app.sendWeeklyEmail();

  check('没有数据的城市不发信，只发有内容的那个', () => {
    assert(sentMail.length === 1, '应只发 1 封，实际 ' + sentMail.length);
    contains(sentMail[0].subject, '湾区');
  });

  check('sendIssueTo_ 对空城市返回 false', () => {
    const hk = app.CONFIG.CITIES.filter(c => c.slug === 'hk')[0];
    assert(app.sendIssueTo_('x@example.com', hk) === false);
  });
}

console.log('\n=== 配置自洽 ===');
{
  const { app } = makeApp(FIXTURE);
  const C = app.CONFIG;

  check('每个城市都有 slug / label / zones，且 slug 不重复', () => {
    const slugs = C.CITIES.map(c => c.slug);
    C.CITIES.forEach(c => {
      assert(c.slug && c.label && Array.isArray(c.zones) && c.zones.length,
             '城市配置不完整: ' + JSON.stringify(c));
    });
    assert(new Set(slugs).size === slugs.length, 'slug 有重复');
  });

  check('每个收件人订阅的城市都存在于 CITIES 里', () => {
    const slugs = C.CITIES.map(c => c.slug);
    (C.RECIPIENTS || []).forEach(r => {
      (r.cities || []).forEach(cs => {
        assert(slugs.indexOf(cs) !== -1, r.email + ' 订阅了不存在的城市: ' + cs);
      });
    });
  });

  check('SITE_URL 是 /exec 而不是 /dev', () => {
    assert(/\/exec$/.test(C.SITE_URL) || C.SITE_URL.indexOf('PASTE_YOUR') !== -1,
           'SITE_URL 必须以 /exec 结尾: ' + C.SITE_URL);
  });
}

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + '    失败 ' + fail);
process.exit(fail ? 1 : 0);
