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

const PREDICTION_KEY = "zt-workbench-predictions-v1";

const state = {
  data: null,
  scored: [],
  weights: loadJson("zt-workbench-weights", DEFAULT_WEIGHTS),
  watchlist: new Set(loadJson("zt-workbench-watchlist", [])),
  watchMeta: loadJson("zt-workbench-watch-meta", {}),
  watchQuotes: {},
  watchSearchResults: [],
  watchSearchRequest: 0,
  predictions: loadJson(PREDICTION_KEY, []),
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
      <button class="watch-button ${saved ? "saved" : ""}" data-watch="${stock.code}" aria-label="${saved ? "移出" : "加入"}自选">${saved ? "★" : "☆"}</button>
    </article>`;
}

function watchMetaFor(code) {
  const scored = state.scored.find((stock) => stock.code === code);
  if (scored) return { code: scored.code, name: scored.name, market: scored.market, marketName: scored.sector };
  return state.watchMeta[code] ?? null;
}

function watchlistCard(meta, index) {
  const quote = state.watchQuotes[meta.code];
  const price = Number(quote?.price);
  const change = Number(quote?.changePercent);
  const hasQuote = Number.isFinite(price) && price > 0;
  return `
    <article class="stock-card self-stock" data-stock="${meta.code}" role="button" tabindex="0">
      <span class="rank-number">${String(index + 1).padStart(2, "0")}</span>
      <div class="stock-main">
        <div class="stock-title"><strong>${escapeHtml(quote?.name || meta.name || meta.code)}</strong><span class="stock-code">${meta.code}</span></div>
        <div class="stock-meta"><span class="tag">${escapeHtml(meta.marketName || (Number(meta.market) === 1 ? "沪A" : "深A"))}</span><span class="tag">点击查看 K 线</span></div>
      </div>
      <div class="quote-block"><strong>${hasQuote ? `¥${price.toFixed(2)}` : "载入中"}</strong><span class="${change >= 0 ? "rise" : "fall"}">${Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "联网行情"}</span></div>
      <button class="watch-button saved" data-watch="${meta.code}" aria-label="移出自选">★</button>
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
  const scoredCodes = new Set(watched.map((stock) => stock.code));
  const custom = [...state.watchlist]
    .filter((code) => !scoredCodes.has(code))
    .map(watchMetaFor)
    .filter(Boolean);
  const total = watched.length + custom.length;
  $("#watchlistSummary").textContent = `共 ${state.watchlist.size} 只自选 · 点股票查看走势`;
  $("#watchlistEmpty").hidden = state.watchlist.size > 0;
  $("#watchlistStocks").innerHTML = [
    ...watched.map(stockCard),
    ...custom.map((meta, index) => watchlistCard(meta, watched.length + index)),
  ].join("");
  if (state.watchlist.size > 0 && total === 0) {
    $("#watchlistStocks").innerHTML = `<div class="empty-state compact-empty"><span>↻</span><h3>正在恢复自选信息</h3><p>请联网后重新搜索添加。</p></div>`;
  }
}

function savePredictions() {
  state.predictions = state.predictions.slice(-500);
  localStorage.setItem(PREDICTION_KEY, JSON.stringify(state.predictions));
}

function calibrateProbability(baseProbability, current) {
  const verified = state.predictions.filter((record) => record.verified && Number.isFinite(record.finalProbability));
  const sameBucket = verified.filter((record) => Math.abs(record.rawProbability - baseProbability) <= 10);
  const sameRegime = sameBucket.filter((record) =>
    Math.sign(record.features?.mainRatio || 0) === Math.sign(current.mainRatio || 0)
    && Math.sign(record.features?.macdHistogramPercent || 0) === Math.sign(current.macdHistogramPercent || 0));
  const pool = sameRegime.length >= 5 ? sameRegime : sameBucket;
  if (pool.length < 5) return { adjusted: baseProbability, learned: false, sampleCount: pool.length, delta: 0 };
  const wins = pool.filter((record) => record.actualUp).length;
  const priorStrength = 10;
  const adjusted = ((wins + priorStrength * (baseProbability / 100)) / (pool.length + priorStrength)) * 100;
  return { adjusted: clamp(adjusted, 5, 95), learned: true, sampleCount: pool.length, delta: adjusted - baseProbability };
}

function canFreezePrediction(signalDate) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (signalDate < today) return true;
  return signalDate === today && (now.getHours() * 60 + now.getMinutes()) >= 905;
}

function recordPrediction(stock, probability, calibration, data) {
  const signalDate = probability.current?.date;
  if (!signalDate || signalDate !== data.at(-1)?.date || !canFreezePrediction(signalDate)) return;
  if (state.predictions.some((record) => record.code === stock.code && record.signalDate === signalDate)) return;
  state.predictions.push({
    id: `${stock.code}-${signalDate}`,
    code: stock.code,
    market: Number(stock.market),
    name: stock.name,
    signalDate,
    signalClose: data.at(-1).close,
    rawProbability: probability.rate,
    finalProbability: calibration.adjusted,
    analogSamples: probability.count,
    learningSamples: calibration.sampleCount,
    features: {
      volumeRatio: probability.current.volumeRatio,
      mainRatio: probability.current.mainRatio,
      macdHistogramPercent: probability.current.macdHistogramPercent,
      rsi6: probability.current.rsi6,
      momentum5: probability.current.momentum5,
    },
    modelVersion: "hard-indicator-learning-v1",
    createdAt: new Date().toISOString(),
    verified: false,
  });
  savePredictions();
  renderLearningPanel();
}

function verifyPredictionRecords(code, data) {
  let changed = 0;
  state.predictions.forEach((record) => {
    if (record.code !== code || record.verified) return;
    const index = data.findIndex((item) => item.date === record.signalDate);
    if (index < 0 || index >= data.length - 1) return;
    const next = data[index + 1];
    const baseClose = data[index].close;
    record.actualDate = next.date;
    record.actualReturn = ((next.close / baseClose) - 1) * 100;
    record.actualUp = record.actualReturn > 0;
    record.correct = (record.finalProbability >= 50) === record.actualUp;
    record.brier = ((record.finalProbability / 100) - (record.actualUp ? 1 : 0)) ** 2;
    record.verified = true;
    record.verifiedAt = new Date().toISOString();
    changed += 1;
  });
  if (changed) {
    savePredictions();
    renderLearningPanel();
  }
  return changed;
}

function renderLearningPanel() {
  const metrics = $("#learningMetrics");
  if (!metrics) return;
  const records = [...state.predictions].sort((a, b) => String(b.signalDate).localeCompare(String(a.signalDate)));
  const verified = records.filter((record) => record.verified);
  const correct = verified.filter((record) => record.correct).length;
  const hitRate = verified.length ? (correct / verified.length) * 100 : null;
  const brier = verified.length ? verified.reduce((sum, record) => sum + Number(record.brier || 0), 0) / verified.length : null;
  metrics.innerHTML = `
    <div><span>已验证</span><strong>${verified.length}</strong><em>条预测</em></div>
    <div><span>方向命中</span><strong>${hitRate == null ? "—" : `${hitRate.toFixed(1)}%`}</strong><em>以 50% 为界</em></div>
    <div><span>Brier 误差</span><strong>${brier == null ? "—" : brier.toFixed(3)}</strong><em>越低越好</em></div>
    <div><span>校准状态</span><strong>${verified.length >= 5 ? "学习中" : "积累中"}</strong><em>${verified.length >= 5 ? "概率校准已启用" : `${5 - verified.length} 条后启动`}</em></div>`;
  $("#learningEmpty").hidden = records.length > 0;
  $("#predictionHistory").innerHTML = records.slice(0, 8).map((record) => {
    const probability = Number(record.finalProbability).toFixed(1);
    if (!record.verified) return `<div class="prediction-row pending"><div><strong>${escapeHtml(record.name)}</strong><span>${record.signalDate.slice(5)} 预测</span></div><div><span>次日上涨率</span><strong>${probability}%</strong></div><em>待验证</em></div>`;
    const actualClass = record.actualReturn >= 0 ? "rise" : "fall";
    return `<div class="prediction-row"><div><strong>${escapeHtml(record.name)}</strong><span>${record.signalDate.slice(5)} → ${record.actualDate.slice(5)}</span></div><div><span>前日预测</span><strong>${probability}%</strong></div><div><span>当日实际</span><strong class="${actualClass}">${record.actualReturn >= 0 ? "+" : ""}${record.actualReturn.toFixed(2)}%</strong></div><em class="${record.correct ? "correct" : "wrong"}">${record.correct ? "命中" : "偏差"}</em></div>`;
  }).join("");
}

async function verifyAllPredictions({ silent = false } = {}) {
  const button = $("#verifyPredictions");
  const unresolved = state.predictions.filter((record) => !record.verified);
  const targets = [...new Map(unresolved.map((record) => [record.code, record])).values()].slice(0, 20);
  if (!targets.length) { if (!silent) showToast("暂无待验证预测"); return; }
  if (!navigator.onLine) { if (!silent) showToast("当前离线，联网后才能验证"); return; }
  const before = state.predictions.filter((record) => record.verified).length;
  button.disabled = true;
  button.textContent = "验证中…";
  await Promise.allSettled(targets.map(async (record) => {
    const response = await jsonp(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${record.market}.${record.code}&klt=101&fqt=1&lmt=260&end=20500101&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`, 16000);
    verifyPredictionRecords(record.code, parseKlines(response));
  }));
  const added = state.predictions.filter((record) => record.verified).length - before;
  button.disabled = false;
  button.textContent = "更新验证";
  renderLearningPanel();
  if (!silent || added) showToast(added ? `已完成 ${added} 条预测验证` : "尚无新的交易日结果");
}

function saveWatchlist() {
  localStorage.setItem("zt-workbench-watchlist", JSON.stringify([...state.watchlist]));
  localStorage.setItem("zt-workbench-watch-meta", JSON.stringify(state.watchMeta));
}

function renderWatchSearchResults() {
  const container = $("#watchlistSearchResults");
  container.innerHTML = state.watchSearchResults.map((item) => {
    const saved = state.watchlist.has(item.code);
    return `<div class="watch-search-row"><div><strong>${escapeHtml(item.name)}</strong><span>${item.code} · ${escapeHtml(item.marketName)}</span></div><button data-add-watch="${item.code}" ${saved ? "disabled" : ""}>${saved ? "已添加" : "＋"}</button></div>`;
  }).join("");
}

async function searchWatchStocks(query) {
  const keyword = query.trim();
  const hint = $("#watchlistSearchHint");
  const requestId = ++state.watchSearchRequest;
  if (!keyword) {
    state.watchSearchResults = [];
    renderWatchSearchResults();
    hint.textContent = "支持沪深京 A 股，联网搜索后点“＋”添加";
    return;
  }
  hint.textContent = "正在联网搜索…";
  try {
    const response = await jsonp(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8`, 12000);
    if (requestId !== state.watchSearchRequest) return;
    const rows = response?.QuotationCodeTable?.Data ?? [];
    state.watchSearchResults = rows
      .filter((row) => row.Classify === "AStock" && /^\d{6}$/.test(row.Code))
      .map((row) => ({
        code: row.Code,
        name: row.Name,
        market: Number(String(row.QuoteID || "0.0").split(".")[0]),
        marketName: row.SecurityTypeName || "A股",
      }));
    hint.textContent = state.watchSearchResults.length ? `找到 ${state.watchSearchResults.length} 只股票` : "没有找到匹配的 A 股，请检查代码或名称";
    renderWatchSearchResults();
  } catch (error) {
    if (requestId !== state.watchSearchRequest) return;
    state.watchSearchResults = [];
    renderWatchSearchResults();
    hint.textContent = navigator.onLine ? "搜索暂时失败，请稍后重试" : "当前离线，联网后可搜索添加";
  }
}

function addWatchFromSearch(code) {
  const item = state.watchSearchResults.find((row) => row.code === code);
  if (!item) return;
  state.watchlist.add(code);
  state.watchMeta[code] = item;
  saveWatchlist();
  renderFeatured();
  renderScores();
  renderWatchlist();
  renderWatchSearchResults();
  refreshWatchQuotes([code]);
  showToast(`${item.name} 已加入自选`);
}

async function refreshWatchQuotes(codes = [...state.watchlist]) {
  const targets = codes.filter((code) => !state.scored.some((stock) => stock.code === code) && watchMetaFor(code));
  if (!targets.length || !navigator.onLine) return;
  await Promise.allSettled(targets.map(async (code) => {
    const meta = watchMetaFor(code);
    const response = await jsonp(`https://push2.eastmoney.com/api/qt/stock/get?secid=${meta.market}.${code}&fltt=2&invt=2&fields=f43,f57,f58,f60,f169,f170`, 12000);
    const quote = response?.data;
    if (!quote) return;
    state.watchQuotes[code] = { name: quote.f58 || meta.name, price: Number(quote.f43), changePercent: Number(quote.f170) };
  }));
  renderWatchlist();
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
  renderLearningPanel();
  renderWeights();
}

function openStock(code) {
  const scoredStock = state.scored.find((item) => item.code === code);
  const meta = watchMetaFor(code);
  const quote = state.watchQuotes[code];
  const stock = scoredStock ?? (meta ? {
    ...meta,
    isCustomWatch: true,
    price: Number(quote?.price || 0),
    changePercent: Number(quote?.changePercent || 0),
    sector: meta.marketName || "自选股",
  } : null);
  if (!stock) return;
  $("#stockSheet").dataset.stockCode = stock.code;
  if (stock.isCustomWatch) {
    const priceText = stock.price > 0 ? `¥${stock.price.toFixed(2)}` : "联网载入";
    const changeText = Number.isFinite(stock.changePercent) ? `${stock.changePercent >= 0 ? "+" : ""}${stock.changePercent.toFixed(2)}%` : "—";
    $("#stockSheetContent").innerHTML = `
      <div class="sheet-stock-head">
        <div><p>${stock.code} · ${escapeHtml(stock.sector)}</p><h2>${escapeHtml(stock.name)}</h2><p>自选股 · 最新 ${priceText}</p></div>
        <div class="sheet-score quote-score"><strong class="${stock.changePercent >= 0 ? "rise" : "fall"}">${changeText}</strong><span>最新涨跌幅</span></div>
      </div>
      <section class="trend-card">
        <div class="trend-heading">
          <div><span>PRICE ACTION</span><h3>个股走势 · 日K</h3></div>
          <span class="trend-source">联网行情</span>
        </div>
        <div class="kline-loading" id="klineChart"><span></span><p>正在载入近 260 个交易日走势</p></div>
        <div id="trendStats"></div>
        <div class="probability-card loading" id="nextDayProbability">
          <span>次日上涨率 · 硬指标样本</span><strong>计算中</strong><p>正在计算成交量、主力净流入与 MACD 相似样本</p>
        </div>
      </section>
      <p class="sheet-disclaimer">自选股行情与历史统计仅用于短线复盘，不构成投资建议，也不代表下一交易日一定上涨。</p>`;
  } else {
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
    <section class="trend-card">
      <div class="trend-heading">
        <div><span>PRICE ACTION</span><h3>个股走势 · 日K</h3></div>
        <span class="trend-source">联网行情</span>
      </div>
      <div class="kline-loading" id="klineChart"><span></span><p>正在载入近 260 个交易日走势</p></div>
      <div id="trendStats"></div>
      <div class="probability-card loading" id="nextDayProbability">
        <span>次日上涨率 · 硬指标样本</span><strong>计算中</strong><p>正在计算成交量、主力净流入与 MACD 相似样本</p>
      </div>
    </section>
    <div class="factor-list">${Object.entries(stock.factors).map(([key, value]) => `
      <div class="factor-row"><label>${FACTOR_LABELS[key]}</label><div class="bar-track"><div class="bar-fill" style="width:${value}%"></div></div><strong>${Math.round(value)}</strong></div>`).join("")}</div>
    <p class="sheet-disclaimer">强度值依据当日收盘后的七类数据计算，仅用于横向比较涨停结构，不表达次日方向或收益承诺。</p>`;
  }
  openSheet($("#stockSheet"));
  loadStockTrend(stock);
}

function parseKlines(response) {
  return (response?.data?.klines ?? []).map((row) => {
    const [date, open, close, high, low, volume, amount, amplitude, changePercent, change, turnover] = row.split(",");
    return { date, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume), amount: Number(amount), amplitude: Number(amplitude), changePercent: Number(changePercent), change: Number(change), turnover: Number(turnover) };
  }).filter((item) => Number.isFinite(item.close) && Number.isFinite(item.open));
}

function movingAverage(data, windowSize) {
  return data.map((_, index) => {
    if (index < windowSize - 1) return null;
    const values = data.slice(index - windowSize + 1, index + 1);
    return values.reduce((sum, item) => sum + item.close, 0) / windowSize;
  });
}

function parseMainFlows(response) {
  return new Map((response?.data?.klines ?? []).map((row) => {
    const [date, mainNet] = row.split(",");
    return [date, Number(mainNet)];
  }).filter(([, value]) => Number.isFinite(value)));
}

function emaSeries(values, period) {
  const multiplier = 2 / (period + 1);
  let previous = Number(values[0] || 0);
  return values.map((raw, index) => {
    const value = Number(raw || 0);
    previous = index === 0 ? value : value * multiplier + previous * (1 - multiplier);
    return previous;
  });
}

function rsiAt(data, index, period = 6) {
  if (index < period) return null;
  let gains = 0;
  let losses = 0;
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const change = data[cursor].close - data[cursor - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

function wilsonInterval(wins, count) {
  if (!count) return { low: null, high: null };
  const rate = wins / count;
  const z = 1.96;
  const denominator = 1 + (z * z) / count;
  const center = (rate + (z * z) / (2 * count)) / denominator;
  const margin = (z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * count)) / count)) / denominator;
  return { low: clamp((center - margin) * 100), high: clamp((center + margin) * 100) };
}

function indicatorProbabilityFromHistory(data, flowByDate) {
  if (flowByDate.size < 30 || data.length < 35) return { count: 0, reason: "主力资金历史数据不足" };
  const closes = data.map((item) => item.close);
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const dif = closes.map((_, index) => ema12[index] - ema26[index]);
  const dea = emaSeries(dif, 9);
  const histogram = dif.map((value, index) => (value - dea[index]) * 2);
  const rows = [];

  for (let index = 26; index < data.length; index += 1) {
    const item = data[index];
    const mainNet = flowByDate.get(item.date);
    const priorVolumes = data.slice(index - 5, index).map((row) => row.volume).filter(Number.isFinite);
    const averageVolume = priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length;
    const rsi6 = rsiAt(data, index, 6);
    if (!Number.isFinite(mainNet) || !averageVolume || !Number.isFinite(rsi6) || !item.amount) continue;
    rows.push({
      index,
      date: item.date,
      volumeRatio: item.volume / averageVolume,
      mainNet,
      mainRatio: clamp((mainNet / item.amount) * 100, -50, 50),
      macdHistogram: histogram[index],
      macdHistogramPercent: (histogram[index] / item.close) * 100,
      macdSlopePercent: ((histogram[index] - histogram[index - 1]) / item.close) * 100,
      rsi6,
      momentum5: ((item.close / data[index - 5].close) - 1) * 100,
    });
  }

  const current = rows.at(-1);
  const candidates = rows.filter((row) => row.index < data.length - 1 && row.date !== current?.date);
  if (!current || candidates.length < 12) return { count: candidates.length, current, reason: "可比交易日不足" };

  const featureWeights = {
    volumeRatio: 0.22,
    mainRatio: 0.30,
    macdHistogramPercent: 0.18,
    macdSlopePercent: 0.10,
    rsi6: 0.10,
    momentum5: 0.10,
  };
  const scales = Object.keys(featureWeights).reduce((result, key) => {
    const values = candidates.map((row) => row[key]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
    result[key] = Math.max(Math.sqrt(variance), key === "rsi6" ? 8 : 0.01);
    return result;
  }, {});
  const withDistance = candidates.map((row) => {
    let distance = Object.entries(featureWeights).reduce((sum, [key, weight]) => sum + (Math.abs(row[key] - current[key]) / scales[key]) * weight, 0);
    if (Math.sign(row.mainRatio) !== Math.sign(current.mainRatio)) distance += 0.22;
    if (Math.sign(row.macdHistogramPercent) !== Math.sign(current.macdHistogramPercent)) distance += 0.16;
    return { ...row, distance };
  }).sort((a, b) => a.distance - b.distance);
  const similar = withDistance.slice(0, Math.min(20, withDistance.length));
  const samples = similar.map((row) => {
    const base = data[row.index].close;
    const next = data[row.index + 1];
    return {
      up: next.close > base,
      openReturn: ((next.open / base) - 1) * 100,
      closeReturn: ((next.close / base) - 1) * 100,
      highReturn: ((next.high / base) - 1) * 100,
      lowReturn: ((next.low / base) - 1) * 100,
    };
  });
  const count = samples.length;
  const wins = samples.filter((sample) => sample.up).length;
  const average = (key) => samples.reduce((sum, sample) => sum + sample[key], 0) / count;
  const interval = wilsonInterval(wins, count);
  return {
    count,
    wins,
    rate: (wins / count) * 100,
    ...interval,
    current,
    averageOpen: average("openReturn"),
    averageClose: average("closeReturn"),
    averageHigh: average("highReturn"),
    averageLow: average("lowReturn"),
  };
}

function macdLabel(current) {
  if (current.macdHistogram >= 0 && current.macdSlopePercent >= 0) return "多头增强";
  if (current.macdHistogram >= 0) return "多头减弱";
  if (current.macdSlopePercent >= 0) return "空头收敛";
  return "空头增强";
}

function renderKlineChart(data) {
  const candles = data.slice(-60);
  const width = 360;
  const height = 220;
  const priceTop = 16;
  const priceBottom = 164;
  const volumeTop = 176;
  const volumeBottom = 208;
  const minPrice = Math.min(...candles.map((item) => item.low));
  const maxPrice = Math.max(...candles.map((item) => item.high));
  const priceRange = maxPrice - minPrice || 1;
  const maxVolume = Math.max(...candles.map((item) => item.volume)) || 1;
  const step = width / candles.length;
  const candleWidth = Math.max(2, Math.min(4.4, step * 0.62));
  const yPrice = (value) => priceTop + ((maxPrice - value) / priceRange) * (priceBottom - priceTop);
  const xAt = (index) => step * index + step / 2;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = priceTop + ratio * (priceBottom - priceTop);
    const label = (maxPrice - ratio * priceRange).toFixed(2);
    return `<line x1="0" y1="${y}" x2="360" y2="${y}" class="chart-grid"/><text x="3" y="${y - 3}" class="chart-axis">${label}</text>`;
  }).join("");
  const candleSvg = candles.map((item, index) => {
    const x = xAt(index);
    const up = item.close >= item.open;
    const colorClass = up ? "candle-up" : "candle-down";
    const openY = yPrice(item.open);
    const closeY = yPrice(item.close);
    const bodyY = Math.min(openY, closeY);
    const bodyHeight = Math.max(1.2, Math.abs(openY - closeY));
    const volumeHeight = (item.volume / maxVolume) * (volumeBottom - volumeTop);
    return `<g class="${colorClass}"><line x1="${x}" y1="${yPrice(item.high)}" x2="${x}" y2="${yPrice(item.low)}"/><rect x="${x - candleWidth / 2}" y="${bodyY}" width="${candleWidth}" height="${bodyHeight}"/><rect class="volume-bar" x="${x - candleWidth / 2}" y="${volumeBottom - volumeHeight}" width="${candleWidth}" height="${volumeHeight}"/></g>`;
  }).join("");
  const maLines = [[5, "ma-five"], [10, "ma-ten"], [20, "ma-twenty"]].map(([windowSize, className]) => {
    const values = movingAverage(candles, windowSize);
    const points = values.map((value, index) => value == null ? null : `${xAt(index)},${yPrice(value)}`).filter(Boolean).join(" ");
    return `<polyline class="ma-line ${className}" points="${points}"/>`;
  }).join("");
  const firstDate = candles[0]?.date.slice(5) ?? "";
  const lastDate = candles.at(-1)?.date.slice(5) ?? "";
  return `<div class="kline-legend"><span class="ma5">MA5</span><span class="ma10">MA10</span><span class="ma20">MA20</span><em>红涨 · 绿跌</em></div><svg class="kline-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近60个交易日日K线">${grid}${candleSvg}${maLines}<text x="3" y="219" class="chart-axis">${firstDate}</text><text x="357" y="219" text-anchor="end" class="chart-axis">${lastDate}</text></svg>`;
}

async function loadStockTrend(stock) {
  const sheet = $("#stockSheet");
  const secid = `${stock.market}.${stock.code}`;
  try {
    const [klineResult, flowResult] = await Promise.allSettled([
      jsonp(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=260&end=20500101&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`, 16000),
      jsonp(`https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=360&klt=101&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55`, 16000),
    ]);
    if (klineResult.status !== "fulfilled") throw klineResult.reason;
    if (sheet.dataset.stockCode !== stock.code) return;
    const data = parseKlines(klineResult.value);
    if (data.length < 20) throw new Error("历史行情样本不足");
    verifyPredictionRecords(stock.code, data);
    $("#klineChart").className = "kline-chart";
    $("#klineChart").innerHTML = renderKlineChart(data);
    const latest = data.at(-1);
    const twentyAgo = data.at(-21) ?? data[0];
    const sixtyAgo = data.at(-61) ?? data[0];
    const return20 = ((latest.close / twentyAgo.close) - 1) * 100;
    const return60 = ((latest.close / sixtyAgo.close) - 1) * 100;
    $("#trendStats").innerHTML = `<div class="trend-stats"><div><span>最新收盘</span><strong>¥${latest.close.toFixed(2)}</strong></div><div><span>20日走势</span><strong class="${return20 >= 0 ? "rise" : "fall"}">${return20 >= 0 ? "+" : ""}${return20.toFixed(1)}%</strong></div><div><span>60日走势</span><strong class="${return60 >= 0 ? "rise" : "fall"}">${return60 >= 0 ? "+" : ""}${return60.toFixed(1)}%</strong></div></div>`;
    const card = $("#nextDayProbability");
    card.classList.remove("loading");
    if (flowResult.status !== "fulfilled") {
      card.innerHTML = `<div><span>次日上涨率 · 硬指标样本</span><strong>资金流暂缺</strong></div><p>K 线已载入，但主力净流入数据暂时不可用，因此不输出缺少关键指标的概率。</p>`;
      return;
    }
    const probability = indicatorProbabilityFromHistory(data, parseMainFlows(flowResult.value));
    if (probability.count >= 12 && probability.current) {
      const current = probability.current;
      const calibration = calibrateProbability(probability.rate, current);
      const displayedProbability = calibration.adjusted;
      const volumeLabel = current.volumeRatio >= 1.2 ? "放量" : current.volumeRatio <= 0.8 ? "缩量" : "平量";
      const flowClass = current.mainNet >= 0 ? "rise" : "fall";
      const macdClass = current.macdHistogram >= 0 ? "rise" : "fall";
      const calibrationText = calibration.learned
        ? `已用 ${calibration.sampleCount} 条同区间验证记录校准 ${calibration.delta >= 0 ? "+" : ""}${calibration.delta.toFixed(1)} 个百分点`
        : `已积累 ${calibration.sampleCount} 条同区间记录，满 5 条后启动概率校准`;
      card.innerHTML = `<div><span>次日上涨率 · 验证学习模型</span><strong>${displayedProbability.toFixed(1)}%</strong></div><div class="probability-range"><span>原始相似样本 ${probability.rate.toFixed(1)}% · 95%区间 ${probability.low.toFixed(0)}%–${probability.high.toFixed(0)}%</span><em>${probability.wins}/${probability.count} 个样本收涨</em></div><div class="learning-calibration ${calibration.learned ? "active" : ""}"><span>${calibration.learned ? "学习已生效" : "学习积累中"}</span><strong>${calibrationText}</strong></div><div class="indicator-grid"><div><span>5日量比</span><strong>${current.volumeRatio.toFixed(2)}×</strong><em>${volumeLabel}</em></div><div><span>主力净流入</span><strong class="${flowClass}">${formatMoney(current.mainNet, true)}</strong><em>${current.mainRatio >= 0 ? "+" : ""}${current.mainRatio.toFixed(2)}% 成交额</em></div><div><span>MACD</span><strong class="${macdClass}">${macdLabel(current)}</strong><em>柱 ${current.macdHistogram >= 0 ? "+" : ""}${current.macdHistogram.toFixed(3)}</em></div><div><span>RSI6 / 5日动量</span><strong>${current.rsi6.toFixed(0)} / ${current.momentum5 >= 0 ? "+" : ""}${current.momentum5.toFixed(1)}%</strong><em>${current.date.slice(5)}</em></div></div><div class="next-day-grid"><div><span>样本次日开盘</span><strong class="${probability.averageOpen >= 0 ? "rise" : "fall"}">${probability.averageOpen >= 0 ? "+" : ""}${probability.averageOpen.toFixed(1)}%</strong></div><div><span>样本次日收盘</span><strong class="${probability.averageClose >= 0 ? "rise" : "fall"}">${probability.averageClose >= 0 ? "+" : ""}${probability.averageClose.toFixed(1)}%</strong></div><div><span>样本次日最高</span><strong class="rise">${probability.averageHigh >= 0 ? "+" : ""}${probability.averageHigh.toFixed(1)}%</strong></div><div><span>样本次日最低</span><strong class="${probability.averageLow >= 0 ? "rise" : "fall"}">${probability.averageLow >= 0 ? "+" : ""}${probability.averageLow.toFixed(1)}%</strong></div></div><p>系统冻结本次预测，下一交易日按实际收盘涨跌验证；同概率区间至少积累 5 条记录后进行贝叶斯收缩校准。历史条件频率不代表确定结果。</p>`;
      recordPrediction(stock, probability, calibration, data);
    } else {
      card.innerHTML = `<div><span>次日上涨率 · 硬指标样本</span><strong>样本不足</strong></div><p>${escapeHtml(probability.reason || "可比交易日不足")}，当前仅有 ${probability.count} 个可用样本，暂不显示百分比。</p>`;
    }
  } catch (error) {
    if (sheet.dataset.stockCode !== stock.code) return;
    $("#klineChart").className = "kline-error";
    $("#klineChart").innerHTML = `<strong>K 线暂时无法载入</strong><p>${escapeHtml(error.message)}，请稍后重试。</p>`;
    $("#nextDayProbability").classList.remove("loading");
    $("#nextDayProbability").innerHTML = `<div><span>次日上涨率 · 硬指标样本</span><strong>暂无数据</strong></div><p>未取得足够的行情与资金流数据，因此不显示推测值。</p>`;
  }
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
  const wasSaved = state.watchlist.has(code);
  if (wasSaved) {
    state.watchlist.delete(code);
    delete state.watchMeta[code];
    delete state.watchQuotes[code];
  } else {
    state.watchlist.add(code);
    const stock = state.scored.find((item) => item.code === code);
    if (stock) state.watchMeta[code] = { code: stock.code, name: stock.name, market: stock.market, marketName: stock.sector };
  }
  saveWatchlist();
  renderFeatured();
  renderScores();
  renderWatchlist();
  renderWatchSearchResults();
  showToast(state.watchlist.has(code) ? "已加入我的自选" : "已移出我的自选");
}

function switchTab(tab) {
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tab));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  if (tab === "watchlist") refreshWatchQuotes();
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
  let watchSearchTimer;
  $("#watchlistSearch").addEventListener("input", (event) => {
    clearTimeout(watchSearchTimer);
    watchSearchTimer = setTimeout(() => searchWatchStocks(event.target.value), 280);
  });
  $("#scoreFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-score-filter]");
    if (!button) return;
    state.scoreFilter = button.dataset.scoreFilter;
    $$(".chip", $("#scoreFilters")).forEach((chip) => chip.classList.toggle("active", chip === button));
    renderScores();
  });
  document.addEventListener("click", (event) => {
    const addWatch = event.target.closest("[data-add-watch]");
    if (addWatch) { event.stopPropagation(); addWatchFromSearch(addWatch.dataset.addWatch); return; }
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
  $("#verifyPredictions").addEventListener("click", verifyAllPredictions);
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
    if (navigator.onLine) {
      setTimeout(() => refreshLive({ silent: true }), 350);
      if (state.predictions.some((record) => !record.verified)) setTimeout(() => verifyAllPredictions({ silent: true }), 2200);
    }
  } catch (error) {
    document.querySelector("main").innerHTML = `<div class="empty-state"><span>!</span><h3>数据载入失败</h3><p>${escapeHtml(error.message)}。请通过本地服务器或 HTTPS 地址打开。</p></div>`;
  }
}

init();
