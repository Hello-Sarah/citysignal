/**
 * ============================================================
 * 灣區週報自動化腳本
 * ============================================================
 * 功能：
 * 1. doGet()        — 對外提供網頁，任何人打開鏈接都能看，帶歷史週報側邊欄
 * 2. sendWeeklyEmail() — 生成當週郵件併發送給指定收件人
 * 3. createWeeklyTrigger() — 一次性運行，設置"每週三自動發郵件"的定時任務
 *
 * 使用前必須做的事：
 * 1. 把下面 CONFIG 裏的 SHEET_ID、RECIPIENT_EMAIL 改成你自己的
 * 2. 按照"表格結構説明.md"建好Google Sheet的列
 * 3. 部署為Web App（詳見搭建指南）
 * 4. 手動運行一次 createWeeklyTrigger() 來設置定時任務
 * ============================================================
 */

const CONFIG = {
  // 把這個換成你的Google Sheet的ID（網址中 /d/ 和 /edit 之間那一串）
  SHEET_ID: 'PASTE_YOUR_GOOGLE_SHEET_ID_HERE',
  SHEET_TAB_NAME: 'Events',
  // ---- 城市配置 ----
  // 每個城市自成一期：City 列決定條目屬於哪個城市，Zone 的合法取值也按城市查表。
  // 加一個新城市 = 在這裏加一項 + 往 Sheet 裏寫數據，不需要改任何渲染代碼。
  // zones 的順序就是頁面上分區的顯示順序。
  CITIES: [
    {
      slug: 'sf',
      label: '三藩市灣區',
      // 每個城市有自己的頁面標題：換城市不會改動別的城市讀者看到的字
      siteTitle: '三藩市 & 灣區週報',
      eyebrow: 'SF & Bay Area Weekly',
      // 郵件主題裏的簡稱：刻意保持「灣區」，讓現有讀者收到的主題一字不變
      mailName: '灣區',
      // 天氣用美國國家氣象局（NWS）——政府氣象源，免 API key。
      // 和整個項目一樣：能用官方就不用聚合站。
      weather: { provider: 'nws', lat: 37.7749, lon: -122.4194 },
      zones: ['三藩市市內', '灣區市外', '華人社群活動']
    },
    {
      slug: 'hk',
      label: '香港',
      siteTitle: '香港週報',
      eyebrow: 'Hong Kong Weekly',
      mailName: '香港',
      // 香港天文台開放數據，繁體中文九天預報
      weather: { provider: 'hko' },
      zones: ['港島', '九龍', '新界']
    }
    // 紐約留位：把下面這項取消註釋並補好 zones 即可，無需改代碼
    // , { slug: 'ny', label: '紐約', siteTitle: '紐約週報', zones: ['曼哈頓', '布魯克林 & 皇后', '外圍'] }
  ],

  // ---- 收件人與訂閲 ----
  // 每個人只收自己訂閲城市的郵件，一個城市一封，互不混在一起。
  // cities 裏寫 CITIES 的 slug。
  RECIPIENTS: [
    { email: 'reader-sf@example.com', cities: ['sf'] },
    { email: 'reader-both@example.com', cities: ['sf', 'hk'] }
  ],
  // 郵件發件人顯示名稱
  SENDER_NAME: '灣區週報',
  // 公開網頁地址（必須寫死）。
  // 曾經用 ScriptApp.getService().getUrl() 動態取，但從編輯器手動運行時
  // 它返回的是 /dev 開發版地址，收件人點開會被 Google 攔在權限頁外。
  SITE_URL: 'https://script.google.com/macros/s/PASTE_YOUR_DEPLOYMENT_ID_HERE/exec',
  // previewWeeklyEmail() 額外發到的地址 —— 都是作者本人的郵箱。
  // 正式收件人在 RECIPIENTS 裏，預覽不會發給他們。
  PREVIEW_ALSO: ['you@example.com', 'reader-both@example.com'],
  // 兜底頁面標題：僅在城市配置裏沒寫 siteTitle 時使用
  SITE_TITLE: '本地活動週報'
};

// ============================================================
// 城市
// ============================================================
function citiesList_() {
  return (CONFIG.CITIES && CONFIG.CITIES.length) ? CONFIG.CITIES : [];
}

function findCityBySlug_(slug) {
  return citiesList_().filter(c => c.slug === String(slug || '').trim())[0] || null;
}

function findCityByLabel_(label) {
  return citiesList_().filter(c => c.label === String(label || '').trim())[0] || null;
}

// 默認城市 = 配置裏的第一個。刻意不按"哪個城市最近更新"來選：
// 讀者每次打開看到的城市應該是穩定的，不該因為另一個城市更新了就跳走。
function defaultCity_() {
  return citiesList_()[0] || null;
}

// ============================================================
// 天氣預報
// ============================================================
// 只用政府氣象源：美國國家氣象局 (api.weather.gov) 與香港天文台 (data.weather.gov.hk)。
// 兩者都免 API key。挑信源的標準和活動本身一致——能用官方就不用聚合站。
//
// 失敗一律靜默降級：拿不到天氣就不顯示這一條，絕不讓它拖垮整頁。
// 一份週報沒有天氣還是週報；打不開的週報什麼都不是。

function weatherFor_(city) {
  if (!city || !city.weather) return null;
  const key = 'wx_' + city.slug;
  let cache = null;
  try {
    cache = CacheService.getScriptCache();
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (err) { /* 快取不可用不影響主流程 */ }

  let days = null;
  try {
    days = city.weather.provider === 'hko' ? fetchHko_() : fetchNws_(city.weather);
  } catch (err) {
    return null;
  }
  if (!days || !days.length) return null;

  try {
    // 三小時快取：預報本來就不會分鐘級變動，也避免每次開頁都打一次官方 API
    if (cache) cache.put(key, JSON.stringify(days), 3 * 60 * 60);
  } catch (err) { /* 快取寫失敗不影響主流程 */ }
  return days;
}

function fetchNws_(cfg) {
  // NWS 要求帶 User-Agent，否則直接拒絕
  const opts = {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'CitySignal weekly digest (contact via GitHub)' }
  };
  const pt = UrlFetchApp.fetch(
    'https://api.weather.gov/points/' + cfg.lat + ',' + cfg.lon, opts);
  if (pt.getResponseCode() !== 200) return null;
  const url = JSON.parse(pt.getContentText()).properties.forecast;

  const fc = UrlFetchApp.fetch(url, opts);
  if (fc.getResponseCode() !== 200) return null;
  const periods = JSON.parse(fc.getContentText()).properties.periods || [];

  // NWS 一天拆成日/夜兩段，只取白天那段
  return periods.filter(p => p.isDaytime).slice(0, 5).map(p => ({
    label: p.name,
    hi: p.temperature + '\u00B0' + p.temperatureUnit,
    lo: '',
    text: p.shortForecast
  }));
}

function fetchHko_() {
  const res = UrlFetchApp.fetch(
    'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=tc',
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const list = JSON.parse(res.getContentText()).weatherForecast || [];
  return list.slice(0, 5).map(d => ({
    label: String(d.week || '').replace('星期', '週'),
    hi: (d.forecastMaxtemp && d.forecastMaxtemp.value) ? d.forecastMaxtemp.value + '\u00B0' : '',
    lo: (d.forecastMintemp && d.forecastMintemp.value) ? d.forecastMintemp.value + '\u00B0' : '',
    text: String(d.forecastWeather || '').replace(/。$/, '')
  }));
}

// 天氣是錦上添花，不是週報本身。所以這一層外面再包一道 try：
// weatherFor_ 內部已經擋掉了網絡失敗，但擋不住整個服務不可用
// （CacheService / UrlFetchApp 在權限沒批下來、或跑在非 Apps Script 環境時，
// 連引用本身都會拋 ReferenceError，那種錯漏出去就是整頁 500）。
// 一份沒有天氣的週報還是週報；打不開的週報什麼都不是。
function renderWeather_(city) {
  let days = null;
  try {
    days = weatherFor_(city);
  } catch (err) {
    return '';
  }
  if (!days) return '';   // 靜默降級
  const src = city.weather.provider === 'hko' ? '香港天文台' : 'US National Weather Service';
  const cells = days.map(d => `
    <div class="wx-day">
      <div class="wx-label">${esc_(d.label)}</div>
      <div class="wx-temp">${esc_(d.hi)}${d.lo ? ' / ' + esc_(d.lo) : ''}</div>
      <div class="wx-text">${esc_(d.text)}</div>
    </div>`).join('');
  return `
  <div class="wx">
    <div class="wx-head">出門前看一眼 · 信源 ${esc_(src)}</div>
    <div class="wx-row">${cells}</div>
  </div>`;
}

// ============================================================
// 入口：網頁請求處理
// ============================================================
function doGet(e) {
  const param = (e && e.parameter) ? e.parameter : {};
  const data = readAllEvents_();

  // 城市：?city=hk。非法或缺省一律回落到默認城市，不報錯。
  const city = findCityBySlug_(param.city) || defaultCity_();

  // 期次列表是按城市算的：切城市時下面的往期列表跟着換
  const weekIds = getSortedWeekIds_(data, city);
  const selectedWeek = (param.week && weekIds.indexOf(param.week) !== -1)
    ? param.week
    : (weekIds[0] || ''); // 該城市還沒有任何一期時為空字符串，渲染層出空狀態

  const html = renderPage_(data, city, weekIds, selectedWeek);
  return HtmlService.createHtmlOutput(html)
    .setTitle((city && city.siteTitle) || CONFIG.SITE_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ============================================================
// 讀取Sheet數據
// ============================================================
// Google Sheets 會把 2026-08-26 這樣的值自動識別成日期，getValues() 返回的是 Date 對象
// 而不是字符串，後面 weekId.split('-') 就會炸。這裏統一把單元格轉成字符串。
function cellToString_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).trim();
}

// 表格裏的枚舉值有簡體歷史數據（表是簡體時期建的），代碼現在是繁體。
// 不去批量改表——那是拿瀏覽器自動化動用戶的真實數據，改漏一個字那條就從頁面上消失了。
// 改成讀取時映射：簡繁兩種寫法都認，表格不用動，也不怕改到一半斷掉。
// 只映射枚舉列（City/Zone/SubGroup/Category/Status），正文一律不碰——
// 正文要轉繁體得用 OpenCC 整段轉，靠字典逐字替換只會把活動名改壞。
var ENUM_S2T_ = {
  '三藩市湾区': '三藩市灣區', '纽约': '紐約',
  '三藩市市内': '三藩市市內', '湾区市外': '灣區市外', '华人社群活动': '華人社群活動',
  '港岛': '港島', '九龙': '九龍',
  '曼哈顿': '曼哈頓', '布鲁克林 & 皇后': '布魯克林 & 皇后', '外围': '外圍',
  '已核实': '已核實', '场地已核实': '場地已核實', '未核实': '未核實',
  '半岛': '半島', '南湾': '南灣', '东湾': '東灣', '北湾': '北灣',
  '喜剧': '喜劇', '音乐': '音樂', '讲座': '講座', '读书': '讀書',
  '艺术': '藝術', '戏剧': '戲劇', '电影': '電影', '节庆': '節慶',
  '运动': '運動', '亲子': '親子', '农夫市集': '農夫市集'
};
var ENUM_COLUMNS_ = ['City', 'Zone', 'SubGroup', 'Category', 'Status'];

function normalizeEnum_(v) {
  return Object.prototype.hasOwnProperty.call(ENUM_S2T_, v) ? ENUM_S2T_[v] : v;
}

function readAllEvents_() {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_TAB_NAME);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());
  const rows = values.slice(1).filter(r => r[0] !== '' && r[0] !== null && r[0] !== undefined);

  return rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => {
      const val = cellToString_(r[i]);
      obj[h] = ENUM_COLUMNS_.indexOf(h) >= 0 ? normalizeEnum_(val) : val;
    });
    return obj;
  });
  // 期望的列（表頭）：
  // City | WeekId | Zone | SubGroup | Category | Title | DateInfo | Location | Status | PriceInfo | MapLink | Note | Pick
  // City 填 CONFIG.CITIES 裏的 label（如「三藩市灣區」「香港」）
  // Pick 列填任意非空值（建議 ★）= 標記為「給你挑的」，會在頁面上高亮
}

// 只返回該城市有數據的期次。城市之間的期次互相獨立，
// 三藩市出了新一期不會讓香港的頁面跳到一個空的日期上。
function getSortedWeekIds_(data, city) {
  const rows = city ? data.filter(d => d.City === city.label) : data;
  const ids = [...new Set(rows.map(d => d.WeekId))].filter(w => w);
  return ids.sort().reverse(); // 最新的在前
}

// ============================================================
// 渲染整個網頁（含側邊欄歷史週報）
// ============================================================
function renderPage_(data, city, weekIds, selectedWeek) {
  const baseUrl = ScriptApp.getService().getUrl();
  const citySlug = city ? city.slug : '';
  const weekData = data.filter(d => d.City === (city ? city.label : '') && d.WeekId === selectedWeek);

  // 城市切換：普通鏈接，走完整的服務端往返，和期次切換同一套機制。
  // 頁面不生成內容，只呈現已經核實併入庫的內容——所以這裏是篩選器，不是生成按鈕。
  const cityTabsHtml = citiesList_().map(c => {
    const active = c.slug === citySlug ? 'active' : '';
    return `<a class="city-tab ${active}" href="${baseUrl}?city=${encodeURIComponent(c.slug)}">${esc_(c.label)}</a>`;
  }).join('');

  const sidebarHtml = weekIds.map(w => {
    const active = w === selectedWeek ? 'active' : '';
    return `<a class="week-link ${active}" href="${baseUrl}?city=${encodeURIComponent(citySlug)}&week=${encodeURIComponent(w)}">${formatWeekLabel_(w)}</a>`;
  }).join('');

  const zones = (city && city.zones) ? city.zones : [];
  const zonesHtml = zones.map(zone => renderZone_(zone, weekData)).join('');
  // 空狀態：新城市在第一期做出來之前，頁面必須能正常打開並説明情況，
  // 而不是白屏或渲染出一個只有標題的空殼。
  const bodyHtml = zonesHtml || `
    <div class="empty-state">
      <div class="empty-title">${esc_((city && city.label) || '')}還沒有內容</div>
      <div class="empty-note">這個城市的第一期還在整理中。每條活動都要先核實過信源才會出現在這裏。</div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<!-- Apps Script 把頁面裝進沙盒 iframe。站內鏈接若不指定 target，
     點擊會試圖在 iframe 內部加載 script.google.com，而 Google 禁止自己被嵌套，
     結果是「refused to connect」。base target=_top 讓跳轉發生在頂層窗口。
     地圖鏈接自己帶 target="_blank"，顯式 target 覆蓋 base，不受影響。 -->
<base target="_top">
<title>${esc_((city && city.siteTitle) || CONFIG.SITE_TITLE)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${PAGE_CSS_}</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    ${citiesList_().length > 1 ? `<div class="sidebar-title">城市</div>
    <div class="city-tabs">${cityTabsHtml}</div>` : ''}
    <div class="sidebar-title">往期週報</div>
    <div class="week-list">${sidebarHtml}</div>
  </aside>
  <main class="main">
    <header>
      <div class="eyebrow">${esc_((city && city.eyebrow) || '')}</div>
      <h1>${selectedWeek ? formatWeekLabel_(selectedWeek) : esc_((city && city.label) || '')}</h1>
    </header>
    ${selectedWeek ? renderWeather_(city) : ''}
    ${bodyHtml}
  </main>
</div>
</body>
</html>`;
}

function formatWeekLabel_(weekId) {
  // weekId 格式假設為 2026-08-26，轉成"08.26 那一週"
  const s = cellToString_(weekId);
  const parts = s.split('-');
  if (parts.length === 3) return `${parts[1]}.${parts[2]} 那一週`;
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

// 把表格裏的內容轉義後再放進HTML，避免標題裏出現 & < > " 時把頁面弄壞
function esc_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTicket_(item) {
  const statusClass = item.Status === '已核實' ? 'verified'
    : item.Status === '場地已核實' ? 'venue-verified'
    : 'unverified';
  const statusLabel = item.Status || '未核實';
  // 只有真正的 http(s) 鏈接才渲染地圖按鈕，防止表格裏填了微信號之類的內容
  const mapUrl = String(item.MapLink || '').trim();
  const hasMap = /^https?:\/\//i.test(mapUrl);

  // Pick 列非空 = Sarah/Claude 手選的推薦條目，視覺上高亮
  const isPick = String(item.Pick || '').trim() !== '';

  return `
  <div class="ticket${isPick ? ' pick' : ''}">
    <div class="stub">
      <span class="tag">${esc_(item.Category)}</span>
      <span class="date">${esc_(item.DateInfo)}</span>
    </div>
    <div class="details">
      <h3>${esc_(item.Title)}${isPick ? '<span class="pick-badge">給你挑的</span>' : ''}</h3>
      <div class="where">${esc_(item.Location)}</div>
      <div class="meta-row">
        ${item.PriceInfo ? `<span class="pill ${statusClass}">${esc_(item.PriceInfo)}</span>` : ''}
        <span class="status-badge ${statusClass}">${esc_(statusLabel)}</span>
        ${hasMap ? `<a class="map-link" href="${esc_(mapUrl)}" target="_blank" rel="noopener">在地圖中查看 →</a>` : ''}
      </div>
      ${item.Note ? `<div class="note">${esc_(item.Note)}</div>` : ''}
    </div>
  </div>`;
}

// ============================================================
// 頁面樣式（沿用之前"車票風"設計）
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
  .wx{margin:0 0 34px;padding:16px 18px;background:var(--paper);border-radius:4px;
    border:1px solid var(--paper-shadow);}
  .wx-head{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.12em;
    text-transform:uppercase;color:var(--fog-dark);margin-bottom:12px;}
  .wx-row{display:flex;gap:10px;flex-wrap:wrap;}
  .wx-day{flex:1 1 110px;min-width:110px;}
  .wx-label{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--ink);
    letter-spacing:.03em;}
  .wx-temp{font-family:'IBM Plex Mono',monospace;font-size:17px;color:var(--ink);
    margin-top:3px;font-variant-numeric:tabular-nums;}
  .wx-text{font-size:11.5px;color:var(--fog-dark);margin-top:3px;line-height:1.5;}
  .city-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:26px;}
  .city-tab{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:0.04em;
    padding:5px 11px;border:1px solid var(--paper-shadow);border-radius:14px;
    color:var(--fog-dark);text-decoration:none;white-space:nowrap;}
  .city-tab:hover{background:rgba(255,255,255,0.5);}
  .city-tab.active{background:var(--ink);color:#fff;border-color:var(--ink);}
  .empty-state{background:var(--paper);border:1px dashed var(--paper-shadow);
    border-radius:4px;padding:40px 32px;text-align:center;}
  .empty-title{font-family:'Fraunces',Georgia,serif;font-size:20px;color:var(--ink);}
  .empty-note{font-size:13px;color:var(--fog-dark);margin-top:10px;line-height:1.7;}
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
  @media(max-width:700px){
    .layout{flex-direction:column;}
    .sidebar{padding:20px 16px 0;}
    .sidebar-title{margin-top:0;}
    .city-tabs{overflow-x:auto;margin-bottom:16px;}
    .week-list{display:flex;overflow-x:auto;gap:6px;}
    .week-link{white-space:nowrap;margin-bottom:0;}}
`;

// ============================================================
// 發送每週郵件
// ============================================================
// 正式發信：按城市各發一封，每個人只收自己訂閲的城市。
// 一個城市一封而不是把多城市塞進一封，是因為「當期精選前 5 條」這個概念
// 只有在單一城市下才成立；混城市之後讀者要先分辨哪條屬於哪裏，反而更累。
function sendWeeklyEmail() {
  const sent = [];
  citiesList_().forEach(city => {
    const subs = (CONFIG.RECIPIENTS || [])
      .filter(r => r && r.email && (r.cities || []).indexOf(city.slug) !== -1)
      .map(r => r.email);
    if (!subs.length) return;                        // 沒人訂閲這個城市
    if (!sendIssueTo_(subs.join(','), city)) return; // 該城市還沒有任何一期
    sent.push(city.label + ' -> ' + subs.join(', '));
  });
  if (!sent.length) {
    Logger.log('沒有任何郵件被髮出：檢查 CONFIG.RECIPIENTS 的訂閲設置，或該城市是否已有數據');
  } else {
    Logger.log('已發送:\n' + sent.join('\n'));
  }
}

// 預覽：只發到作者本人的郵箱（腳本所有者 + CONFIG.PREVIEW_ALSO）。
// 不會發給 CONFIG.RECIPIENTS 裏的讀者。
// 用途：正式發出前先自己看一眼排版，不用拿讀者當測試。
function previewWeeklyEmail() {
  // 這裏刻意不用 Session.getActiveUser().getEmail()：那需要額外的 OAuth
  // 範圍（讀取賬號郵箱），為一個預覽功能擴大腳本權限不划算。寫死即可。
  const list = (CONFIG.PREVIEW_ALSO || []).filter(Boolean);
  if (!list.length) throw new Error('CONFIG.PREVIEW_ALSO 是空的，沒有預覽地址');
  // 預覽把每個有數據的城市各發一封，一次看完所有城市的排版
  const done = [];
  citiesList_().forEach(city => {
    if (sendIssueTo_(list.join(','), city)) done.push(city.label);
  });
  if (!done.length) throw new Error('沒有任何城市有數據，無可預覽內容');
  Logger.log('預覽郵件已發送至 ' + list.join(', ') +
             '；覆蓋城市: ' + done.join('、') + '（未發給正式收件人）');
}

// 返回 true = 真的發了；false = 該城市還沒有任何一期，什麼也沒發。
// 刻意不發空郵件：一封「本週沒有內容」的郵件對讀者是噪音，
// 而且會讓「收到郵件 = 有新內容」這個約定失效。
function sendIssueTo_(toAddress, city) {
  const data = readAllEvents_();
  const weekIds = getSortedWeekIds_(data, city);
  const latestWeek = weekIds[0];
  if (!latestWeek) return false;

  const weekData = data.filter(d => d.City === city.label && d.WeekId === latestWeek);
  if (!weekData.length) return false;

  const link = CONFIG.SITE_URL + '?city=' + encodeURIComponent(city.slug) +
               '&week=' + encodeURIComponent(latestWeek);
  const label = formatWeekLabel_(latestWeek);
  const cityName = city.mailName || city.label;

  // 優先列出 Pick 標記的條目；不足5條再用其餘的補齊
  const picked = weekData.filter(d => String(d.Pick || '').trim() !== '');
  const rest = weekData.filter(d => String(d.Pick || '').trim() === '');
  const top = picked.concat(rest).slice(0, 5);

  // 注意：主題和正文裏都不要放 emoji。
  // 曾經在主題裏放過一個票券 emoji，收件人那邊是一串問號方塊 —— 非 BMP
  // 字符沒扛過郵件頭編碼。中文是 BMP 內的三字節字符，沒有這個問題。
  const subject = '這周的' + cityName + '，我給你留了幾張票 · ' + label;

  const plainBody = [
    '嘿，',
    '',
    '這周整理了 ' + weekData.length + ' 個活動，先挑幾個給你：',
    '',
    top.map(d => '- ' + d.Title + '（' + d.DateInfo + '｜' + d.Location + '）').join('\n'),
    '',
    '完整清單：' + link,
    '',
    '想你和崽崽。'
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
      這周整理了 ${weekData.length} 個活動，先挑幾個給你 —
    </div>
  </td></tr>

  <tr><td style="padding:20px 30px 0 30px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
  </td></tr>

  <tr><td align="center" style="padding:26px 30px 8px 30px;">
    <a href="${esc_(link)}" style="display:inline-block;background:#a94e29;color:#ffffff;
      font-family:Georgia,serif;font-size:15px;padding:12px 30px;border-radius:24px;
      text-decoration:none;">查看完整 ${esc_(String(weekData.length))} 條 &rarr;</a>
  </td></tr>

  <tr><td style="padding:18px 30px 30px 30px;">
    <div style="border-top:1px dashed #c4baa4;padding-top:16px;
      font-family:Georgia,serif;font-size:14px;color:#8a8578;">想你和崽崽。</div>
  </td></tr>

</table>
</td></tr>
</table>`;

  GmailApp.sendEmail(toAddress, subject, plainBody, {
    htmlBody: htmlBody,
    name: CONFIG.SENDER_NAME
  });
  return true;
}

// 郵件裏的單條活動，做成和網頁一致的「車票存根」樣式。
// 郵件客户端對 flex/grid 支持很差，這裏一律用 table + 內聯樣式。
function renderMailItem_(d) {
  const isPick = String(d.Pick || '').trim() !== '';
  const accent = isPick ? '#b8860b' : '#c4baa4';
  const status = String(d.Status || '').trim();
  const statusColor = status === '已核實' ? '#4a7c59'
    : status === '場地已核實' ? '#7a8f6b'
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
          ${esc_(d.Title)}${isPick ? ' <span style="font-family:\'Courier New\',monospace;font-size:9px;color:#ffffff;background:#b8860b;padding:2px 6px;border-radius:9px;">給你挑的</span>' : ''}
        </div>
        <div style="font-family:'Courier New',monospace;font-size:11px;color:#7a7365;padding-top:5px;">
          ${esc_(d.Location)}
        </div>
        <div style="padding-top:7px;">
          ${d.PriceInfo ? `<span style="font-family:Georgia,serif;font-size:11px;color:#5a5449;">${esc_(d.PriceInfo)}</span>&nbsp;&nbsp;` : ''}
          <span style="font-family:'Courier New',monospace;font-size:10px;color:${statusColor};
            border:1px solid ${statusColor};padding:1px 5px;">${esc_(status || '未核實')}</span>
        </div>
      </td>
    </tr>
  </table>
</td></tr>`;
}


// ============================================================
// 一次性設置：每週三上午9點自動發郵件
// 手動運行這個函數一次即可，之後不用再管
// ============================================================
function createWeeklyTrigger() {
  // 先清掉舊的同名觸發器，避免重複
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

  Logger.log('已設置：每週三上午9點自動發送郵件');
}
