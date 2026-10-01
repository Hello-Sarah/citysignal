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
function makeApp(sheetValues, initialSentLog, http) {
  let sentLog = initialSentLog || null;   // null = SentLog 分頁還不存在
  const sentMail = [];
  const logged = [];
  const stubs = {
    SpreadsheetApp: {
      openById: () => ({
        getSpreadsheetTimeZone: () => 'America/Los_Angeles',
        getSheetByName: (name) => name === 'SentLog'
          ? (sentLog ? { getDataRange: () => ({ getValues: () => sentLog }), appendRow: (r) => sentLog.push(r) } : null)
          : {
              getDataRange: () => ({ getValues: () => sheetValues }),
              getLastRow: () => sheetValues.length,
              getLastColumn: () => sheetValues[0].length,
              getRange: (r, c, nr, nc) => ({
                getValues: () => sheetValues.slice(r - 1, r - 1 + nr).map(x => x.slice(c - 1, c - 1 + nc)),
                setValues: (rows) => { rows.forEach((row, i) => { sheetValues[r - 1 + i] = row; }); }
              })
            },
        insertSheet: () => { sentLog = []; return { getDataRange: () => ({ getValues: () => sentLog }), appendRow: (r) => sentLog.push(r) }; }
      })
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
    UrlFetchApp: {
      fetch: (url) => {
        const hit = (http || {})[url];
        return { getResponseCode: () => hit === undefined ? 404 : 200, getContentText: () => hit || '' };
      }
    },
    ContentService: {
      MimeType: { ICAL: 'text/calendar', TEXT: 'text/plain' },
      createTextOutput: (s) => {
        const o = { content: s, mime: null, file: null };
        o.setMimeType = (m) => { o.mime = m; return o; };
        o.downloadAsFile = (f) => { o.file = f; return o; };
        return o;
      }
    },
  };
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
  const factory = new Function(...Object.keys(stubs),
    src + '\n; return { doGet, sendWeeklyEmail, previewWeeklyEmail, sendIssueTo_, CONFIG, calendarEvent_, gcalUrl_, buildIcs_, icsFold_, importApprovedIssues_, importIssuesNow, nwsToDays_, translateNws_, hkoKind_, renderMedia_ };');
  const app = factory(...Object.values(stubs));
  return { app, sentMail, logged, getSentLog: () => sentLog };
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
    assert(out.title === '三藩市 & 灣區週報', '标题应为 SF 的 siteTitle，实际 ' + out.title);
    contains(out.html, 'SF 精选餐厅');
    notContains(out.html, '上期旧店', '不应显示上一期的内容');
    notContains(out.html, 'HK 港岛展览', '不应混入其他城市');
  });

  check('?city=hk → 切到香港，标题与分区都跟着换', () => {
    const out = app.doGet({ parameter: { city: 'hk' } });
    assert(out.title === '香港週報', '标题应为香港，实际 ' + out.title);
    contains(out.html, 'HK 港岛展览');
    contains(out.html, 'HK 新界活动');
    contains(out.html, '港島');
    notContains(out.html, 'SF 精选餐厅', '不应混入三藩市内容');
    notContains(out.html, '灣區市外', '不应出现别的城市的分区名');
  });

  check('非法 city 参数 → 回落默认城市，不报错', () => {
    const out = app.doGet({ parameter: { city: 'nonexistent' } });
    assert(out.title === '三藩市 & 灣區週報');
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
    contains(out.html, '09.02 那一週');
    notContains(out.html, '08.26 那一週', '香港没有 08.26 那一期，不该出现');
  });

  check('?week 指定历史期次可正常回看', () => {
    const out = app.doGet({ parameter: { city: 'sf', week: '2026-08-26' } });
    contains(out.html, '上期旧店');
    notContains(out.html, 'SF 精选餐厅');
  });

  check('站内链接走顶层窗口（base target=_top）', () => {
    // Apps Script 的沙盒 iframe 不允许在内部加载 script.google.com，
    // 少了这一行，点城市 tab 或往期链接会得到 "refused to connect"。
    const out = app.doGet({});
    contains(out.html, '<base target="_top">');
  });

  check('地图链接仍在新标签页打开，不被 base 影响', () => {
    const out = app.doGet({});
    contains(out.html, 'target="_blank"');
  });

  check('精选条目带金色高亮与徽章', () => {
    const out = app.doGet({});
    contains(out.html, 'ticket pick');
    contains(out.html, '給你挑的');
  });

  check('核实等级徽章按状态渲染', () => {
    const out = app.doGet({ parameter: { city: 'hk' } });
    contains(out.html, '未核實', '未核实的条目必须照常展示并标注');
  });
}

console.log('\n=== 空状态 ===');
{
  // 只有三藩市的数据，香港一条都没有
  const onlySF = FIXTURE.filter((r, i) => i === 0 || r[0] === '三藩市湾区');
  const { app } = makeApp(onlySF);

  check('城市还没有任何一期 → 出空状态而不是白屏或空壳', () => {
    const out = app.doGet({ parameter: { city: 'hk' } });
    assert(out.title === '香港週報');
    contains(out.html, 'empty-state');
    contains(out.html, '香港還沒有內容');
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
    const sf = sentMail.filter(m => m.subject.indexOf('灣區') !== -1)[0];
    const hk = sentMail.filter(m => m.subject.indexOf('香港') !== -1)[0];
    assert(sf, '没有发出三藩市那封');
    assert(hk, '没有发出香港那封');
    contains(sf.to, 'reader-sf@example.com');
    contains(sf.to, 'reader-both@example.com');
    notContains(hk.to, 'reader-sf@example.com', '只订阅 sf 的人不该收到香港');
    contains(hk.to, 'reader-both@example.com');
  });

  // 主题从简体改成了繁体，是一次有意的变更（读者是香港人），不是回归。
  // 锁死字面量：主题行任何意外改动都会在这里炸出来。
  check('邮件主题为繁体，且逐字锁定', () => {
    const sf = sentMail.filter(m => m.to.indexOf('reader-sf') !== -1)[0];
    assert(sf.subject === '這周的灣區，我給你留了幾張票 · 09.02 那一週',
           '实际: ' + sf.subject);
    const hk = sentMail.filter(m => m.subject.indexOf('香港') !== -1)[0];
    assert(hk.subject === '這周的香港，我給你留了幾張票 · 09.02 那一週',
           '实际: ' + hk.subject);
  });

  check('邮件正文里没有残留简体的界面文案', () => {
    sentMail.forEach(m => {
      const chrome = m.subject + (m.opts && m.opts.htmlBody || '');
      ['给你挑的', '已核实', '未核实', '周报'].forEach(w => {
        notContains(chrome, w, '界面文案应为繁体，发现: ' + w);
      });
    });
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
    contains(sentMail[0].subject, '灣區');
  });

  check('sendIssueTo_ 对空城市返回 false', () => {
    const hk = app.CONFIG.CITIES.filter(c => c.slug === 'hk')[0];
    assert(app.sendIssueTo_('x@example.com', hk) === false);
  });
}

console.log('\n=== 同一期不重发 ===');
{
  check('第一次发信后在 SentLog 记下每个城市的期次', () => {
    const { app, getSentLog } = makeApp(FIXTURE);
    app.sendWeeklyEmail();
    const log = getSentLog();
    assert(log && log[0][0] === 'City', 'SentLog 应自动建表头');
    const rows = log.slice(1).map(r => r[0] + ':' + r[1]).sort();
    assert(rows.join(',') === 'hk:2026-09-02,sf:2026-09-02', '实际 ' + rows.join(','));
  });

  check('下周没有新一期时，一封都不发', () => {
    const { app, sentMail } = makeApp(FIXTURE);
    app.sendWeeklyEmail();
    const n = sentMail.length;
    app.sendWeeklyEmail();
    assert(sentMail.length === n, '第二次不该再发，实际多发 ' + (sentMail.length - n));
  });

  check('只有出了新一期的城市才发', () => {
    const log = [['City','WeekId','SentAt'], ['sf','2026-09-02',''], ['hk','2026-09-02','']];
    const more = FIXTURE.concat([row({City:'香港', WeekId:'2026-09-09', Zone:'港岛', SubGroup:'展',
      Category:'展', Title:'HK 新一期', DateInfo:'09.10', Location:'中环', Status:'已核实'})]);
    const { app, sentMail } = makeApp(more, log);
    app.sendWeeklyEmail();
    assert(sentMail.length === 1, '应只发香港 1 封，实际 ' + sentMail.length);
    contains(sentMail[0].subject, '09.09 那一週');
  });

  check('预览不受发信记录影响，也不写记录', () => {
    const log = [['City','WeekId','SentAt'], ['sf','2026-09-02',''], ['hk','2026-09-02','']];
    const { app, sentMail, getSentLog } = makeApp(FIXTURE, log);
    app.previewWeeklyEmail();
    assert(sentMail.length === 2, '预览应照发');
    assert(getSentLog().length === 3, '预览不该写记录');
  });
}

console.log('\n=== 加入日历 ===');
{
  const H = HEADER.concat(['StartAt', 'EndAt']);
  const r2 = (o) => H.map(h => o[h] === undefined ? '' : o[h]);
  const CAL = [H,
    r2({City:'三藩市湾区', WeekId:'2026-09-30', Zone:'三藩市市内', SubGroup:'演', Category:'演',
        Title:'定时活动, 带逗号', DateInfo:'10.02 1–7pm', Location:'Golden Gate Park, SF', Status:'已核实',
        StartAt:'2026-10-02 13:00', EndAt:'2026-10-02 19:00'}),
    r2({City:'三藩市湾区', WeekId:'2026-09-30', Zone:'三藩市市内', SubGroup:'展', Category:'展',
        Title:'长期展览', DateInfo:'至2027.02.07', Location:'SFMOMA', Status:'已核实'}),
    r2({City:'三藩市湾区', WeekId:'2026-09-30', Zone:'三藩市市内', SubGroup:'玩', Category:'玩',
        Title:'三天全天', DateInfo:'10.09–11', Location:'Marina Green', Status:'已核实',
        StartAt:'2026-10-09', EndAt:'2026-10-11'}),
    r2({City:'香港', WeekId:'2026-09-30', Zone:'港岛', SubGroup:'玩', Category:'玩',
        Title:'国庆烟花', DateInfo:'10.01 8pm', Location:'维港', Status:'已核实', StartAt:'2026-10-01 20:00'}),
  ];
  const sf = (app) => app.CONFIG.CITIES.filter(c => c.slug === 'sf')[0];
  const hk = (app) => app.CONFIG.CITIES.filter(c => c.slug === 'hk')[0];

  check('填了 StartAt 的条目出两个日历按钮，没填的不出', () => {
    const { app } = makeApp(CAL);
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    const n = (html.match(/class="cal-row"/g) || []).length;
    assert(n === 2, '应有 2 条带日历按钮，实际 ' + n);
    contains(html, 'calendar.google.com/calendar/render?action=TEMPLATE');
    contains(html, '?ics=1&amp;city=sf&amp;week=2026-09-30&amp;n=0');
  });

  check('Google 链接：定时活动带城市时区，日期是墙上时间', () => {
    const { app } = makeApp(CAL);
    const ev = app.calendarEvent_({ Title:'x', StartAt:'2026-10-02 13:00', EndAt:'2026-10-02 19:00' }, sf(app));
    const u = app.gcalUrl_(ev);
    contains(u, 'dates=20261002T130000/20261002T190000');
    contains(u, 'ctz=America%2FLos_Angeles');
  });

  check('全天活动：结束日按日历惯例 +1（不含）', () => {
    const { app } = makeApp(CAL);
    const ev = app.calendarEvent_({ Title:'x', StartAt:'2026-10-09', EndAt:'2026-10-11' }, sf(app));
    assert(ev.allDay && ev.start === '20261009' && ev.end === '20261012', JSON.stringify(ev));
    notContains(app.gcalUrl_(ev), 'ctz=');
  });

  check('没写结束时间：默认两小时；跨午夜正确进位', () => {
    const { app } = makeApp(CAL);
    const a = app.calendarEvent_({ Title:'x', StartAt:'2026-10-01 20:00' }, hk(app));
    assert(a.end === '20261001T220000', a.end);
    const b = app.calendarEvent_({ Title:'x', StartAt:'2026-12-31 23:30' }, hk(app));
    assert(b.end === '20270101T013000', b.end);
  });

  check('结束早于开始、格式不对 → 不出按钮', () => {
    const { app } = makeApp(CAL);
    assert(app.calendarEvent_({ Title:'x', StartAt:'2026-10-02 19:00', EndAt:'2026-10-02 13:00' }, sf(app)) === null);
    assert(app.calendarEvent_({ Title:'x', StartAt:'10.02 1pm' }, sf(app)) === null);
  });

  check('.ics 下载：MIME、TZID、转义、CRLF', () => {
    const { app } = makeApp(CAL);
    const out = app.doGet({ parameter: { ics: '1', city: 'sf', week: '2026-09-30', n: '0' } });
    assert(out.mime === 'text/calendar', out.mime);
    contains(out.file, '.ics');
    contains(out.content, 'DTSTART;TZID=America/Los_Angeles:20261002T130000');
    contains(out.content, 'SUMMARY:定时活动\\, 带逗号');
    contains(out.content, 'LOCATION:Golden Gate Park\\, SF');
    assert(out.content.indexOf('\r\n') !== -1 && !/[^\r]\n/.test(out.content), '必须是 CRLF');
  });

  check('.ics：没有 StartAt 的条目返回说明文字而不是坏文件', () => {
    const { app } = makeApp(CAL);
    const out = app.doGet({ parameter: { ics: '1', city: 'sf', week: '2026-09-30', n: '1' } });
    assert(out.mime === 'text/plain', out.mime);
  });

  check('.ics 长行按 UTF-8 字节折行，不切断中文', () => {
    const { app } = makeApp(CAL);
    const folded = app.icsFold_('SUMMARY:' + '中'.repeat(40));
    folded.split('\r\n').forEach((ln, i) => {
      assert(Buffer.byteLength(ln, 'utf8') <= 75, '第' + i + '行超 75 字节');
    });
    assert(folded.replace(/\r\n /g, '') === 'SUMMARY:' + '中'.repeat(40), '展开后应还原');
  });
}

console.log('\n=== 从 GitHub 导入已审核的期次 ===');
{
  const API = 'https://api.github.com/repos/Hello-Sarah/citysignal/contents/data/issues';
  const RAW = 'https://raw.githubusercontent.com/Hello-Sarah/citysignal/main/data/issues/';
  const tsv = (week, extra) => [HEADER.join('\t')].concat([
    ['三藩市湾区', week, '三藩市市内', '吃', '吃', 'SF 新一期' + (extra || ''), '10.07', 'SF', '已核实', '', '', '', ''].join('\t'),
    ['香港', week, '港岛', '展', '展', 'HK 新一期', '10.08', '中环', '已核实', '', '', '=HYPERLINK("x")', ''].join('\t'),
  ]).join('\n');
  const fresh = () => FIXTURE.map(r => r.slice());
  const today = new Date().toISOString().slice(0, 10);

  check('导入日期已到、表格里没有的期次，按表头对列', () => {
    const http = { [API]: JSON.stringify([{ name: '2026-09-09.tsv' }, { name: 'README.md' }]),
                   [RAW + '2026-09-09.tsv']: tsv('2026-09-09') };
    const sheet = fresh();
    const { app } = makeApp(sheet, null, http);
    const got = app.importApprovedIssues_();
    assert(got.length === 2, JSON.stringify(got));
    assert(sheet.length === FIXTURE.length + 2, '应新增 2 行');
    assert(sheet[sheet.length - 2][5] === 'SF 新一期');
  });

  check('以 = 开头的值加单引号，防公式注入', () => {
    const http = { [API]: JSON.stringify([{ name: '2026-09-09.tsv' }]), [RAW + '2026-09-09.tsv']: tsv('2026-09-09') };
    const sheet = fresh();
    makeApp(sheet, null, http).app.importApprovedIssues_();
    const hk = sheet.filter(r => r[5] === 'HK 新一期')[0];
    assert(hk[11] === "'=HYPERLINK(\"x\")", hk[11]);
  });

  check('同一期导入两次不会重复写', () => {
    const http = { [API]: JSON.stringify([{ name: '2026-09-09.tsv' }]), [RAW + '2026-09-09.tsv']: tsv('2026-09-09') };
    const sheet = fresh();
    const { app } = makeApp(sheet, null, http);
    app.importApprovedIssues_();
    const n = sheet.length;
    assert(app.importApprovedIssues_().length === 0 && sheet.length === n);
  });

  check('表格里已有该期（例如人工录入过）→ 整期跳过', () => {
    const http = { [API]: JSON.stringify([{ name: '2026-09-02.tsv' }]), [RAW + '2026-09-02.tsv']: tsv('2026-09-02') };
    const sheet = fresh();
    makeApp(sheet, null, http).app.importApprovedIssues_();
    assert(sheet.length === FIXTURE.length, '已有 09.02 的城市不应再写');
  });

  check('日期还没到的期次（提前合并的）不导入', () => {
    const future = '2099-01-07';
    const http = { [API]: JSON.stringify([{ name: future + '.tsv' }]), [RAW + future + '.tsv']: tsv(future) };
    const sheet = fresh();
    assert(makeApp(sheet, null, http).app.importApprovedIssues_().length === 0);
    assert(sheet.length === FIXTURE.length);
  });

  check('GitHub 不可达 → 什么也不做，发信照常', () => {
    const sheet = fresh();
    const { app, sentMail } = makeApp(sheet, null, {});
    app.sendWeeklyEmail();
    assert(sheet.length === FIXTURE.length);
    assert(sentMail.length === 2, '应照常发 2 封');
  });

  check('发信前先导入：新一期合并后，周三发的就是新一期', () => {
    const http = { [API]: JSON.stringify([{ name: '2026-09-09.tsv' }]), [RAW + '2026-09-09.tsv']: tsv('2026-09-09') };
    const log = [['City','WeekId','SentAt'], ['sf','2026-09-02',''], ['hk','2026-09-02','']];
    const { app, sentMail } = makeApp(fresh(), log, http);
    app.sendWeeklyEmail();
    assert(sentMail.length === 2, '两城都有新一期，应发 2 封，实际 ' + sentMail.length);
    sentMail.forEach(m => contains(m.subject, '09.09 那一週'));
  });
}

console.log('\n=== 天气中文化与图标 ===');
{
  const { app } = makeApp(FIXTURE);
  check('NWS：白天配夜晚，最高/最低温、星期、中文描述、图标类型', () => {
    const days = app.nwsToDays_([
      { name: 'Tonight', isDaytime: false, temperature: 55, temperatureUnit: 'F', startTime: '2026-10-01T18:00:00-07:00', shortForecast: 'Clear' },
      { name: 'Thursday', isDaytime: true, temperature: 74, temperatureUnit: 'F', startTime: '2026-10-02T06:00:00-07:00', shortForecast: 'Patchy Fog then Mostly Sunny' },
      { name: 'Thursday Night', isDaytime: false, temperature: 58, temperatureUnit: 'F', startTime: '2026-10-02T18:00:00-07:00', shortForecast: 'Mostly Clear' },
      { name: 'Friday', isDaytime: true, temperature: 70, temperatureUnit: 'F', startTime: '2026-10-03T06:00:00-07:00', shortForecast: 'Chance Rain Showers' },
    ]);
    assert(days.length === 2, JSON.stringify(days));
    assert(days[0].label === '週五' && days[0].hi === '74°F' && days[0].lo === '58°F', JSON.stringify(days[0]));
    assert(days[0].text === '局部有霧，之後大致天晴', days[0].text);
    assert(days[0].kind === 'fog');
    assert(days[1].kind === 'showers' && days[1].lo === '', JSON.stringify(days[1]));
  });
  check('翻译不了的短语保留英文，不乱猜', () => {
    assert(app.translateNws_('Blowing Dust') === 'Blowing Dust');
  });
  check('天文台图标编号映射', () => {
    assert(app.hkoKind_(50) === 'sun' && app.hkoKind_(65) === 'thunder' && app.hkoKind_(63) === 'rain' && app.hkoKind_(999) === 'partly');
  });
  check('天气块里有图标', () => {
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    contains(html, '.wx-icon');
  });
}

console.log('\n=== 活动配图 ===');
{
  const { app } = makeApp(FIXTURE);
  check('有照片：显示图片 + 来源，载入失败就拿掉配图区（不用卡通）', () => {
    const h = app.renderMedia_({ Category: '展', Image: 'https://www.sfmoma.org/x.jpg', ImageCredit: 'sfmoma.org' });
    contains(h, 'src="https://www.sfmoma.org/x.jpg"');
    contains(h, '圖片 · sfmoma.org');
    contains(h, 'referrerpolicy="no-referrer"');
    contains(h, 'this.parentNode.remove()');
    notContains(h, '<svg');
  });
  check('没有图 / 非 https 链接 → 不显示配图区', () => {
    ['', 'http://x.com/a.jpg', 'javascript:alert(1)'].forEach(v => {
      assert(app.renderMedia_({ Category: '吃', Image: v }) === '', v);
    });
  });
  check('来源只显示网域，不显示完整路径', () => {
    const h = app.renderMedia_({ Category: '展', Image: 'https://a.org/x.jpg', ImageCredit: 'https://famsf.org/exhibitions/miro' });
    contains(h, '圖片 · famsf.org<');
  });
  check('页面上没有卡通插图', () => {
    const html = app.doGet({ parameter: { city: 'sf', week: '2026-09-02' } }).html;
    notContains(html, 'illo');
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

console.log('\n=== 简繁映射 ===');
// 表格是简体时期建的，代码现在是繁体。读取时做一层枚举映射，
// 两种写法都要认——否则一个字没对上，那条活动就从页面上悄悄消失了。
// 上面所有夹具用的都是简体值，能跑通本身就是这一层在生效。
{
  const TRAD = [
    HEADER,
    row({City:'三藩市灣區', WeekId:'2026-09-02', Zone:'三藩市市內', SubGroup:'吃',
         Category:'吃', Title:'繁體寫法的活動', DateInfo:'09.09', Location:'SF', Status:'已核實'}),
  ];
  check('繁体枚举原样通过', () => {
    const { app } = makeApp(TRAD);
    contains(app.doGet({ parameter: { city: 'sf' } }).html, '繁體寫法的活動');
  });

  check('简体枚举被映射到繁体分区，内容不丢', () => {
    const { app } = makeApp(FIXTURE);
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    contains(html, 'SF 精选餐厅', '简体 Zone「三藩市市内」应落进「三藩市市內」');
    contains(html, 'SF 市外活动', '简体 Zone「湾区市外」应落进「灣區市外」');
  });

  check('简体 Status 映射后拿到正确的核实徽章样式', () => {
    const { app } = makeApp(FIXTURE);
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    contains(html, 'venue-verified', '「场地已核实」应映射成「場地已核實」并命中样式');
    notContains(html, '已核实<', '页面上不应再出现未映射的简体状态');
  });

  check('简繁混排的同一个分区不会被拆成两块', () => {
    const MIXED = [
      HEADER,
      row({City:'香港', WeekId:'2026-09-02', Zone:'港岛', SubGroup:'展',
           Category:'展', Title:'简体行', DateInfo:'09.05', Location:'中环', Status:'已核实'}),
      row({City:'香港', WeekId:'2026-09-02', Zone:'港島', SubGroup:'展',
           Category:'展', Title:'繁體行', DateInfo:'09.06', Location:'中環', Status:'已核實'}),
    ];
    const { app } = makeApp(MIXED);
    const html = app.doGet({ parameter: { city: 'hk' } }).html;
    contains(html, '简体行'); contains(html, '繁體行');
    const occurrences = html.split('港島').length - 1;
    assert(occurrences >= 1, '繁体分区名应出现');
    notContains(html, '>港岛<', '不应同时渲染出简体分区标题');
  });

  check('正文不做逐字替换（只映射枚举列）', () => {
    const { app } = makeApp(FIXTURE);
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    contains(html, 'SF 精选餐厅', '标题是正文，应原样保留，交给 OpenCC 整段转');
  });
}

console.log('\n=== 天气模块的静默降级 ===');
// 关键约束：天气拿不到，页面必须照常渲染。
// 这里故意不打 CacheService / UrlFetchApp 的桩——它们在 Apps Script 之外
// 连引用都会抛 ReferenceError，正好模拟「权限还没批下来」的真实状态。
// 这一组测试写出来的时候就抓到了一个真 bug：weatherFor_ 里
// CacheService.getScriptCache() 在 try 外面，异常会一路冒到 doGet，整页 500。
{
  check('天气服务不可用时，页面照常渲染，不抛异常', () => {
    const { app } = makeApp(FIXTURE);
    let html = null;
    try {
      html = app.doGet({ parameter: { city: 'sf' } }).html;
    } catch (e) {
      assert(false, '天气失败不该炸掉整页: ' + e.message);
    }
    contains(html, 'SF 精选餐厅', '活动内容必须还在');
  });

  check('天气拿不到时不留半截空壳', () => {
    const { app } = makeApp(FIXTURE);
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    notContains(html, '<div class="wx">', '降级应该是整块不渲染，而不是渲染一个空容器');
    notContains(html, '出門前看一眼', '天气标题不该出现');
  });

  check('每个城市都配了天气信源，且只用政府源', () => {
    const { app } = makeApp(FIXTURE);
    const OK = ['nws', 'hko'];
    app.CONFIG.CITIES.forEach(c => {
      assert(c.weather && OK.indexOf(c.weather.provider) !== -1,
             c.slug + ' 的天气信源不是政府源: ' + JSON.stringify(c.weather));
      if (c.weather.provider === 'nws') {
        assert(typeof c.weather.lat === 'number' && typeof c.weather.lon === 'number',
               c.slug + ' 缺经纬度');
      }
    });
  });
}

// ---- 暂停期次 ----
console.log('\n[暂停期次]');
{
  const PFIX = FIXTURE.concat([
    row({City:'三藩市湾区', WeekId:'2026-09-30', Zone:'三藩市市内', SubGroup:'玩',
         Category:'玩', Title:'恢复后第一期', DateInfo:'10.02', Location:'SF', Status:'已核实'}),
  ]);
  const setPauses = (app) => {
    app.CONFIG.PAUSES = [
      { city: 'sf', weeks: ['2026-09-09', '2026-09-16', '2026-09-23'],
        reason: '編輯出差', reasonEn: 'the editor was travelling for work' },
      { city: 'hk', weeks: ['2026-09-16'], reason: '編輯出差', reasonEn: 'x' }
    ];
  };

  check('暂停周出现在侧边栏、标「暫停」、且不是链接', () => {
    const { app } = makeApp(PFIX); setPauses(app);
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    contains(html, '09.16 那一週<span class="paused-tag">暫停</span>');
    notContains(html, 'week=2026-09-16', '暂停周不应可点');
  });

  check('侧边栏按日期混排：09.30 > 暂停三周 > 09.02', () => {
    const { app } = makeApp(PFIX); setPauses(app);
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    const order = ['09.30 那一週', '09.23 那一週', '09.16 那一週', '09.09 那一週', '09.02 那一週']
      .map(s => html.indexOf(s));
    assert(order.every(i => i !== -1), '五个期次都应出现');
    assert(order.every((v, i) => i === 0 || v > order[i - 1]), '顺序不对: ' + order);
  });

  check('恢复后第一期顶部写明暂停区间、期数和原因（中英）', () => {
    const { app } = makeApp(PFIX); setPauses(app);
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    contains(html, '09.09–09.23（共 3 期）因編輯出差暫停更新');
    contains(html, 'Paused Sep 9 – Sep 23 (3 issues) while the editor was travelling for work');
  });

  check('暂停说明只在紧接暂停的那一期出现', () => {
    const { app } = makeApp(PFIX); setPauses(app);
    const html = app.doGet({ parameter: { city: 'sf', week: '2026-09-02' } }).html;
    notContains(html, 'class="pause-notice"');
  });

  check('暂停只作用于自己的城市', () => {
    const { app } = makeApp(PFIX); setPauses(app);
    const html = app.doGet({ parameter: { city: 'hk' } }).html;
    notContains(html, '09.09 那一週');
    contains(html, '09.16 那一週<span class="paused-tag">暫停</span>');
  });

  check('已有数据的周即使被登记为暂停，也按正常期次显示', () => {
    const { app } = makeApp(PFIX); setPauses(app);
    app.CONFIG.PAUSES[0].weeks.push('2026-09-30');
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    contains(html, '恢复后第一期');
    notContains(html, '09.30 那一週<span class="paused-tag">');
  });

  check('没配置 PAUSES 时页面照常', () => {
    const { app } = makeApp(PFIX); delete app.CONFIG.PAUSES;
    const html = app.doGet({ parameter: { city: 'sf' } }).html;
    notContains(html, 'class="paused-tag"'); contains(html, '恢复后第一期');
  });

  check('暂停不影响发信：仍发最新一期', () => {
    const { app, sentMail } = makeApp(PFIX); setPauses(app);
    app.sendWeeklyEmail();
    const sf = sentMail.filter(m => m.subject.indexOf('灣區') !== -1)[0];
    assert(sf && sf.subject.indexOf('09.30 那一週') !== -1, '应发 09.30 那期');
  });
}

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + '    失败 ' + fail);
process.exit(fail ? 1 : 0);
