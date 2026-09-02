/**
 * ============================================================
 * 湾区周报自动化脚本
 * ============================================================
 * 功能：
 * 1. doGet()        — 对外提供网页，任何人打开链接都能看，带历史周报侧边栏
 * 2. sendWeeklyEmail() — 生成当周邮件并发送给指定收件人
 * 3. createWeeklyTrigger() — 一次性运行，设置"每周三自动发邮件"的定时任务
 *
 * 使用前必须做的事：
 * 1. 把下面 CONFIG 里的 SHEET_ID、RECIPIENT_EMAIL 改成你自己的
 * 2. 按照"表格结构说明.md"建好Google Sheet的列
 * 3. 部署为Web App（详见搭建指南）
 * 4. 手动运行一次 createWeeklyTrigger() 来设置定时任务
 * ============================================================
 */

const CONFIG = {
  // 把这个换成你的Google Sheet的ID（网址中 /d/ 和 /edit 之间那一串）
  SHEET_ID: 'PASTE_YOUR_GOOGLE_SHEET_ID_HERE',
  SHEET_TAB_NAME: 'Events',
  // 收件人邮箱（可填多个，都会收到同一封周报）
  RECIPIENT_EMAILS: [
    'recipient-1@example.com',
    'recipient-2@example.com'
  ],
  // 邮件发件人显示名称
  SENDER_NAME: '湾区周报',
  // 公开网页地址（必须写死）。
  // 曾经用 ScriptApp.getService().getUrl() 动态取，但从编辑器手动运行时
  // 它返回的是 /dev 开发版地址，收件人点开会被 Google 拦在权限页外。
  SITE_URL: 'https://script.google.com/macros/s/PASTE_YOUR_DEPLOYMENT_ID/exec',
  // previewWeeklyEmail() 额外发到的地址 —— 都是作者本人的邮箱。
  // 正式收件人在 RECIPIENT_EMAILS 里，预览不会发给他们。
  PREVIEW_ALSO: ['you@example.com', 'recipient-2@example.com'],
  // 网页标题
  SITE_TITLE: '三藩市 & 湾区周报'
};

// ============================================================
// 入口：网页请求处理
// ============================================================
function doGet(e) {
  const data = readAllEvents_();
  const weekIds = getSortedWeekIds_(data);
  const selectedWeek = (e && e.parameter && e.parameter.week && weekIds.includes(e.parameter.week))
    ? e.parameter.week
    : weekIds[0]; // 默认显示最新一期

  const html = renderPage_(data, weekIds, selectedWeek);
  return HtmlService.createHtmlOutput(html)
    .setTitle(CONFIG.SITE_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ============================================================
// 读取Sheet数据
// ============================================================
// Google Sheets 会把 2026-08-26 这样的值自动识别成日期，getValues() 返回的是 Date 对象
// 而不是字符串，后面 weekId.split('-') 就会炸。这里统一把单元格转成字符串。
function cellToString_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).trim();
}

function readAllEvents_() {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_TAB_NAME);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());
  const rows = values.slice(1).filter(r => r[0] !== '' && r[0] !== null && r[0] !== undefined);

  return rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = cellToString_(r[i]));
    return obj;
  });
  // 期望的列（表头）：
  // WeekId | Zone | SubGroup | Category | Title | DateInfo | Location | Status | PriceInfo | MapLink | Note | Pick
  // Pick 列填任意非空值（建议 ★）= 标记为「给你挑的」，会在页面上高亮
}

function getSortedWeekIds_(data) {
  const ids = [...new Set(data.map(d => d.WeekId))];
  return ids.sort().reverse(); // 最新的在前
}

// ============================================================
// 渲染整个网页（含侧边栏历史周报）
// ============================================================
function renderPage_(data, weekIds, selectedWeek) {
  const baseUrl = ScriptApp.getService().getUrl();
  const weekData = data.filter(d => d.WeekId === selectedWeek);

  const sidebarHtml = weekIds.map(w => {
    const active = w === selectedWeek ? 'active' : '';
    return `<a class="week-link ${active}" href="${baseUrl}?week=${w}">${formatWeekLabel_(w)}</a>`;
  }).join('');

  const zones = ['三藩市市内', '湾区市外', '华人社群活动'];
  const bodyHtml = zones.map(zone => renderZone_(zone, weekData)).join('');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>${CONFIG.SITE_TITLE}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${PAGE_CSS_}</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-title">往期周报</div>
    ${sidebarHtml}
  </aside>
  <main class="main">
    <header>
      <div class="eyebrow">SF & Bay Area Weekly</div>
      <h1>${formatWeekLabel_(selectedWeek)}</h1>
    </header>
    ${bodyHtml}
  </main>
</div>
</body>
</html>`;
}

function formatWeekLabel_(weekId) {
  // weekId 格式假设为 2026-08-26，转成"08.26 那一周"
  const s = cellToString_(weekId);
  const parts = s.split('-');
  if (parts.length === 3) return `${parts[1]}.${parts[2]} 那一周`;
  return s;
}

function renderZone_(zoneName, weekData) {
  const zoneItems = weekData.filter(d => d.Zone === zoneName);
  if (zoneItems.length === 0) return '';

  const subGroups = [...new Set(zoneItems.map(d => d.SubGroup || ''))];

  const groupsHtml = subGroups.map(sg => {
    const items = zoneItems.filter(d => (d.SubGroup || '') === sg);
    const itemsHtml = items.map(renderTicket_).join('');
    return `${sg ? `<div class="section-title">${esc_(sg)}</div>` : ''}${itemsHtml}`;
  }).join('');

  return `
  <div class="zone-title"><h2>${esc_(zoneName)}</h2></div>
  <div class="zone-rule"></div>
  ${groupsHtml}`;
}

// 把表格里的内容转义后再放进HTML，避免标题里出现 & < > " 时把页面弄坏
function esc_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTicket_(item) {
  const statusClass = item.Status === '已核实' ? 'verified'
    : item.Status === '场地已核实' ? 'venue-verified'
    : 'unverified';
  const statusLabel = item.Status || '未核实';
  // 只有真正的 http(s) 链接才渲染地图按钮，防止表格里填了微信号之类的内容
  const mapUrl = String(item.MapLink || '').trim();
  const hasMap = /^https?:\/\//i.test(mapUrl);

  // Pick 列非空 = Sarah/Claude 手选的推荐条目，视觉上高亮
  const isPick = String(item.Pick || '').trim() !== '';

  return `
  <div class="ticket${isPick ? ' pick' : ''}">
    <div class="stub">
      <span class="tag">${esc_(item.Category)}</span>
      <span class="date">${esc_(item.DateInfo)}</span>
    </div>
    <div class="details">
      <h3>${esc_(item.Title)}${isPick ? '<span class="pick-badge">给你挑的</span>' : ''}</h3>
      <div class="where">${esc_(item.Location)}</div>
      <div class="meta-row">
        ${item.PriceInfo ? `<span class="pill ${statusClass}">${esc_(item.PriceInfo)}</span>` : ''}
        <span class="status-badge ${statusClass}">${esc_(statusLabel)}</span>
        ${hasMap ? `<a class="map-link" href="${esc_(mapUrl)}" target="_blank" rel="noopener">在地图中查看 →</a>` : ''}
      </div>
      ${item.Note ? `<div class="note">${esc_(item.Note)}</div>` : ''}
    </div>
  </div>`;
}

// ============================================================
// 页面样式（沿用之前"车票风"设计）
// ============================================================
const PAGE_CSS_ = `
  :root{
    --fog:#c9d2d4; --fog-dark:#5c7078; --paper:#f2ecdc; --paper-shadow:#d8cfb5;
    --ink:#1e2a32; --ink-soft:#3d4f58; --rust:#a94e29; --gold:#a9812c; --green:#5c7a52;
  }
  *{box-sizing:border-box;}
  html{background:var(--fog);}
  body{margin:0;font-family:'IBM Plex Sans',sans-serif;color:var(--ink);
    background:linear-gradient(180deg,var(--fog) 0%,#93a7ad 100%);min-height:100vh;}
  .layout{display:flex;max-width:1100px;margin:0 auto;}
  .sidebar{flex:0 0 200px;padding:40px 16px;}
  .sidebar-title{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:0.1em;
    color:var(--fog-dark);text-transform:uppercase;margin-bottom:12px;}
  .week-link{display:block;padding:8px 10px;margin-bottom:4px;border-radius:6px;
    color:var(--ink-soft);text-decoration:none;font-size:13px;font-family:'IBM Plex Mono',monospace;}
  .week-link.active{background:var(--paper);color:var(--ink);font-weight:600;}
  .week-link:hover{background:rgba(255,255,255,0.4);}
  .main{flex:1;padding:40px 24px 80px;}
  .eyebrow{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:0.15em;
    color:var(--fog-dark);text-transform:uppercase;margin-bottom:10px;}
  h1{font-family:'Fraunces',serif;font-size:36px;margin:0 0 30px;}
  .zone-title h2{font-family:'Fraunces',serif;font-style:italic;font-size:24px;margin:36px 0 6px;}
  .zone-rule{height:2px;background:repeating-linear-gradient(90deg,var(--ink) 0 6px,transparent 6px 12px);
    opacity:0.3;margin-bottom:18px;}
  .section-title{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:0.1em;
    color:var(--fog-dark);text-transform:uppercase;margin:20px 0 12px;}
  .ticket{display:flex;background:var(--paper);border-radius:6px;margin-bottom:14px;
    box-shadow:0 8px 18px -12px rgba(20,30,38,0.5);overflow:hidden;}
  .stub{flex:0 0 110px;padding:14px;border-right:2px dashed var(--paper-shadow);
    display:flex;flex-direction:column;justify-content:center;}
  .tag{font-family:'IBM Plex Mono',monospace;font-size:10px;background:var(--ink);color:#fff;
    padding:2px 6px;border-radius:3px;margin-bottom:6px;display:inline-block;width:fit-content;}
  .date{font-family:'IBM Plex Mono',monospace;font-size:12px;}
  .details{padding:14px 18px;flex:1;}
  .details h3{font-family:'Fraunces',serif;font-size:17px;margin:0 0 4px;}
  .ticket.pick{box-shadow:0 0 0 2px var(--gold),0 8px 18px -12px rgba(20,30,38,0.5);}
  .ticket.pick .stub{border-right-color:var(--gold);}
  .pick-badge{display:inline-block;vertical-align:middle;margin-left:8px;
    font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:0.06em;
    color:#fff;background:var(--gold);padding:2px 7px;border-radius:10px;}
  .where{font-size:12px;color:var(--fog-dark);font-family:'IBM Plex Mono',monospace;margin-bottom:8px;}
  .meta-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
  .pill{font-family:'IBM Plex Mono',monospace;font-size:11px;padding:3px 8px;border-radius:20px;
    border:1px solid var(--paper-shadow);}
  .status-badge{font-family:'IBM Plex Mono',monospace;font-size:9px;padding:2px 6px;border-radius:10px;}
  .status-badge.verified{color:#fff;background:var(--green);}
  .status-badge.venue-verified{color:var(--green);border:1px solid var(--green);}
  .status-badge.unverified{color:var(--rust);border:1px solid var(--rust);}
  .map-link{font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--ink);
    text-decoration:none;border-bottom:1px solid var(--ink);}
  .note{margin-top:8px;font-size:12px;font-style:italic;color:var(--rust);}
  @media(max-width:700px){.layout{flex-direction:column;}.sidebar{
    display:flex;overflow-x:auto;gap:6px;padding:20px 16px 0;}.week-link{white-space:nowrap;}}
`;

// ============================================================
// 发送每周邮件
// ============================================================
function sendWeeklyEmail() {
  sendIssueTo_(CONFIG.RECIPIENT_EMAILS.join(','));
}

// 预览：只发到作者本人的邮箱（脚本所有者 + CONFIG.PREVIEW_ALSO）。
// 不会发给 CONFIG.RECIPIENT_EMAILS 里的读者。
// 用途：正式发出前先自己看一眼排版，不用拿读者当测试。
function previewWeeklyEmail() {
  // 这里刻意不用 Session.getActiveUser().getEmail()：那需要额外的 OAuth
  // 范围（读取账号邮箱），为一个预览功能扩大脚本权限不划算。写死即可。
  const list = (CONFIG.PREVIEW_ALSO || []).filter(Boolean);
  if (!list.length) throw new Error('CONFIG.PREVIEW_ALSO 是空的，没有预览地址');
  sendIssueTo_(list.join(','));
  Logger.log('预览邮件已发送至 ' + list.join(', ') + '（未发给正式收件人）');
}

function sendIssueTo_(toAddress) {
  const data = readAllEvents_();
  const weekIds = getSortedWeekIds_(data);
  const latestWeek = weekIds[0];
  const weekData = data.filter(d => d.WeekId === latestWeek);
  const link = CONFIG.SITE_URL + '?week=' + latestWeek;
  const label = formatWeekLabel_(latestWeek);

  // 优先列出 Pick 标记的条目；不足5条再用其余的补齐
  const picked = weekData.filter(d => String(d.Pick || '').trim() !== '');
  const rest = weekData.filter(d => String(d.Pick || '').trim() === '');
  const top = picked.concat(rest).slice(0, 5);

  // 注意：主题和正文里都不要放 emoji。
  // 曾经在主题里放过一个票券 emoji，收件人那边是一串问号方块 —— 非 BMP
  // 字符没扛过邮件头编码。中文是 BMP 内的三字节字符，没有这个问题。
  const subject = '这周的湾区，我给你留了几张票 · ' + label;

  const plainBody = [
    '嘿，',
    '',
    '这周整理了 ' + weekData.length + ' 个活动，先挑几个给你：',
    '',
    top.map(d => '- ' + d.Title + '（' + d.DateInfo + '｜' + d.Location + '）').join('\n'),
    '',
    '完整清单：' + link,
    '',
    '（你的落款）'
  ].join('\n');

  const rows = top.map(d => renderMailItem_(d)).join('');

  const htmlBody = `
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#c9d2d4;padding:28px 12px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#f2ecdc;border-radius:4px;">

  <tr><td style="padding:30px 30px 0 30px;">
    <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.18em;color:#8a8578;">
      SF &amp; BAY AREA WEEKLY
    </div>
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:32px;color:#1e2830;padding-top:6px;">
      ${esc_(label)}
    </div>
    <div style="font-family:Georgia,serif;font-size:15px;color:#5a5449;padding-top:14px;line-height:1.6;">
      这周整理了 ${weekData.length} 个活动，先挑几个给你 —
    </div>
  </td></tr>

  <tr><td style="padding:20px 30px 0 30px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
  </td></tr>

  <tr><td align="center" style="padding:26px 30px 8px 30px;">
    <a href="${esc_(link)}" style="display:inline-block;background:#a94e29;color:#ffffff;
      font-family:Georgia,serif;font-size:15px;padding:12px 30px;border-radius:24px;
      text-decoration:none;">查看完整 ${esc_(String(weekData.length))} 条 &rarr;</a>
  </td></tr>

  <tr><td style="padding:18px 30px 30px 30px;">
    <div style="border-top:1px dashed #c4baa4;padding-top:16px;
      font-family:Georgia,serif;font-size:14px;color:#8a8578;">（你的落款）</div>
  </td></tr>

</table>
</td></tr>
</table>`;

  GmailApp.sendEmail(toAddress, subject, plainBody, {
    htmlBody: htmlBody,
    name: CONFIG.SENDER_NAME
  });
}

// 邮件里的单条活动，做成和网页一致的「车票存根」样式。
// 邮件客户端对 flex/grid 支持很差，这里一律用 table + 内联样式。
function renderMailItem_(d) {
  const isPick = String(d.Pick || '').trim() !== '';
  const accent = isPick ? '#b8860b' : '#c4baa4';
  const status = String(d.Status || '').trim();
  const statusColor = status === '已核实' ? '#4a7c59'
    : status === '场地已核实' ? '#7a8f6b'
    : '#b5503c';

  return `
<tr><td style="padding-bottom:10px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
    style="background:#faf6ea;border-left:3px solid ${accent};">
    <tr>
      <td width="86" valign="top" style="padding:12px 10px;border-right:1px dashed ${accent};">
        <div style="font-family:'Courier New',monospace;font-size:10px;color:#ffffff;
          background:#1e2830;display:inline-block;padding:2px 6px;">${esc_(d.Category)}</div>
        <div style="font-family:'Courier New',monospace;font-size:11px;color:#5a5449;
          padding-top:6px;line-height:1.4;">${esc_(d.DateInfo)}</div>
      </td>
      <td valign="top" style="padding:12px 14px;">
        <div style="font-family:Georgia,serif;font-size:16px;color:#1e2830;line-height:1.35;">
          ${esc_(d.Title)}${isPick ? ' <span style="font-family:\'Courier New\',monospace;font-size:9px;color:#ffffff;background:#b8860b;padding:2px 6px;border-radius:9px;">给你挑的</span>' : ''}
        </div>
        <div style="font-family:'Courier New',monospace;font-size:11px;color:#7a7365;padding-top:5px;">
          ${esc_(d.Location)}
        </div>
        <div style="padding-top:7px;">
          ${d.PriceInfo ? `<span style="font-family:Georgia,serif;font-size:11px;color:#5a5449;">${esc_(d.PriceInfo)}</span>&nbsp;&nbsp;` : ''}
          <span style="font-family:'Courier New',monospace;font-size:10px;color:${statusColor};
            border:1px solid ${statusColor};padding:1px 5px;">${esc_(status || '未核实')}</span>
        </div>
      </td>
    </tr>
  </table>
</td></tr>`;
}


// ============================================================
// 一次性设置：每周三上午9点自动发邮件
// 手动运行这个函数一次即可，之后不用再管
// ============================================================
function createWeeklyTrigger() {
  // 先清掉旧的同名触发器，避免重复
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendWeeklyEmail') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('sendWeeklyEmail')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.WEDNESDAY)
    .atHour(9)
    .create();

  Logger.log('已设置：每周三上午9点自动发送邮件');
}
