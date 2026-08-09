const DEFAULT_WEIGHTS = {
  streak: 25,
  billboard: 25,
  heat: 20,
  capital: 15,
  turnover: 10,
  sealTime: 5,
  sentiment: 5,
};

const FACTOR_LABELS = {
  streak: "连板强度",
  billboard: "龙虎榜净买入",
  heat: "概念/板块热度",
  capital: "封单资金",
  turnover: "换手质量",
  sealTime: "封板时间",
  sentiment: "市场情绪",
};

const state = {
  data: null,
  scored: [],
  weights: loadJson("zt-workbench-weights", DEFAULT_WEIGHTS),
  watchlist: new Set(loadJson("zt-workbench-watchlist", [])),
  scoreFilter: "all",
  search: "",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function loadJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(raw) {
  const value = String(raw);
  return `${value.slice(0, 4)}.${value.slice(4, 6)}.${value.slice(6, 8)}`;
}

function formatMoney(value, signed = false) {
  const number = Number(value || 0);
  const sign = signed && number > 0 ? "+" : "";
  const absolute = Math.abs(number);
  if (absolute >= 1e12) return `${sign}${(number / 1e12).toFixed(2)}万亿`;
  if (absolute >= 1e8) return `${sign}${(number / 1e8).toFixed(2)}亿`;
  if (absolute >= 1e4) return `${sign}${(number / 1e4).toFixed(0)}万`;
  return `${sign}${number.toFixed(0)}`;
}

function formatTime(raw) {
  const text = String(raw || 0).padStart(6, "0");
  return `${text.slice(0, 2)}:${text.slice(2, 4)}`;
}

function timeToMinutes(raw) {
  const text = String(raw || 150000).padStart(6, "0");
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(2, 4));
}

function marketSentiment(data = state.data) {
  const market = data.market;
  const breadth = clamp(40 + (market.limitUpCount - market.limitDownCount) * 0.8);
  return clamp(market.sealSuccessRate * 0.55 + breadth * 0.45);
}

function scoreStock(stock) {
  const maxSectorCount = Math.max(1, ...state.data.sectorRank.map((sector) => sector.count));
  const sectorCount = state.data.sectorRank.find((sector) => sector.name === stock.sector)?.count ?? 1;
  const streakScore = clamp(28 + (stock.streak - 1) * 22 + Math.min(stock.limitStats?.ct ?? 1, 4) * 5);
  const billboardScore = stock.billboard
    ? clamp(50 + Math.tanh(stock.billboard.netBuy / 50_000_000) * 45)
    : 50;
  const heatScore = maxSectorCount === 1 ? 55 : clamp(42 + ((sectorCount - 1) / (maxSectorCount - 1)) * 58);
  const sealedRatio = stock.floatMarketCap ? stock.sealedAmount / stock.floatMarketCap : 0;
  const capitalScore = clamp(32 + sealedRatio * 4200);
  const turnoverScore = clamp(100 - Math.abs(stock.turnoverRate - 10) * 4.2, 30, 100);
  const sealMinutes = timeToMinutes(stock.firstLimitTime);
  const sealTimeScore = clamp(100 - Math.max(0, sealMinutes - 565) * 0.3, 24, 100);
  const sentimentScore = marketSentiment();
  const factors = { streak: streakScore, billboard: billboardScore, heat: heatScore, capital: capitalScore, turnover: turnoverScore, sealTime: sealTimeScore, sentiment: sentimentScore };
  const totalWeight = Object.values(state.weights).reduce((sum, value) => sum + Number(value), 0) || 1;
  const score = Object.entries(factors).reduce((sum, [key, value]) => sum + value * (Number(state.weights[key]) / totalWeight), 0);
  return { ...stock, score, factors, sectorCount };
}

function recomputeScores() {
  state.scored = state.data.stocks.map(scoreStock).sort((a, b) => b.score - a.score || b.streak - a.streak || b.sealedAmount - a.sealedAmount);
}

function stockCard(stock, index) {
  const saved = state.watchlist.has(stock.code);
  return `
    <article class="stock-card ${index < 3 ? "top-three" : ""}" data-stock="${stock.code}" role="button" tabindex="0">
      <span class="rank-number">${String(index + 1).padStart(2, "0")}</span>
      <div class="stock-main">
        <div class="stock-title"><strong>${escapeHtml(stock.name)}</strong><span class="stock-code">${stock.code}</span></div>
        <div class="stock-meta"><span class="tag">${escapeHtml(stock.sector)}</span>${stock.streak > 1 ? `<span class="tag streak">${stock.streak}连板</span>` : ""}<span class="tag">封板 ${formatTime(stock.firstLimitTime)}</span></div>
      </div>
      <div class="score-block"><strong>${Math.round(stock.score)}</strong><span>强度值</span></div>
      <button class="watch-button ${saved ? "saved" : ""}" data-watch="${stock.code}" aria-label="${saved ? "移出" : "加入"}观察">${saved ? "★" : "☆"}</button>
    </article>`;
}

function renderMarket() {
  const market = state.data.market;
  $("#tradeDate").textContent = `${formatDate(state.data.meta.tradeDate)} 收盘`;
  $("#updatedAt").textContent = `数据截至 ${formatDate(state.data.meta.tradeDate)}`;
  $("#indexStrip").innerHTML = market.indices.map((index) => `
    <article class="index-card">
      <span>${escapeHtml(index.f14)}</span>
      <strong>${Number(index.f2).toFixed(2)}</strong>
      <em class="${index.f3 >= 0 ? "rise" : "fall"}">${index.f3 >= 0 ? "+" : ""}${Number(index.f3).toFixed(2)}%</em>
    </article>`).join("");
  const trackedTurnover = market.indices.slice(0, 2).reduce((sum, item) => sum + Number(item.f6 || 0), 0);
  $("#metricGrid").innerHTML = [
    [market.limitUpCount, "涨停"],
    [market.limitDownCount, "跌停"],
    [market.brokenBoardCount, "炸板"],
    [formatMoney(trackedTurnover), "沪深成交"],
  ].map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
  const sentiment = marketSentiment();
  $("#sentimentScore").textContent = Math.round(sentiment);
  $("#sentimentText").textContent = sentiment >= 80 ? "情绪偏热，关注高位分化与封板质量" : sentiment >= 65 ? "情绪偏强，结构性机会较集中" : "情绪中性或偏弱，注意节奏与回撤";
  $("#sentimentRing").style.strokeDashoffset = String(301.59 * (1 - sentiment / 100));
  $("#sealRate").textContent = `${market.sealSuccessRate.toFixed(1)}%`;
}

function renderFeatured() {
  $("#featuredStocks").innerHTML = state.scored.slice(0, 5).map(stockCard).join("");
}

function filteredStocks() {
  const query = state.search.trim().toLowerCase();
  return state.scored.filter((stock) => {
    const matchesText = !query || `${stock.name}${stock.code}${stock.sector}`.toLowerCase().includes(query);
    const score = stock.score;
    const matchesScore = state.scoreFilter === "all"
      || (state.scoreFilter === "90" && score >= 90)
      || (state.scoreFilter === "85" && score >= 85 && score < 90)
      || (state.scoreFilter === "80" && score >= 80 && score < 85)
      || (state.scoreFilter === "streak" && stock.streak > 1);
    return matchesText && matchesScore;
  });
}

function renderScores() {
  const stocks = filteredStocks();
  $("#rankSummary").textContent = `共 ${stocks.length} 只 · 评分为强度值，不是上涨概率`;
  $("#allStocks").innerHTML = stocks.length
    ? stocks.map(stockCard).join("")
    : `<div class="empty-state"><span>⌕</span><h3>没有匹配结果</h3><p>换个筛选条件再看看。</p></div>`;
}

function renderSectors() {
  $("#conceptList").innerHTML = state.data.concepts.slice(0, 10).map((sector, index) => `
    <div class="sector-row">
      <span class="sector-rank">${String(index + 1).padStart(2, "0")}</span>
      <div class="sector-name"><strong>${escapeHtml(sector.name)}</strong><span>${sector.code}</span></div>
      <div class="sector-value"><strong>+${Number(sector.changePercent).toFixed(2)}%</strong><span>${formatMoney(sector.mainNetInflow, true)}</span></div>
    </div>`).join("");
  const breadth = state.data.sectorRank.slice(0, 10);
  const max = Math.max(1, ...breadth.map((sector) => sector.count));
  $("#breadthChart").innerHTML = breadth.map((sector) => `
    <div class="bar-row"><span>${escapeHtml(sector.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${(sector.count / max) * 100}%"></div></div><strong>${sector.count}</strong></div>`).join("");
}

function renderWatchlist() {
  const watched = state.scored.filter((stock) => state.watchlist.has(stock.code));
  $("#watchlistEmpty").hidden = watched.length > 0;
  $("#watchlistStocks").innerHTML = watched.map(stockCard).join("");
}

function renderWeights() {
  $("#weightControls").innerHTML = Object.entries(FACTOR_LABELS).map(([key, label]) => `
    <div class="weight-row">
      <label for="weight-${key}">${label}</label>
      <input id="weight-${key}" type="range" min="0" max="40" step="1" value="${state.weights[key]}" data-weight="${key}" />
      <output>${state.weights[key]}%</output>
    </div>`).join("");
}

function renderAll() {
  recomputeScores();
  renderMarket();
  renderFeatured();
  renderScores();
  renderSectors();
  renderWatchlist();
  renderWeights();
}

function openStock(code) {
  const stock = state.scored.find((item) => item.code === code);
  if (!stock) return;
  const netBuy = stock.billboard ? formatMoney(stock.billboard.netBuy, true) : "未上榜";
  $("#stockSheetContent").innerHTML = `
    <div class="sheet-stock-head">
      <div><p>${stock.code} · ${escapeHtml(stock.sector)}</p><h2>${escapeHtml(stock.name)}</h2><p>${stock.streak} 连板 · 收盘 ¥${stock.price.toFixed(2)}</p></div>
      <div class="sheet-score"><strong>${Math.round(stock.score)}</strong><span>涨停强度值</span></div>
    </div>
    <div class="evidence-grid">
      <div class="evidence"><span>龙虎榜净额</span><strong>${netBuy}</strong></div>
      <div class="evidence"><span>封单金额</span><strong>${formatMoney(stock.sealedAmount)}</strong></div>
      <div class="evidence"><span>换手率</span><strong>${stock.turnoverRate.toFixed(2)}%</strong></div>
      <div class="evidence"><span>首次封板</span><strong>${formatTime(stock.firstLimitTime)}</strong></div>
      <div class="evidence"><span>炸板次数</span><strong>${stock.brokenCount}</strong></div>
      <div class="evidence"><span>近 ${stock.limitStats?.days ?? 1} 日涨停</span><strong>${stock.limitStats?.ct ?? 1} 次</strong></div>
    </div>
    <div class="factor-list">${Object.entries(stock.factors).map(([key, value]) => `
      <div class="factor-row"><label>${FACTOR_LABELS[key]}</label><div class="bar-track"><div class="bar-fill" style="width:${value}%"></div></div><strong>${Math.round(value)}</strong></div>`).join("")}</div>
    <p class="sheet-disclaimer">强度值依据当日收盘后的七类数据计算，仅用于横向比较涨停结构，不表达次日方向或收益承诺。</p>`;
  openSheet($("#stockSheet"));
}

function openSheet(sheet) {
  $("#sheetBackdrop").hidden = false;
  sheet.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => sheet.classList.add("open"));
  document.body.style.overflow = "hidden";
}

function closeSheets() {
  $$(".bottom-sheet.open").forEach((sheet) => {
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
  });
  setTimeout(() => { $("#sheetBackdrop").hidden = true; }, 260);
  document.body.style.overflow = "";
}

function toggleWatch(code) {
  state.watchlist.has(code) ? state.watchlist.delete(code) : state.watchlist.add(code);
  localStorage.setItem("zt-workbench-watchlist", JSON.stringify([...state.watchlist]));
  renderFeatured();
  renderScores();
  renderWatchlist();
  showToast(state.watchlist.has(code) ? "已加入我的观察" : "已移出我的观察");
}

function switchTab(tab) {
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tab));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

let toastTimer;
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function jsonp(url, timeout = 12000, callbackParam = "cb") {
  return new Promise((resolve, reject) => {
    const callback = `__ztCallback${Date.now()}${Math.random().toString(16).slice(2)}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => cleanup(new Error("请求超时")), timeout);
    const cleanup = (error, value) => {
      clearTimeout(timer);
      script.remove();
      delete window[callback];
      error ? reject(error) : resolve(value);
    };
    window[callback] = (value) => cleanup(null, value);
    script.onerror = () => cleanup(new Error("网络请求失败"));
    script.src = `${url}${url.includes("?") ? "&" : "?"}${callbackParam}=${callback}`;
    document.head.appendChild(script);
  });
}

function dateCandidates() {
  const list = [];
  const now = new Date();
  for (let offset = 0; offset < 10; offset += 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - offset);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    list.push(`${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, "0")}${String(day.getDate()).padStart(2, "0")}`);
  }
  return list;
}

async function findLatestPool() {
  const token = "7eea3edcaed734bea9cbfc24409ed989";
  for (const date of dateCandidates()) {
    try {
      const data = await jsonp(`https://push2ex.eastmoney.com/getTopicZTPool?ut=${token}&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt%3Aasc&date=${date}`);
      if (data?.data?.pool?.length) return { date, token, data };
    } catch { /* try prior trading day */ }
  }
  throw new Error("未找到最近交易日行情");
}

function normalizeLiveStock(stock, billboardByCode = new Map()) {
  return {
    code: stock.c,
    market: stock.m,
    name: stock.n,
    price: stock.p / 1000,
    changePercent: stock.zdp,
    amount: stock.amount,
    floatMarketCap: stock.ltsz,
    turnoverRate: stock.hs,
    streak: stock.lbc,
    firstLimitTime: stock.fbt,
    lastLimitTime: stock.lbt,
    sealedAmount: stock.fund,
    brokenCount: stock.zbc,
    sector: stock.hybk,
    limitStats: stock.zttj,
    billboard: billboardByCode.get(stock.c) ?? null,
  };
}

function groupBillboard(rows = []) {
  const grouped = new Map();
  rows.forEach((row) => {
    const current = grouped.get(row.SECURITY_CODE) ?? { netBuy: 0, buyAmount: 0, sellAmount: 0, explanations: [] };
    current.netBuy += Number(row.BILLBOARD_NET_AMT || 0);
    current.buyAmount += Number(row.BILLBOARD_BUY_AMT || 0);
    current.sellAmount += Number(row.BILLBOARD_SELL_AMT || 0);
    if (row.EXPLANATION && !current.explanations.includes(row.EXPLANATION)) current.explanations.push(row.EXPLANATION);
    grouped.set(row.SECURITY_CODE, current);
  });
  return grouped;
}

function makeSectorRank(stocks) {
  const counts = stocks.reduce((map, stock) => map.set(stock.sector, (map.get(stock.sector) || 0) + 1), new Map());
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count], index) => ({ name, count, rank: index + 1 }));
}

async function refreshLive({ silent = false } = {}) {
  const button = $("#refreshButton");
  button.classList.add("loading");
  button.disabled = true;
  try {
    const latest = await findLatestPool();
    const base = `ut=${latest.token}&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt%3Aasc&date=${latest.date}`;
    const hyphenDate = `${latest.date.slice(0, 4)}-${latest.date.slice(4, 6)}-${latest.date.slice(6, 8)}`;
    const [down, broken, indices, concepts, billboard] = await Promise.all([
      jsonp(`https://push2ex.eastmoney.com/getTopicDTPool?${base}`),
      jsonp(`https://push2ex.eastmoney.com/getTopicZBPool?${base}`),
      jsonp("https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f6,f12,f14&secids=1.000001,0.399001,0.399006"),
      jsonp("https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=20&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m%3A90%2Bt%3A3%2Bf%3A!50&fields=f12,f14,f2,f3,f62"),
      jsonp(`https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=SECURITY_CODE%2CBILLBOARD_NET_AMT%2CBILLBOARD_BUY_AMT%2CBILLBOARD_SELL_AMT%2CEXPLANATION&filter=(TRADE_DATE%3D%27${hyphenDate}%27)&pageNumber=1&pageSize=500&source=WEB&client=WEB`, 15000, "callback"),
    ]);
    const billboardByCode = groupBillboard(billboard.result?.data);
    const stocks = latest.data.data.pool.map((stock) => normalizeLiveStock(stock, billboardByCode));
    const zt = latest.data.data.tc;
    const zb = broken.data?.tc ?? 0;
    state.data = {
      meta: { ...state.data.meta, tradeDate: latest.date, generatedAt: new Date().toISOString(), source: "东方财富公开行情接口（在线刷新）" },
      market: {
        limitUpCount: zt,
        limitDownCount: down.data?.tc ?? 0,
        brokenBoardCount: zb,
        sealSuccessRate: zt + zb ? (zt / (zt + zb)) * 100 : 0,
        indices: indices.data?.diff ?? state.data.market.indices,
      },
      concepts: (concepts.data?.diff ?? []).map((row) => ({ code: row.f12, name: row.f14, price: row.f2, changePercent: row.f3, mainNetInflow: row.f62 })),
      sectorRank: makeSectorRank(stocks),
      stocks,
    };
    renderAll();
    if (!silent) showToast(`已联网刷新至 ${formatDate(latest.date)} 收盘`);
  } catch (error) {
    if (!silent) showToast(`刷新失败，继续使用内置快照：${error.message}`);
  } finally {
    button.classList.remove("loading");
    button.disabled = false;
  }
}

async function shareApp() {
  const shareData = { title: "涨停强度工作台", text: "A股涨停强度七因子量化研究工作台（仅供数据研究）", url: location.href };
  try {
    if (navigator.share) await navigator.share(shareData);
    else {
      await navigator.clipboard.writeText(location.href);
      showToast("链接已复制，可以发给朋友了");
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast("暂时无法分享，请复制浏览器地址");
  }
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  $$('[data-jump]').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.jump)));
  $("#shareButton").addEventListener("click", shareApp);
  $("#refreshButton").addEventListener("click", () => refreshLive());
  $("#stockSearch").addEventListener("input", (event) => { state.search = event.target.value; renderScores(); });
  $("#scoreFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-score-filter]");
    if (!button) return;
    state.scoreFilter = button.dataset.scoreFilter;
    $$(".chip", $("#scoreFilters")).forEach((chip) => chip.classList.toggle("active", chip === button));
    renderScores();
  });
  document.addEventListener("click", (event) => {
    const watch = event.target.closest("[data-watch]");
    if (watch) { event.stopPropagation(); toggleWatch(watch.dataset.watch); return; }
    const card = event.target.closest("[data-stock]");
    if (card) openStock(card.dataset.stock);
  });
  document.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-stock]")) openStock(event.target.dataset.stock);
    if (event.key === "Escape") closeSheets();
  });
  $("#weightControls").addEventListener("input", (event) => {
    if (!event.target.matches("[data-weight]")) return;
    state.weights[event.target.dataset.weight] = Number(event.target.value);
    event.target.nextElementSibling.textContent = `${event.target.value}%`;
    localStorage.setItem("zt-workbench-weights", JSON.stringify(state.weights));
    recomputeScores(); renderFeatured(); renderScores(); renderWatchlist();
  });
  $("#resetWeights").addEventListener("click", () => {
    state.weights = { ...DEFAULT_WEIGHTS };
    localStorage.setItem("zt-workbench-weights", JSON.stringify(state.weights));
    renderAll(); showToast("已恢复默认权重");
  });
  $("#installButton").addEventListener("click", () => openSheet($("#installSheet")));
  $("#stockSheetClose").addEventListener("click", closeSheets);
  $("#installSheetClose").addEventListener("click", closeSheets);
  $("#sheetBackdrop").addEventListener("click", closeSheets);
  window.addEventListener("offline", () => { $("#offlineBanner").hidden = false; });
  window.addEventListener("online", () => { $("#offlineBanner").hidden = true; });
}

async function init() {
  try {
    const response = await fetch("./data/snapshot.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    renderAll();
    bindEvents();
    $("#offlineBanner").hidden = navigator.onLine;
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js").catch(() => {});
    if (navigator.onLine) setTimeout(() => refreshLive({ silent: true }), 350);
  } catch (error) {
    document.querySelector("main").innerHTML = `<div class="empty-state"><span>!</span><h3>数据载入失败</h3><p>${escapeHtml(error.message)}。请通过本地服务器或 HTTPS 地址打开。</p></div>`;
  }
}

init();
