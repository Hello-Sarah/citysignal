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
      // 加入日曆用：StartAt / EndAt 填的是當地「牆上時間」，按這個時區解讀
      tz: 'America/Los_Angeles',
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
      tz: 'Asia/Hong_Kong',
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
  SITE_TITLE: '本地活動週報',

  // ---- 每週新一期從哪裏來 ----
  // 雲端任務每週一整理好下一期，以 PR 的形式提交到 GitHub 的 data/issues/<WeekId>.tsv。
  // 作者在 GitHub 上點 Merge = 審核通過。發信前這裏會把「已合併、日期已到、表格裏還沒有」的期次寫進表格。
  // 沒合併的 PR 不會出現在 main 上，所以不會被導入——審核這一步不能被繞過。
  ISSUES_SOURCE: {
    api: 'https://api.github.com/repos/Hello-Sarah/citysignal/contents/data/issues',
    raw: 'https://raw.githubusercontent.com/Hello-Sarah/citysignal/main/data/issues/'
  },

  // ---- 暫停期次 ----
  // 某幾週沒出刊時，在這裏登記。頁面側邊欄會把這幾週列出來並標「暫停」，
  // 恢復後的第一期頂部會寫明暫停了多久、為什麼。
  // 不登記的話，側邊欄只是少了幾個日期——看的人分不清是暫停還是停更了。
  // weeks 填該城市「本該出刊」的週三日期；reason / reasonEn 會原樣顯示在頁面上。
  PAUSES: [
    { city: 'sf', weeks: ['2026-09-09', '2026-09-16', '2026-09-23'],
      reason: '編輯出差', reasonEn: 'the editor was travelling for work' },
    { city: 'hk', weeks: ['2026-09-16', '2026-09-23'],
      reason: '編輯出差', reasonEn: 'the editor was travelling for work' }
  ]
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

  // ?ics=1&city=sf&week=2026-09-30&n=3 → 下載單條活動的 .ics，給蘋果日曆 / Outlook 用
  if (param.ics) return icsResponse_(data, city, param.week, param.n);

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

// StartAt / EndAt 是帶時分的「牆上時間」。Sheets 會把 2026-10-02 13:00 識別成日期時間，
// getValues() 返回 Date；這兩列必須按表格自己的時區格式化並保留時分，
// 否則 13:00 會被抹成當天零點、或被換算到別的時區。
var TIME_COLUMNS_ = ['StartAt', 'EndAt'];

function timeCellToString_(v, ssTz) {
  if (Object.prototype.toString.call(v) !== '[object Date]') return cellToString_(v);
  const hasTime = v.getHours() || v.getMinutes();
  return Utilities.formatDate(v, ssTz, hasTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
}

function readAllEvents_() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_TAB_NAME);
  let ssTz = null;
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());
  const rows = values.slice(1).filter(r => r[0] !== '' && r[0] !== null && r[0] !== undefined);

  return rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => {
      if (TIME_COLUMNS_.indexOf(h) >= 0) {
        if (!ssTz) ssTz = ss.getSpreadsheetTimeZone();
        obj[h] = timeCellToString_(r[i], ssTz);
        return;
      }
      const val = cellToString_(r[i]);
      obj[h] = ENUM_COLUMNS_.indexOf(h) >= 0 ? normalizeEnum_(val) : val;
    });
    return obj;
  });
  // 期望的列（表頭）：
  // City | WeekId | Zone | SubGroup | Category | Title | DateInfo | Location | Status | PriceInfo | MapLink | Note | Pick | StartAt | EndAt
  // StartAt / EndAt 選填：填了才出「加入日曆」按鈕。格式 2026-10-02 13:00（定時）或 2026-10-02（全天）
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
// 暫停期次
// ============================================================
// 返回 { weekId: pause } —— 該城市登記過的暫停週。
// 已經有數據的週不算暫停（數據優先，防止登記錯了把真實的一期蓋掉）。
function pausedWeeksFor_(city, weekIds) {
  const map = {};
  if (!city) return map;
  (CONFIG.PAUSES || []).forEach(p => {
    if (!p || p.city !== city.slug) return;
    (p.weeks || []).forEach(w => {
      if (w && weekIds.indexOf(w) === -1) map[w] = p;
    });
  });
  return map;
}

// 恢復後的第一期：找出「上一期」和「這一期」之間所有登記過的暫停週，
// 在頁面頂部寫明。只在緊接暫停的那一期顯示，更早或更晚的期次不打擾。
function renderPauseNotice_(selectedWeek, weekIds, paused) {
  if (!selectedWeek) return '';
  const idx = weekIds.indexOf(selectedWeek);
  const prev = weekIds[idx + 1] || '';            // weekIds 是新→舊
  const gap = Object.keys(paused)
    .filter(w => w < selectedWeek && w > prev)
    .sort();
  if (!gap.length) return '';

  const p = paused[gap[gap.length - 1]];
  const md = w => { const s = w.split('-'); return s[1] + '.' + s[2]; };
  const range = gap.length === 1 ? md(gap[0]) : md(gap[0]) + '–' + md(gap[gap.length - 1]);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const en = w => { const s = w.split('-'); return months[Number(s[1]) - 1] + ' ' + Number(s[2]); };
  const rangeEn = gap.length === 1 ? en(gap[0]) : en(gap[0]) + ' – ' + en(gap[gap.length - 1]);
  const n = gap.length;

  return `
  <div class="pause-notice">
    <div class="pause-zh">${esc_(range)}（共 ${n} 期）因${esc_(p.reason || '')}暫停更新，本期起恢復每週更新。</div>
    <div class="pause-en">Paused ${esc_(rangeEn)} (${n} issue${n > 1 ? 's' : ''})${p.reasonEn ? ' while ' + esc_(p.reasonEn) : ''}. Weekly updates resume with this issue.</div>
  </div>`;
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

  // 側邊欄：已出刊的期次 + 登記過的暫停週，按日期混排（新→舊）。
  // 暫停週不是鏈接——那一週沒有內容可看，但要讓人看見「這裏是暫停，不是斷更」。
  const paused = pausedWeeksFor_(city, weekIds);
  const allWeeks = weekIds.concat(Object.keys(paused)).sort().reverse();
  const sidebarHtml = allWeeks.map(w => {
    if (paused[w]) {
      return `<span class="week-link paused" title="${esc_(paused[w].reason || '')}">${formatWeekLabel_(w)}<span class="paused-tag">暫停</span></span>`;
    }
    const active = w === selectedWeek ? 'active' : '';
    return `<a class="week-link ${active}" href="${baseUrl}?city=${encodeURIComponent(citySlug)}&week=${encodeURIComponent(w)}">${formatWeekLabel_(w)}</a>`;
  }).join('');

  const zones = (city && city.zones) ? city.zones : [];
  // 給每條活動一個期內序號（按表格順序），.ics 下載鏈接靠它定位是哪一條
  weekData.forEach((d, i) => { d.__n = i; });
  const ctx = { city: city, week: selectedWeek, baseUrl: baseUrl };
  const zonesHtml = zones.map(zone => renderZone_(zone, weekData, ctx)).join('');
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
    ${renderPauseNotice_(selectedWeek, weekIds, paused)}
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

function renderZone_(zoneName, weekData, ctx) {
  const zoneItems = weekData.filter(d => d.Zone === zoneName);
  if (zoneItems.length === 0) return '';

  const subGroups = [...new Set(zoneItems.map(d => d.SubGroup || ''))];

  const groupsHtml = subGroups.map(sg => {
    const items = zoneItems.filter(d => (d.SubGroup || '') === sg);
    const itemsHtml = items.map(it => renderTicket_(it, ctx)).join('');
    return `${sg ? `<div class="section-title">${esc_(sg)}</div>` : ''}${itemsHtml}`;
  }).join('');

  return `
  <div class="zone-title"><h2>${esc_(zoneName)}</h2></div>
  <div class="zone-rule"></div>
  ${groupsHtml}`;
}

// ============================================================
// 加入日曆
// ============================================================
// 兩種入口：
//  - Google 日曆：拼一個模板鏈接，點開就是預填好的「新建活動」頁
//  - .ics 下載：蘋果日曆、Outlook、手機自帶日曆都認。走 doGet(?ics=1...) 動態生成
// 只有填了 StartAt 的條目才出按鈕。長期展覽、餐廳、每週固定的市集刻意不填——
// 往日曆裏塞一個橫跨四個月的「活動」對誰都沒用。
//
// 時間一律按城市時區的「牆上時間」處理（Google 鏈接帶 ctz，.ics 帶 TZID），
// 不在這裏做 UTC 換算：換算要依賴運行環境的時區庫，而牆上時間本身就是表格裏寫的那個意思。

// '2026-10-02 13:00' / '2026-10-02T13:00' / '2026-10-02' → { ymd:'20261002', hm:'1300' | '' }
function parseWall_(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  return { ymd: m[1] + m[2] + m[3], hm: m[4] !== undefined ? ('0' + m[4]).slice(-2) + m[5] : '' };
}

// 日期 + n 天（純字符串運算，避開時區）
function addDays_(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return d.getUTCFullYear() + ('0' + (d.getUTCMonth() + 1)).slice(-2) + ('0' + d.getUTCDate()).slice(-2);
}

// 返回 null = 這條不出日曆按鈕
function calendarEvent_(item, city) {
  const s = parseWall_(item.StartAt);
  if (!s) return null;
  const e = parseWall_(item.EndAt);
  let start, end, allDay;
  if (!s.hm) {
    // 全天：EndAt 是「最後一天」（含），日曆格式要的是不含的結束日，所以 +1
    allDay = true;
    start = s.ymd;
    end = addDays_(e && !e.hm ? e.ymd : s.ymd, 1);
  } else {
    allDay = false;
    start = s.ymd + 'T' + s.hm + '00';
    if (e && e.hm) {
      end = e.ymd + 'T' + e.hm + '00';
    } else {
      // 沒寫結束時間：默認兩小時
      const h = +s.hm.slice(0, 2) + 2;
      end = (h >= 24 ? addDays_(s.ymd, 1) : s.ymd) + 'T' + ('0' + (h % 24)).slice(-2) + s.hm.slice(2) + '00';
    }
    if (end <= start) return null;   // 填反了就不出按鈕，不生成一個錯的日曆項
  }
  const details = [item.DateInfo, item.PriceInfo, item.Note].filter(Boolean).join('\n');
  return {
    title: item.Title, location: item.Location || '', details: details,
    start: start, end: end, allDay: allDay, tz: (city && city.tz) || 'UTC'
  };
}

function gcalUrl_(ev) {
  const q = [
    'action=TEMPLATE',
    'text=' + encodeURIComponent(ev.title),
    'dates=' + ev.start + '/' + ev.end,
    'details=' + encodeURIComponent(ev.details),
    'location=' + encodeURIComponent(ev.location)
  ];
  if (!ev.allDay) q.push('ctz=' + encodeURIComponent(ev.tz));
  return 'https://calendar.google.com/calendar/render?' + q.join('&');
}

function icsEscape_(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC 5545：每行最多 75 個字節，超出要折行（下一行以空格開頭）。按 UTF-8 字節切，不切斷中文字符。
function icsFold_(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = unescape(encodeURIComponent(ch)).length;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function buildIcs_(ev, uid) {
  const now = new Date();
  const stamp = now.getUTCFullYear() + ('0' + (now.getUTCMonth() + 1)).slice(-2) + ('0' + now.getUTCDate()).slice(-2) +
    'T' + ('0' + now.getUTCHours()).slice(-2) + ('0' + now.getUTCMinutes()).slice(-2) + '00Z';
  const dt = ev.allDay
    ? ['DTSTART;VALUE=DATE:' + ev.start, 'DTEND;VALUE=DATE:' + ev.end]
    : ['DTSTART;TZID=' + ev.tz + ':' + ev.start, 'DTEND;TZID=' + ev.tz + ':' + ev.end];
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CitySignal//Local Events Digest//ZH', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + stamp
  ].concat(dt).concat([
    'SUMMARY:' + icsEscape_(ev.title),
    'LOCATION:' + icsEscape_(ev.location),
    'DESCRIPTION:' + icsEscape_(ev.details),
    'END:VEVENT', 'END:VCALENDAR'
  ]).map(icsFold_).join('\r\n') + '\r\n';
}

function icsUrl_(ctx, n) {
  return ctx.baseUrl + '?ics=1&city=' + encodeURIComponent(ctx.city.slug) +
    '&week=' + encodeURIComponent(ctx.week) + '&n=' + n;
}

function renderCalendarLinks_(item, ctx) {
  if (!ctx || !ctx.city) return '';
  const ev = calendarEvent_(item, ctx.city);
  if (!ev) return '';
  return `
      <div class="cal-row">
        <span class="cal-label">加入日曆</span>
        <a class="cal-link" href="${esc_(gcalUrl_(ev))}" target="_blank" rel="noopener">Google</a>
        <a class="cal-link" href="${esc_(icsUrl_(ctx, item.__n))}" target="_blank" rel="noopener">蘋果 / Outlook（.ics）</a>
      </div>`;
}

function icsResponse_(data, city, week, n) {
  const weekData = data.filter(d => d.City === city.label && d.WeekId === String(week || ''));
  const item = weekData[Number(n)];
  const ev = item ? calendarEvent_(item, city) : null;
  if (!ev) {
    return ContentService.createTextOutput('找不到這條活動，或它沒有填開始時間。')
      .setMimeType(ContentService.MimeType.TEXT);
  }
  const uid = city.slug + '-' + week + '-' + n + '@citysignal';
  return ContentService.createTextOutput(buildIcs_(ev, uid))
    .setMimeType(ContentService.MimeType.ICAL)
    .downloadAsFile('event-' + city.slug + '-' + week + '-' + n + '.ics');
}

// 把表格裏的內容轉義後再放進HTML，避免標題裏出現 & < > " 時把頁面弄壞
function esc_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTicket_(item, ctx) {
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
      ${renderCalendarLinks_(item, ctx)}
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
  .week-link.paused{color:var(--fog-dark);opacity:.75;cursor:default;}
  .week-link.paused:hover{background:none;}
  .paused-tag{margin-left:6px;font-size:10px;padding:1px 5px;border-radius:8px;
    border:1px solid var(--fog-dark);vertical-align:1px;}
  .pause-notice{margin:-12px 0 26px;padding:12px 16px;background:rgba(242,236,220,.7);
    border-left:3px solid var(--gold);border-radius:3px;font-size:13px;line-height:1.6;}
  .pause-en{color:var(--fog-dark);font-size:12px;margin-top:2px;}
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
  .cal-row{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
  .cal-label{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--fog-dark);}
  .cal-link{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--ink);text-decoration:none;
    padding:2px 9px;border:1px solid var(--paper-shadow);border-radius:12px;background:rgba(255,255,255,.35);}
  .cal-link:hover{background:#fff;}
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
  // 先把 GitHub 上已審核的新一期導入表格。導入失敗不影響發信（最多就是沒有新一期，什麼也不發）
  try {
    const got = importApprovedIssues_();
    if (got.length) Logger.log('已從 GitHub 導入:\n' + got.join('\n'));
  } catch (err) {
    Logger.log('導入 GitHub 期次失敗：' + err);
  }
  const sent = [];
  citiesList_().forEach(city => {
    const subs = (CONFIG.RECIPIENTS || [])
      .filter(r => r && r.email && (r.cities || []).indexOf(city.slug) !== -1)
      .map(r => r.email);
    if (!subs.length) return;                        // 沒人訂閲這個城市

    // 同一期只發一次。以前每週三都發「最新一期」，停刊期間讀者會反覆收到同一封舊郵件。
    // 發信記錄寫在 Sheet 的 SentLog 分頁：不用 PropertiesService，是因為那要多申請一個
    // OAuth 範圍，重新授權之前觸發器會直接失敗——而 Sheet 的寫權限本來就有。
    const latest = getSortedWeekIds_(readAllEvents_(), city)[0];
    let last = '';
    try { last = lastSentWeek_(city); } catch (err) {
      Logger.log('讀取發信記錄失敗，照舊發送：' + err);   // 寧可多發一封，不能漏發
    }
    if (latest && last && latest <= last) {
      Logger.log(city.label + '：' + latest + ' 已經發過，本週不重發');
      return;
    }

    const week = sendIssueTo_(subs.join(','), city);
    if (!week) return;                               // 該城市還沒有任何一期
    try { recordSent_(city, week); } catch (err) {
      Logger.log('寫發信記錄失敗（郵件已發出）：' + err);
    }
    sent.push(city.label + ' ' + week + ' -> ' + subs.join(', '));
  });
  if (!sent.length) {
    Logger.log('沒有任何郵件被髮出：檢查 CONFIG.RECIPIENTS 的訂閲設置，或該城市是否已有數據');
  } else {
    Logger.log('已發送:\n' + sent.join('\n'));
  }
}

// ============================================================
// 從 GitHub 導入已審核的期次
// ============================================================
// 規則：
//  1. 只看 main 分支上 data/issues/ 裏名為 YYYY-MM-DD.tsv 的文件（= 已合併的 PR）
//  2. 只導入日期 <= 今天的：提前合併的下下期不會被當成「最新一期」提前發出去
//  3. 某城市某期在表格裏已經有任何一行 → 整期跳過，不重複寫入，也不覆蓋人工改過的內容
//  4. 按表頭名對列，不依賴列順序；以 = + @ 開頭的值加單引號，防止被 Sheets 當公式執行
function importApprovedIssues_() {
  const src = CONFIG.ISSUES_SOURCE;
  if (!src || !src.api || !src.raw) return [];
  const opts = { muteHttpExceptions: true, headers: { 'User-Agent': 'CitySignal weekly digest' } };
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const list = UrlFetchApp.fetch(src.api, opts);
  if (list.getResponseCode() !== 200) return [];
  const weeks = JSON.parse(list.getContentText())
    .map(f => String(f.name || ''))
    .filter(n => /^\d{4}-\d{2}-\d{2}\.tsv$/.test(n))
    .map(n => n.slice(0, 10))
    .filter(w => w <= today)
    .sort();
  if (!weeks.length) return [];

  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_TAB_NAME);
  const sheetHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const have = {};
  readAllEvents_().forEach(d => { have[d.City + '|' + d.WeekId] = true; });

  const done = [];
  weeks.forEach(week => {
    const res = UrlFetchApp.fetch(src.raw + week + '.tsv', opts);
    if (res.getResponseCode() !== 200) return;
    const lines = res.getContentText().replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (lines.length < 2) return;
    const head = lines[0].split('\t').map(h => h.trim());
    const byCity = {};
    lines.slice(1).forEach(line => {
      const cells = line.split('\t');
      const o = {};
      head.forEach((h, i) => { o[h] = (cells[i] || '').trim(); });
      if (o.WeekId !== week || !o.City || !o.Title) return;   // 文件名和內容對不上的行不收
      const key = normalizeEnum_(o.City) + '|' + week;
      if (have[key]) return;
      (byCity[key] = byCity[key] || []).push(sheetHeaders.map(h => {
        const v = o[h] === undefined ? '' : o[h];
        return /^[=+@]/.test(v) ? "'" + v : v;
      }));
    });
    Object.keys(byCity).forEach(key => {
      const rows = byCity[key];
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, sheetHeaders.length).setValues(rows);
      have[key] = true;
      done.push(key.replace('|', ' ') + '（' + rows.length + ' 條）');
    });
  });
  return done;
}

// 手動導入：不想等週三，合併 PR 後想立刻在網頁上看到，就在編輯器裏運行這個。不發信。
function importIssuesNow() {
  const got = importApprovedIssues_();
  Logger.log(got.length ? '已導入:\n' + got.join('\n') : '沒有需要導入的新期次');
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

// ---- 發信記錄（SentLog 分頁）----
// 只記城市 slug、期次、時間，不記收件人地址。預覽不記錄。
var SENT_LOG_TAB_ = 'SentLog';

function sentLogSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sh = ss.getSheetByName(SENT_LOG_TAB_);
  if (!sh) {
    sh = ss.insertSheet(SENT_LOG_TAB_);
    sh.appendRow(['City', 'WeekId', 'SentAt']);
  }
  return sh;
}

function lastSentWeek_(city) {
  const rows = sentLogSheet_().getDataRange().getValues().slice(1);
  const weeks = rows
    .filter(r => cellToString_(r[0]) === city.slug)
    .map(r => cellToString_(r[1]))
    .filter(w => w);
  return weeks.sort().pop() || '';
}

function recordSent_(city, week) {
  sentLogSheet_().appendRow([city.slug, week, new Date()]);
}

// 返回發出的期次（如 '2026-09-30'）；false = 該城市還沒有任何一期，什麼也沒發。
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
  return latestWeek;
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
