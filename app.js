"use strict";

const $ = (id) => document.getElementById(id);
const icons = {
  shield: '<path d="M12 22s7-3 7-10V5l-7-3-7 3v7c0 7 7 10 7 10Z"/><path d="m9 12 2 2 4-4"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15m6-12v15"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  pin: '<path d="M19 10c0 5-7 10-7 10s-7-5-7-10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  shelter: '<path d="m3 11 9-7 9 7m-3-2v11h-4v-6h-4v6H6V9"/>',
  hospital: '<path d="M12 5v14M5 12h14" stroke-width="3"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  reset: '<path d="M3 12a9 9 0 1 1 2.5 6.2M3 5v7h7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const escape = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const number = new Intl.NumberFormat("ko-KR");
const count = (value) => number.format(value);
const types = { shelter: "민방위 대피시설", hospital: "응급의료기관" };
const CHEONGJU = "4311000000";
const SEJONG = "3611000000";
const DEMO_POINT = [36.6424, 127.489];
const KOREA_CENTER = [36.3, 127.75];
const PAGE_SIZE = 36;
const NEARBY_KM = 30;
const mobileLayout = matchMedia("(max-width: 760px)");
const compactDesktop = matchMedia("(min-width: 761px) and (max-width: 1199px)");
const ALERT_SCOPES = { direct: "시·군·구 직접 지정", wide: "상위 지역·전국 대상", unknown: "지역 코드 미확인" };
const ARCHIVE_ZERO = "#edf3eb";
const ARCHIVE_COLORS = ["#cae6d3", "#94cdae", "#54a783", "#16674e"];
const ARCHIVE_UNMATCHED = "#d5ddd9";

document.querySelectorAll("[data-icon]").forEach((element) => {
  element.innerHTML = icon(element.dataset.icon);
});

const { facilities, regions, updates } = window.SAFEON_CATALOG;
const geometry = window.SAFEON_BOUNDARIES;
const shapes = new Map(geometry.features.map((feature) => [feature.properties.code, feature]));
const archiveDistricts = geometry.features.filter(({ properties: { code, province } }) =>
  code === SEJONG || (!province && code !== `boundary-${SEJONG}`));
const archiveDistrictCodes = new Set(archiveDistricts.map(({ properties }) => properties.code).filter((code) => regions[code]));
const facilityById = new Map(facilities.map((row) => [row.id, row]));
const sortedRegions = Object.entries(regions).sort((a, b) => a[1].localeCompare(b[1], "ko"));
const state = {
  view: "facilities", region: null, kind: "all", origin: null,
  demo: false, nearby: false, selectedFacility: "", selectedAlert: null,
  facilityDetailOpen: false, archiveView: "message",
  facilityLimit: PAGE_SIZE, alertLimit: PAGE_SIZE, locationNotice: "",
};
let messages = [];
let archiveStart = "";
let archiveEnd = "";
let messageLoad;
let messageState = "idle";
let visibleFacilities = [];
let visibleAlerts = [];
let distances = new Map();
let toastTimeout;
let locationRequest = 0;
let archiveMap;
let archiveLayer;

const map = L.map("map", { minZoom: 6, maxZoom: 19, zoomControl: false }).setView(KOREA_CENTER, 7);
L.control.zoom({ position: "topright" }).addTo(map);
map.attributionControl.setPrefix(false);
map.attributionControl.addAttribution(
  '<a href="https://github.com/KnellBalm/kr-admin-geojson" target="_blank" rel="noopener">국가공간정보포털 · 공공데이터포털 경계</a>',
);
setupBackgroundMap();
const markerLayer = L.layerGroup().addTo(map);
const positionLayer = L.layerGroup().addTo(map);
map.on("moveend", drawMarkers);
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => map.invalidateSize({ pan: false, debounceMoveend: true }))
    .observe($("map"));
}

function setupBackgroundMap() {
  const pane = map.createPane("districtBackground");
  pane.style.zIndex = "180";
  pane.style.pointerEvents = "none";
  L.geoJSON(geometry, {
    interactive: false,
    renderer: L.canvas({ pane: "districtBackground" }),
    style: (feature) => feature.properties.province
      ? { color: "#88a89d", opacity: .95, weight: 1.2, fillColor: "#f4f7f1", fillOpacity: .85 }
      : { color: "#a5bbb2", opacity: .8, weight: 1, fill: false },
  }).addTo(map);

  const label = $("map-background-label");
  const setBackground = (message) => {
    if (label.textContent !== message) label.textContent = message;
    label.hidden = !message;
  };
  if (!["http:", "https:"].includes(window.location.protocol)) {
    setBackground("행정구역 지도 · 배경 지도는 로컬 서버에서 열 수 있어요");
    return;
  }

  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 19,
    opacity: 0,
    updateWhenZooming: false,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  const failedTiles = new Set();
  const loadedTiles = new Set();
  let timer;
  const fallback = () => {
    tiles.setOpacity(0);
    setBackground("행정구역 지도 · 온라인 배경 연결 대기");
  };
  tiles.on("loading", () => {
    clearTimeout(timer);
    timer = setTimeout(fallback, 4000);
  });
  tiles.on("tileload", ({ tile }) => {
    loadedTiles.add(tile);
    failedTiles.delete(tile);
  });
  tiles.on("tileerror", ({ tile }) => {
    failedTiles.add(tile);
    fallback();
  });
  const showCompleteBackground = () => {
    clearTimeout(timer);
    if (failedTiles.size === 0 && loadedTiles.size > 0) {
      tiles.setOpacity(1);
      setBackground("");
    } else {
      fallback();
    }
  };
  tiles.on("tileunload", ({ tile }) => {
    loadedTiles.delete(tile);
    if (failedTiles.delete(tile)) {
      queueMicrotask(() => {
        if (!tiles.isLoading()) showCompleteBackground();
      });
    }
  });
  tiles.on("load", showCompleteBackground);
  setBackground("온라인 배경 지도 불러오는 중");
  tiles.addTo(map);
}

function option(value, name) {
  return new Option(name, value);
}

const regionPrompt = option("select-region", "지역 선택");
regionPrompt.disabled = true;
$("region").append(regionPrompt, option("", "전국"), ...sortedRegions.map(([code, name]) => option(code, name)));

function timestamp(value) {
  return value ? `${value} (KST)` : "시각 미제공";
}

$("data-updates").innerHTML = [
  ["재난문자 마지막 발송", timestamp(updates.lastSent)],
  ["재난문자 자료 마지막 갱신", timestamp(updates.alerts)],
  ["대피시설 자료 마지막 갱신", timestamp(updates.shelters)],
  ["응급의료기관 자료 마지막 갱신", "원본에 갱신 시각 미제공"],
].map(([title, value]) => `<dt>${escape(title)}</dt><dd>${escape(value)}</dd>`).join("");

function toast(message) {
  clearTimeout(toastTimeout);
  $("map-status").textContent = message;
  $("map-status").hidden = false;
  toastTimeout = setTimeout(() => { $("map-status").hidden = true; }, 6200);
}

function sameOrChild(parent, child) {
  if (!parent) return true;
  if (!child) return false;
  return parent === child || (regions[child] || "").startsWith(`${regions[parent]} `);
}

function regionLabel(code) {
  return code === null ? "지역 선택" : (regions[code] || "전국");
}

function selectedRegionLabel() {
  return state.nearby ? `내 위치 반경 ${NEARBY_KM} km` : regionLabel(state.region);
}

function distance(row) {
  if (!row.point || !state.origin) return Infinity;
  if (!distances.has(row.id)) {
    distances.set(row.id, map.distance(state.origin, row.point) / 1000);
  }
  return distances.get(row.id);
}

function distanceText(km) {
  if (!Number.isFinite(km)) return "";
  return km < 1 ? `${count(Math.round(km * 1000))} m` : `${count(Number(km.toFixed(1)))} km`;
}

function searchKey(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("ko").replace(/\s+/g, "");
}

function facilityRows() {
  if (!state.nearby && state.region === null) return [];
  const query = searchKey($("query").value);
  const includeInactive = $("include-inactive").checked;
  return facilities.filter((row) =>
    (state.nearby ? distance(row) <= NEARBY_KM : sameOrChild(state.region, row.region)) &&
    (state.kind === "all" || row.kind === state.kind) &&
    (row.kind === "hospital" || includeInactive || row.status === "사용중") &&
    (!query || searchKey(`${row.name} ${row.address}`).includes(query)),
  ).sort((a, b) => {
    if ($("sort").value === "distance" && distance(a) !== distance(b)) return distance(a) - distance(b);
    return a.name.localeCompare(b.name, "ko");
  });
}

function makeCard({ id, kind, meta, title, subtitle, aside, active }) {
  const symbol = kind === "alert" ? "bell" : kind;
  return `<button type="button" class="list-card" data-id="${escape(id)}" aria-current="${active}">
    <span class="card-icon ${kind}">${icon(symbol)}</span>
    <span class="card-content"><span class="card-meta">${escape(meta)}</span>
    <span class="card-name">${escape(title)}</span><span class="card-address">${escape(subtitle)}</span>
    ${kind === "alert" ? `<span class="scope-tag">${escape(aside)}</span>` : ""}</span>
    ${kind === "alert" ? "" : `<span class="card-distance">${escape(aside)}</span>`}</button>`;
}

function empty(message) {
  return `<p class="empty">${escape(message)}</p>`;
}

function renderList(cards, total, limit) {
  $("results").innerHTML = cards.join("") + (total > limit
    ? `<button class="load-more" type="button" data-action="more">더 보기 · ${count(total - limit)}건</button>` : "");
}

function renderFacilities() {
  visibleFacilities = facilityRows();
  const current = visibleFacilities.find((row) => row.id === state.selectedFacility);
  if (!current) state.facilityDetailOpen = false;
  state.selectedFacility = (current || visibleFacilities[0])?.id || "";
  $("workspace").dataset.detailOpen = String(state.facilityDetailOpen);
  const basis = state.origin ? (state.demo ? "시연 위치 기준" : "내 위치 기준") : regionLabel(state.region);
  $("result-count").textContent = state.region !== null || state.nearby ? `${count(visibleFacilities.length)}개 · ${basis}` : "";
  renderList(visibleFacilities.slice(0, state.facilityLimit).map((row) => makeCard({
    id: row.id, kind: row.kind, meta: types[row.kind], title: row.name,
    subtitle: row.address, aside: distanceText(distance(row)),
    active: row.id === state.selectedFacility && (state.facilityDetailOpen || mobileLayout.matches),
  })), visibleFacilities.length, state.facilityLimit);
  if (!visibleFacilities.length) $("results").innerHTML = empty(state.region === null && !state.nearby
    ? "지역을 선택하면 시설 목록을 볼 수 있어요." : "조건에 맞는 시설이 없어요.");
  renderFacilityDetail(facilityById.get(state.selectedFacility));
}

function detailFields(pairs) {
  return `<dl class="detail-grid">${pairs.map(([title, value, isLink]) => {
    const safeValue = value || "정보 미제공";
    const phone = isLink && /^\+?[\d\s()-]{5,24}$/.test(safeValue) ? safeValue.replace(/[^+\d]/g, "") : "";
    return `<div><dt>${escape(title)}</dt><dd>${phone
      ? `<a href="tel:${phone}">${escape(safeValue)}</a>` : escape(safeValue)}</dd></div>`;
  }).join("")}</dl>`;
}

function renderFacilityDetail(row) {
  if (!row) {
    $("detail-content").innerHTML = '<h2>시설 상세</h2><p class="detail-subtitle">목록에서 시설을 선택하면 주소와 세부 정보를 볼 수 있어요.</p>';
    return;
  }
  const shelter = row.kind === "shelter";
  const capacity = /^\d+$/.test(row.capacity || "") ? `${count(Number(row.capacity))}명` : row.capacity;
  const fields = shelter ? [
    ["운영 상태 · 원본", row.status], ["수용 인원", capacity], ["시설 구분", row.category],
    ["지상·지하 구분", row.level], ["시설 정보 갱신", timestamp(row.updated)],
  ] : [["기관 유형", row.category], ["운영 상태", "실시간 정보 미제공"], ["연락처", row.phone, true]];
  const km = distance(row);
  $("detail-content").innerHTML = `<div class="facility-detail-top">
    <span class="detail-tag ${row.kind}"><i class="category-dot ${row.kind}"></i>${types[row.kind]}</span>
    <button type="button" class="facility-detail-close" data-action="close" aria-label="시설 상세 닫기" title="시설 상세 닫기">${icon("close")}</button>
    </div>
    <h2>${escape(row.name || "시설명 미제공")}</h2><p class="detail-subtitle">${escape(row.address || "주소 미제공")}</p>
    ${Number.isFinite(km) ? `<div class="distance-panel"><span>${state.demo ? "시연 위치" : "내 위치"}에서 직선거리</span>
      <strong>${distanceText(km)}</strong></div>` : ""}
    ${detailFields(fields)}
    ${row.note ? `<p class="detail-note">${escape(row.note)} · 주소는 목록에서 확인할 수 있어요.</p>` : ""}
    ${row.point ? `<button type="button" class="detail-action" data-action="center">${icon("pin")}지도에서 보기</button>` : ""}`;
}

function loadMessages() {
  if (messageLoad) return messageLoad;
  messageState = "loading";
  messageLoad = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "assets/messages.js";
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => { script.remove(); reject(new Error("messages.js")); }, { once: true });
    document.head.append(script);
  }).then(() => {
    const packed = window.SAFEON_MESSAGES;
    messages = packed.rows.map(([id, type, level, sent, target, text], index) => {
      const [regionText, regions] = packed.targets[target];
      const nationwide = regionText.split(",").some((area) => /^전국(?:\s*(?:전체|전역))?$/.test(area.trim()));
      return { id, index, type, level, sent, text, regionText, regions, nationwide };
    });
    const types = [...new Set(messages.map((message) => message.type))].sort((a, b) => a.localeCompare(b, "ko"));
    $("alert-type").append(...types.map((type) => option(type, type)));
    const dates = messages.map((message) => message.sent.slice(0, 10)).filter(Boolean).sort();
    archiveStart = dates[0] || "";
    archiveEnd = dates.at(-1) || "";
    for (const id of ["alert-from", "alert-to"]) {
      $(id).min = archiveStart;
      $(id).max = archiveEnd;
    }
    messageState = "ready";
  }).catch(() => {
    messageState = "failed";
    messageLoad = undefined;
  });
  return messageLoad;
}

function messageScope(message, region) {
  if (region === null) return "";
  if (region === "") {
    if (message.nationwide || message.regions.some((code) => /^[0-9]{2}0{8}$/.test(code))) return "wide";
    return message.regions.length ? "direct" : "unknown";
  }
  if (message.regions.some((code) => !/^[0-9]{2}0{8}$/.test(code) && sameOrChild(region, code))) return "direct";
  if (message.nationwide || message.regions.some((code) => sameOrChild(code, region))) return "wide";
  return "";
}

function renderAlerts() {
  const query = searchKey($("alert-query").value);
  const type = $("alert-type").value;
  const scope = $("alert-scope").value;
  const from = $("alert-from").value;
  const to = $("alert-to").value;
  const dateProblem = from && to && from > to ? "시작일을 종료일과 같거나 이른 날짜로 선택해 주세요." : "";
  const problem = dateProblem || (state.region === null ? "지역을 선택하면 과거 문자를 볼 수 있어요." : "");
  const matches = dateProblem ? [] : messages.filter((message) => {
    const day = message.sent.slice(0, 10);
    return (!type || message.type === type) && (!from || day >= from) &&
      (!to || (day && day <= to)) && (!query || searchKey(message.text).includes(query));
  });
  const seen = new Set();
  visibleAlerts = problem ? [] : matches.filter((message) => {
    const coverage = messageScope(message, state.region);
    const id = message.id || message.index;
    if (!coverage || (scope && coverage !== scope) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!visibleAlerts.some((message) => message === state.selectedAlert)) {
    state.selectedAlert = visibleAlerts[0] || null;
  }
  $("result-count").textContent = `재난문자 ${count(visibleAlerts.length)}건`;
  renderList(visibleAlerts.slice(0, state.alertLimit).map((message) => makeCard({
    id: message.index, kind: "alert", meta: `${message.type} · ${message.sent.slice(0, 16)}`,
    title: message.text, subtitle: message.regionText, aside: ALERT_SCOPES[messageScope(message, state.region)],
    active: message === state.selectedAlert,
  })), visibleAlerts.length, state.alertLimit);
  if (!visibleAlerts.length) $("results").innerHTML = empty(problem || "조건에 맞는 재난문자가 없어요.");
  renderAlertDetail(state.selectedAlert);
  renderAlertStats(visibleAlerts, from || archiveStart, to || archiveEnd, problem);
  if (state.archiveView === "map") renderArchiveMap(matches, from || archiveStart, to || archiveEnd, type, dateProblem);
}

function renderAlertDetail(message) {
  if (!message) {
    $("detail-content").innerHTML = '<h2>문자 상세</h2><p class="detail-subtitle">목록에서 문자를 선택하면 발송 시각, 수신 지역과 원문을 볼 수 있어요.</p>';
    return;
  }
  const scope = ALERT_SCOPES[messageScope(message, state.region)];
  $("detail-content").innerHTML = `<span class="detail-tag alert">${escape(scope)}</span><h2>${escape(message.type)}</h2>
    ${detailFields([["발송 시각", timestamp(message.sent)], ["문자 구분", message.level], ["수신 지역", message.regionText]])}
    <p class="alert-message">${escape(message.text)}</p>`;
}

function renderAlertStats(alerts, from, to, problem) {
  const tally = new Map();
  const scopes = new Map();
  for (const message of alerts) {
    tally.set(message.type, (tally.get(message.type) || 0) + 1);
    const scope = messageScope(message, state.region);
    scopes.set(scope, (scopes.get(scope) || 0) + 1);
  }
  const stats = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
  const largest = stats[0]?.[1] || 1;
  const selectedPeriod = from !== archiveStart || to !== archiveEnd
    ? ` · 조회 기간 ${escape(from)} ~ ${escape(to)}` : "";
  $("archive-stats").innerHTML = `<h2>재난 유형별 문자 발송 건수</h2>
    <p class="detail-subtitle">자료 기간 ${escape(archiveStart)} ~ ${escape(archiveEnd)}</p>
    ${problem ? "" : `<p class="detail-subtitle">${escape(regionLabel(state.region))}${selectedPeriod}</p>
      <div class="archive-total"><strong>${count(alerts.length)}건</strong>
      <span>직접 지정 ${count(scopes.get("direct") || 0)} · 상위 지역·전국 ${count(scopes.get("wide") || 0)}${scopes.has("unknown") ? ` · 지역 미확인 ${count(scopes.get("unknown"))}` : ""}</span></div>`}
    ${stats.length ? `<div class="chart" role="group" aria-label="재난 유형별 문자 발송 건수 막대그래프">
      ${stats.map(([type, frequency]) => `<div class="bar-row"><span>${escape(type)}</span>
        <span class="bar-track" aria-hidden="true"><span class="bar" style="width:${frequency / largest * 100}%"></span></span>
        <strong>${count(frequency)}건</strong></div>`).join("")}</div>` : empty(problem || "이 기간에 집계할 문자가 없어요.")}
    ${stats.length ? '<p class="detail-note">같은 문자 ID는 한 번 집계했어요.</p>' : ""}`;
}

function fitArchiveMap() {
  archiveMap.fitBounds(archiveLayer.getBounds(), { padding: [14, 14], animate: false });
}

function setupArchiveMap() {
  archiveMap = L.map("archive-map", { maxZoom: 13, zoomSnap: 0.25, scrollWheelZoom: false, zoomControl: false })
    .setView(KOREA_CENTER, 7);
  L.control.zoom({ position: "topright" }).addTo(archiveMap);
  archiveMap.attributionControl.setPrefix(false);
  archiveMap.attributionControl.addAttribution(
    '<a href="https://github.com/KnellBalm/kr-admin-geojson" target="_blank" rel="noopener">행정구역 경계 출처</a>',
  );
  archiveLayer = L.geoJSON(archiveDistricts, {
    style: ({ properties }) => ({ interactive: archiveDistrictCodes.has(properties.code) }),
    onEachFeature: ({ properties: { code } }, layer) => {
      if (archiveDistrictCodes.has(code)) layer.on("click", () => selectRegion(code));
      layer.bindTooltip(document.createElement("span"), { className: "archive-map-tooltip", direction: "top" });
    },
  }).addTo(archiveMap);
  archiveLayer.eachLayer((layer) => {
    const { code } = layer.feature.properties;
    if (!archiveDistrictCodes.has(code)) return;
    const path = layer.getElement();
    path.setAttribute("role", "button");
    path.setAttribute("tabindex", "0");
    path.setAttribute("data-region", code);
    path.addEventListener("focus", () => layer.openTooltip());
    path.addEventListener("blur", () => layer.closeTooltip());
    path.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectRegion(code);
    });
  });
  $("archive-map-reset").addEventListener("click", fitArchiveMap);
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (!$("archive-map-view").hidden) archiveMap.invalidateSize({ debounceMoveend: true });
    }).observe($("archive-map"));
  }
  fitArchiveMap();
}

function archiveDirectCounts(alerts) {
  const idsByRegion = new Map();
  for (const message of alerts) {
    for (const code of message.regions) {
      if (!archiveDistrictCodes.has(code)) continue;
      if (!idsByRegion.has(code)) idsByRegion.set(code, new Set());
      idsByRegion.get(code).add(message.id || message.index);
    }
  }
  return new Map([...idsByRegion].map(([code, ids]) => [code, ids.size]));
}

function renderArchiveMap(alerts, from, to, type, dateProblem) {
  $("archive-map-context").textContent = dateProblem || `${from} ~ ${to} · ${type || "모든 재난 유형"} · 직접 지정`;
  for (const id of ["archive-map-frame", "archive-map-legend", "archive-map-selection", "archive-map-note"]) {
    $(id).hidden = Boolean(dateProblem);
  }
  if (dateProblem) return;
  if (!archiveMap) setupArchiveMap();
  archiveMap.invalidateSize({ debounceMoveend: true });
  const counts = archiveDirectCounts(alerts);
  const largest = Math.max(0, ...counts.values());
  const step = Math.max(1, Math.ceil(largest / ARCHIVE_COLORS.length));
  const legend = [[ARCHIVE_ZERO, "0건"]];
  for (let start = 1; start <= largest; start += step) {
    const end = Math.min(largest, start + step - 1);
    const label = start === end ? count(start) : `${count(start)}–${count(end)}`;
    legend.push([ARCHIVE_COLORS[Math.floor((start - 1) / step)], `${label}건`]);
  }
  legend.push([ARCHIVE_UNMATCHED, "지역 연결 미확인"]);
  $("archive-map-legend").innerHTML = legend.map(([color, label]) =>
    `<li><i aria-hidden="true" style="background:${color}"></i>${label}</li>`).join("");
  let selectedText = state.region ? `선택 지역 · ${regionLabel(state.region)}` : "지도에서 지역을 선택하면 해당 지역의 문자 목록을 볼 수 있어요.";
  archiveLayer.eachLayer((layer) => {
    const { code, name } = layer.feature.properties;
    const matched = archiveDistrictCodes.has(code);
    const frequency = counts.get(code) || 0;
    const selected = Boolean(matched && state.region && (code === state.region ||
      (!archiveDistrictCodes.has(state.region) && sameOrChild(state.region, code))));
    const fillColor = matched ? (frequency ? ARCHIVE_COLORS[Math.floor((frequency - 1) / step)] : ARCHIVE_ZERO) : ARCHIVE_UNMATCHED;
    layer.setStyle({
      color: selected ? "#123e32" : "#fff", weight: selected ? 2.5 : 0.9,
      opacity: 1, fillColor, fillOpacity: 1,
    });
    const label = matched ? `${regionLabel(code)} · 직접 지정 ${count(frequency)}건` : `${name} · 지역 연결 미확인`;
    layer.getTooltip().getContent().textContent = label;
    if (matched) {
      layer.getElement().setAttribute("aria-label", label);
      layer.getElement().setAttribute("aria-pressed", String(code === state.region));
    }
    if (code === state.region) selectedText = label;
  });
  $("archive-map-selection").textContent = selectedText;
  $("archive-map-note").textContent = $("alert-scope").value === "wide"
    ? "상위 지역·전국 대상 필터는 문자 목록과 선택 지역 통계에 적용돼요. 지도에는 직접 지정 건수를 표시해요."
    : "시·군·구가 직접 지정된 문자를 지역마다 문자 ID 기준으로 집계해요. 경계가 없는 지역은 목록에서 확인할 수 있어요.";
}

function drawMarkers() {
  markerLayer.clearLayers();
  if (state.view !== "facilities") return;
  const bounds = map.getBounds().pad(.06);
  let markerCount = 0;
  for (const row of visibleFacilities) {
    if (!row.point || !bounds.contains(row.point)) continue;
    const active = state.selectedFacility === row.id && (state.facilityDetailOpen || mobileLayout.matches);
    if (markerCount >= 200 && !active) continue;
    markerCount++;
    const marker = L.marker(row.point, {
      icon: L.divIcon({
        className: "",
        html: `<span class="map-pin ${row.kind}${active ? " active" : ""}">${icon(row.kind)}</span>`,
        iconSize: [31, 31], iconAnchor: [15, 15],
      }),
      alt: `${types[row.kind]} ${row.name}`, title: row.name, zIndexOffset: active ? 400 : 0,
    }).addTo(markerLayer);
    const tooltip = document.createElement("span");
    tooltip.textContent = row.name;
    marker.bindTooltip(tooltip, { direction: "top", className: "facility-tooltip" });
    marker.on("click", () => chooseFacility(row, false, true));
  }
}

function drawPosition() {
  positionLayer.clearLayers();
  if (!state.origin) return;
  const marker = L.marker(state.origin, {
    zIndexOffset: 650,
    icon: L.divIcon({ className: "", html: `<span class="user-point${state.demo ? " demo" : ""}"></span>`,
      iconSize: [19, 19], iconAnchor: [9, 9] }),
    alt: state.demo ? "청주 시연 위치" : "내 현재 위치",
  }).addTo(positionLayer);
  marker.bindTooltip(state.demo ? "청주 시연 위치" : "내 현재 위치");
}

function targetShapes(codes) {
  const selected = new Set();
  for (const code of codes) {
    if (shapes.has(code)) selected.add(shapes.get(code));
    else if (regions[code]) {
      for (const [childCode, shape] of shapes) {
        if (sameOrChild(code, childCode)) selected.add(shape);
      }
    }
  }
  return [...selected];
}

function updateMap(focus = false) {
  $("map-context").textContent = state.region === null && !state.nearby
    ? "주변 안전시설" : `${selectedRegionLabel()} · 시설 지도`;
  if (focus) {
    if (state.nearby) map.setView(state.origin, 14);
    else focusRegion();
  }
  drawMarkers();
}

function focusRegion() {
  if (state.region === CHEONGJU) {
    map.setView(DEMO_POINT, 13);
    return;
  }
  const areas = targetShapes([state.region]);
  if (areas.length) {
    const bounds = L.geoJSON(areas).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [25, 36], maxZoom: 13 });
  } else if (!state.region) {
    map.setView(KOREA_CENTER, 7);
  } else {
    const first = facilities.find((row) => sameOrChild(state.region, row.region) && row.point);
    if (first) map.setView(first.point, 11);
  }
}

function render(focus = false) {
  const { view } = state;
  const isFacilities = view === "facilities";
  $("workspace").dataset.view = view;
  $("browse-title").textContent = isFacilities ? "주변 안전시설" : "재난문자 이력";
  $("facility-controls").hidden = !isFacilities;
  $("alert-controls").hidden = isFacilities;
  $("sort").hidden = !isFacilities;
  $("sort").querySelector('option[value="distance"]').disabled = !state.origin;
  if (!state.origin) $("sort").value = "name";
  $("region").value = state.region ?? "select-region";
  $("location-hint").textContent = state.locationNotice;
  $("location-hint").hidden = !state.locationNotice;
  const mapWasHidden = $("map-panel").hidden;
  $("map-panel").hidden = !isFacilities;
  $("archive-stats").hidden = isFacilities;
  const archiveReady = !isFacilities && messageState === "ready";
  const showArchiveMap = archiveReady && state.archiveView === "map";
  $("archive-switch").hidden = !archiveReady;
  $("archive-map-view").hidden = !showArchiveMap;
  $("detail-content").hidden = showArchiveMap;
  $("archive-switch").querySelectorAll("[data-archive-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.archiveView === state.archiveView));
  });
  document.querySelectorAll("[data-tab], [data-kind]").forEach((button) => {
    const { tab, kind } = button.dataset;
    button.setAttribute("aria-pressed", String(tab === view || kind === state.kind));
  });
  if (isFacilities) {
    const detailWasOpen = $("workspace").dataset.detailOpen;
    renderFacilities();
    if (mapWasHidden || detailWasOpen !== $("workspace").dataset.detailOpen) map.invalidateSize();
    updateMap(focus);
  } else if (messageState === "ready") {
    renderAlerts();
  } else {
    $("result-count").textContent = "";
    $("results").innerHTML = messageState === "failed"
      ? empty("재난문자 파일을 불러오지 못했어요.") + '<button type="button" class="load-more" data-action="retry">다시 불러오기</button>'
      : empty("재난문자 자료를 불러오는 중이에요.");
    $("detail-content").innerHTML = "";
    $("archive-stats").innerHTML = "";
  }
}

async function setView(view, focus = false) {
  state.view = view;
  const loading = view === "alerts" && messageState !== "ready" ? loadMessages() : null;
  render(focus);
  if (loading) {
    await loading;
    if (state.view === view) render();
  }
}

function chooseFacility(row, center, scroll) {
  state.selectedFacility = row.id;
  state.facilityDetailOpen = true;
  render();
  if (row.point) showFacilityPoint(row.point, center);
  if (scroll) {
    if (mobileLayout.matches) $("detail").scrollIntoView({ block: "start" });
    else $("detail").querySelector(".facility-detail-close")?.focus({ preventScroll: true });
  }
}

function showFacilityPoint(point, center) {
  if (center) map.setView(point, Math.max(map.getZoom(), 14), { animate: false });
  if (compactDesktop.matches && state.facilityDetailOpen) {
    const mapRight = $("map-panel").getBoundingClientRect().right;
    const drawerLeft = $("detail").getBoundingClientRect().left;
    map.panInside(point, {
      paddingTopLeft: [24, 36], paddingBottomRight: [mapRight - drawerLeft + 26, 28],
      animate: false,
    });
  }
}

function closeFacilityDetail() {
  const selected = state.selectedFacility;
  state.facilityDetailOpen = false;
  render();
  const card = $("results").querySelector(`[data-id="${CSS.escape(selected)}"]`);
  (card || $("query")).focus({ preventScroll: true });
}

function pointInRing([lat, lng], ring) {
  let inside = false;
  for (let i = 0, previous = ring.length - 1; i < ring.length; previous = i++) {
    const [x1, y1] = ring[previous];
    const [x2, y2] = ring[i];
    if ((y1 > lat) !== (y2 > lat) && lng < x1 + (x2 - x1) * (lat - y1) / (y2 - y1)) {
      inside = !inside;
    }
  }
  return inside;
}

function regionAt(point) {
  const match = geometry.features.find((feature) => {
    const { code, province } = feature.properties;
    if (!regions[code] || (province && code !== "3611000000")) return false;
    const { type, coordinates } = feature.geometry;
    const polygons = type === "Polygon" ? [coordinates] : coordinates;
    return polygons.some(([outer, ...holes]) =>
      pointInRing(point, outer) && !holes.some((ring) => pointInRing(point, ring)));
  });
  return match?.properties.code ?? null;
}

function cancelPositionRequest() {
  locationRequest += 1;
  $("locate").disabled = false;
  state.locationNotice = "";
}

function selectRegion(code) {
  cancelPositionRequest();
  state.region = code;
  state.nearby = false;
  state.facilityLimit = state.alertLimit = PAGE_SIZE;
  render(true);
}

function setPosition(point, demo, initial = false) {
  cancelPositionRequest();
  if (!state.origin) $("sort").value = "distance";
  state.origin = point;
  state.demo = demo;
  state.nearby = !demo;
  state.region = demo ? CHEONGJU : regionAt(point);
  state.facilityLimit = state.alertLimit = PAGE_SIZE;
  state.selectedFacility = "";
  state.facilityDetailOpen = false;
  distances = new Map();
  drawPosition();
  if (initial) render(true);
  else {
    $("query").value = "";
    setView("facilities", true);
    toast(demo ? "청주 시연 위치로 돌아왔어요." : "내 위치를 기준으로 주변 시설을 표시해요.");
  }
}

function findPosition(initial = false) {
  if (!navigator.geolocation) {
    state.locationNotice = "이 브라우저에서는 위치를 확인할 수 없어요. 지역을 선택해 주세요.";
    render();
    return;
  }
  const request = ++locationRequest;
  $("locate").disabled = true;
  state.locationNotice = "현재 위치를 확인하고 있어요.";
  render();
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    if (request === locationRequest) setPosition([coords.latitude, coords.longitude], false, initial);
  }, ({ code }) => {
    if (request !== locationRequest) return;
    cancelPositionRequest();
    state.locationNotice = code === 1 ? "위치 권한이 꺼져 있어요. 지역을 직접 선택할 수 있어요."
      : "현재 위치를 확인할 수 없어요. 지역을 직접 선택할 수 있어요.";
    render();
  }, { timeout: 10000, maximumAge: 30000 });
}

document.querySelector(".navigation").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (button) setView(button.dataset.tab, true);
});
$("region").addEventListener("change", () => selectRegion($("region").value));
$("facility-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-kind]");
  if (!button) return;
  state.kind = button.dataset.kind;
  state.facilityLimit = PAGE_SIZE;
  render();
});
for (const [id, event] of [["query", "input"], ["sort", "change"], ["include-inactive", "change"],
  ["alert-query", "input"], ["alert-type", "change"], ["alert-scope", "change"],
  ["alert-from", "change"], ["alert-to", "change"]]) {
  $(id).addEventListener(event, () => {
    state.facilityLimit = state.alertLimit = PAGE_SIZE;
    render();
  });
}
$("results").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "retry") setView(state.view);
  else if (button.dataset.action === "more") {
    if (state.view === "facilities") state.facilityLimit += PAGE_SIZE;
    else state.alertLimit += PAGE_SIZE;
    render();
  } else if (state.view === "facilities") {
    const row = facilityById.get(button.dataset.id);
    if (row) chooseFacility(row, true, true);
  } else if (state.view === "alerts") {
    state.selectedAlert = messages[Number(button.dataset.id)];
    state.archiveView = "message";
    render();
    if (mobileLayout.matches) $("detail").scrollIntoView({ block: "start" });
  }
});
$("archive-switch").addEventListener("click", (event) => {
  const view = event.target.closest("[data-archive-view]")?.dataset.archiveView;
  if (!view || view === state.archiveView) return;
  state.archiveView = view;
  render();
});
$("detail").addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "close") {
    closeFacilityDetail();
    return;
  }
  if (action === "center") chooseFacility(facilityById.get(state.selectedFacility), true, false);
  if (action && mobileLayout.matches) $("map").scrollIntoView({ block: "center" });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.view === "facilities" && state.facilityDetailOpen && !mobileLayout.matches) {
    closeFacilityDetail();
  }
});
mobileLayout.addEventListener("change", () => {
  if (state.view === "facilities") render();
});
compactDesktop.addEventListener("change", () => {
  if (state.view !== "facilities" || !compactDesktop.matches || !state.facilityDetailOpen) return;
  const point = facilityById.get(state.selectedFacility)?.point;
  if (point) {
    map.invalidateSize();
    showFacilityPoint(point, false);
  }
});
$("locate").addEventListener("click", () => findPosition());
$("demo-location").addEventListener("click", () => setPosition(DEMO_POINT, true));
findPosition(true);
