


async function api(url, opts = {}) {
  const init = { method: opts.method || "GET", credentials: "same-origin" };
  if (init.method === "GET") init.cache = "no-store";
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  let res, data = null;
  try {
    res = await fetch(url, init);
    data = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, status: 0, data: null, error: "Network error — is the server running?" };
  }
  return { ok: res.ok, status: res.status, data, error: data && data.error ? data.error : null };
}


async function uploadFile(inputEl) {
  const f = inputEl.files && inputEl.files[0];
  if (!f) return { url: null, fileName: null };
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if (!["jpg", "jpeg", "png", "pdf", "doc", "docx"].includes(ext)) {
    showToast("⚠️ Allowed files: JPG, PNG, PDF, DOC(X).", "rgba(180,130,0,.85)");
    return false;
  }
  if (f.size > 1536 * 1024) {
    showToast("⚠️ File too large (max 1.5 MB).", "rgba(180,130,0,.85)");
    return false;
  }
  const fd = new FormData();
  fd.append("file", f);
  let res, data;
  try {
    res = await fetch("/api/upload", { method: "POST", credentials: "same-origin", body: fd });
    data = await res.json().catch(() => null);
  } catch (e) {
    showToast("❌ Upload failed — network error.", "rgba(155,22,22,.85)");
    return false;
  }
  if (!res.ok) {
    showToast(`❌ ${(data && data.error) || "Upload failed."}`, "rgba(155,22,22,.85)");
    return false;
  }
  return { url: data.url, fileName: data.fileName };
}


let queueData = [];       // appointment queue (admin view)
let auditLogs = [];       // audit trail (admin view)
let EMAIL_LOG = [];       // outgoing email attempts (admin view)
let EMAIL_CONFIGURED = false;
let NOTIFS = [];          // caller's own notifications
let knownNotificationIds = new Set();
let notificationPollingStarted = false;
let adminDashboardPollingStarted = false;
let adminDashboardSnapshot = "";
let adminDashboardRefreshInFlight = false;
let PENDING_ACCOUNTS = []; // accounts awaiting admin approval
let MASTERLIST_COUNT = 0;
let MOD = { referrals: [], idapps: [], bulletins: [], tickets: [], faqs: [], complaints: [], forms: [], memos: [], requests: [] };
let faqCategories = [];
let ADMIN_ACTIVITY = null;
const REQUESTS_PER_PAGE = 5;
let adminRequestPage = 1;
let lastAdminTableFilterKey = "";


async function loadAdminActivity() { const r = await api("/api/admin/activity"); ADMIN_ACTIVITY = r.ok ? r.data : null; }
async function loadQueueData() { const r = await api("/api/queue"); queueData = r.ok ? r.data : []; }
async function loadAuditLog() { const r = await api("/api/audit"); auditLogs = r.ok ? r.data : []; }
async function loadEmailLog() { const r = await api("/api/emails"); EMAIL_LOG = r.ok ? r.data : []; }
async function loadEmailStatus() { const r = await api("/api/emails/status"); EMAIL_CONFIGURED = r.ok ? !!r.data.configured : false; }
let NOTIFS_INFLIGHT = null, NOTIFS_STARTED = false;
function loadNotifs() { if (!NOTIFS_INFLIGHT) NOTIFS_INFLIGHT = api("/api/notifications").then((r) => { NOTIFS = r.ok ? r.data : []; }).finally(() => { NOTIFS_INFLIGHT = null; }); return NOTIFS_INFLIGHT; }
let UNVERIFIED_ACCOUNTS = []; // signed-in students whose student number is not confirmed yet
async function loadPendingAccounts() {
  if (!isSuperAdmin()) { PENDING_ACCOUNTS = []; UNVERIFIED_ACCOUNTS = []; return; }
  const [r, u] = await Promise.all([api("/api/users/pending"), api("/api/users/unverified")]);
  PENDING_ACCOUNTS = r.ok ? r.data : [];
  UNVERIFIED_ACCOUNTS = u.ok ? u.data : [];
}
const MOD_LOADED = new Set(), MOD_INFLIGHT = {};
function loadModule(key) {
  // Concurrent callers share one request (no duplicate fetches); finished loads are never cached, so data stays fresh.
  if (MOD_INFLIGHT[key]) return MOD_INFLIGHT[key];
  MOD_INFLIGHT[key] = api(`/api/modules/${key}`).then((r) => { MOD[key] = r.ok ? r.data : []; if (r.ok) MOD_LOADED.add(key); }).finally(() => { delete MOD_INFLIGHT[key]; });
  return MOD_INFLIGHT[key];
}
/** Instant navigation: if these modules were loaded before, paint the page from them right away, then refresh in the background. */
async function warmRender(keys, render, extra = []) {
  if (keys.every((k) => MOD_LOADED.has(k))) render();
  await Promise.all([...keys.map((k) => loadModule(k)), ...extra]);
  render();
}
async function loadFaqCategories() { const r = await api("/api/modules/faq-categories"); faqCategories = r.ok ? r.data : []; }

async function refreshMasterlistStatus() {
  const r = await api("/api/masterlist");
  MASTERLIST_COUNT = r.ok ? r.data.count : 0;
  updateMasterlistStatus();
}
function updateMasterlistStatus() {
  const el = document.getElementById("masterlistStatus");
  if (!el) return;
  el.innerHTML = MASTERLIST_COUNT
    ? `<i class="fa-solid fa-circle-check" style="color:#16a34a;margin-right:4px;"></i>Masterlist loaded — ${MASTERLIST_COUNT} student${MASTERLIST_COUNT > 1 ? "s" : ""}`
    : `<i class="fa-solid fa-triangle-exclamation" style="color:#d97706;margin-right:4px;"></i>No masterlist loaded`;
}
const DEFAULT_REGISTRATION_COURSES = ["BSCS", "BSIT", "BSBA", "BSA", "BEED"];
async function loadRegistrationCourses() {
  const select = document.getElementById("regCourse");
  if (!select) return;
  const result = await api("/api/settings?public=registration");
  const courses = result.ok && Array.isArray(result.data?.courses) && result.data.courses.length
    ? result.data.courses
    : DEFAULT_REGISTRATION_COURSES;
  select.innerHTML = courses.map((course) => `<option value="${esc(course)}">${esc(course)}</option>`).join("");
}



let session = null; // { id, email, name, role, course, year }
let selectedDate = null;
let selectedSlot = null;
const appointmentCalendarStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let appointmentCalendarMonth = appointmentCalendarStart.getMonth();
let appointmentCalendarYear = appointmentCalendarStart.getFullYear();
const appointmentDateLabel = (day) => new Date(appointmentCalendarYear, appointmentCalendarMonth, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
let prevPage = null;
let appointmentAvailability = { bookedTimes: [], myAppointment: null, slots: [] };
// Booking page: every service lives in one dropdown (flow spec §§2-5).
// EVENT / PSYCH / GENERAL book a date + time (schedule: true).
// AUTH / EXCUSE / ID are filed as requests inline — no visit to book.
const APPT_SERVICES = [
  { key: "AUTH", label: "Authentication", schedule: false },
  { key: "EXCUSE", label: "Excuse Slip", schedule: false },
  { key: "ID", label: "ID Application", schedule: false },
  { key: "EVENT", label: "Event Request", schedule: true },
  { key: "PSYCH", label: "Psych. Intervention", schedule: true },
  { key: "GENERAL", label: "General Visit", schedule: true },
];
const APPT_REQUEST_ONLY = { AUTH: "AUTHENTICATION", EXCUSE: "EXCUSE_SLIP", ID: "ID", ID_NEW: "ID", ID_LOST: "ID" };
// Backend service keys (history rows may still carry retired AUTH/EXCUSE/ID lanes).
const APPT_SERVICE_LABELS = { AUTH: "Authentication", EXCUSE: "Excuse Slip", ID: "ID Application", ID_NEW: "ID Application — New", ID_LOST: "ID Application — Lost", EVENT: "Event Request", PSYCH: "Psych. Intervention", GENERAL: "General Visit", PENDING: "" };
let appointmentService = "";
// "visit" = scheduled appointments only, "request" = document / ID requests only.
let bookingMode = "visit";
/** Students whose student number the SSO has not confirmed yet can browse and use the Help Desk, but not book. */
function blockUnverified() {
  if (session && session.role === "student" && session.verified === false) {
    showToast("Your account is still being verified by the SSO. Scheduling and requests open once it is confirmed.", "rgba(180,130,0,.9)");
    return true;
  }
  return false;
}
function openNewRequest() { if (blockUnverified()) return; bookingMode = "request"; appointmentService = ""; goTo("page-appointment-book"); }
function openScheduleVisit() { if (blockUnverified()) return; bookingMode = "visit"; appointmentService = ""; goTo("page-appointment-book"); }
function bookingServices() { return APPT_SERVICES.filter((s) => bookingMode === "visit" ? s.schedule : !s.schedule); }
let apptNotesText = "";
let presetAppointmentService = null;
let rescheduleCode = null;
let rescheduleSelectedDate = null;
let rescheduleSelectedSlot = null;
let rescheduleCalMonth = new Date().getMonth();
let rescheduleCalYear = new Date().getFullYear();
const rescheduleDateLabel = (day) => new Date(rescheduleCalYear, rescheduleCalMonth, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
let rescheduleAvailability = { bookedTimes: [], myAppointment: null, slots: [] };
let rescheduleService = "GENERAL";
let liveEventSource = null;
let liveRefreshAt = 0;
let donutChart = null;
let barChartInst = null;

const LAST_ROUTE_KEY = "stars_active_route";
let myApptFilter = "all";

function defaultPageForRole(role) {
  if (role === "admin" || role === "super_admin") return "page-admin";
  if (role === "scanner") return "page-scanner";
  return "page-student";
}

function canAccessPage(role, pageId) {
  if (!pageId || !document.getElementById(pageId)) return false;
  if (["page-login", "page-register"].includes(pageId)) return false;
  if (["page-memo", "page-settings", "page-masterlist", "page-system", "page-audit", "page-accounts"].includes(pageId)) {
    return role === "super_admin";
  }
  if (role === "student" && ["page-admin", "page-manage", "page-appointments", "page-scanner"].includes(pageId)) {
    return false;
  }
  if ((role === "admin" || role === "super_admin") && ["page-student", "page-appointment", "page-myrequests", "page-appointment-book", "page-complaint-new", "page-tickets", "page-ticket-new"].includes(pageId)) {
    return false;
  }
  if (role === "scanner" && !["page-scanner", "page-account"].includes(pageId)) {
    return false;
  }
  return true;
}

function parseRouteHash(raw) {
  const clean = String(raw || "").replace(/^#/, "").trim();
  if (!clean) return { pageId: "", params: {} };
  const [pagePart, queryPart] = clean.split("?");
  const params = {};
  if (queryPart) {
    new URLSearchParams(queryPart).forEach((v, k) => { params[k] = v; });
  }
  return { pageId: pagePart || "", params };
}

function persistActiveRoute(pageId, params) {
  if (["page-login", "page-register"].includes(pageId)) return;
  const qs = params && Object.keys(params).length
    ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString()
    : "";
  const hash = `#${pageId}${qs}`;
  try { sessionStorage.setItem(LAST_ROUTE_KEY, hash); } catch {}
  if (window.location.hash !== hash) {
    try { history.replaceState(null, "", hash); } catch { window.location.hash = hash; }
  }
}

// Login page: light / dark appearance toggle + the two secondary buttons.
function loginToggleTheme(force) {
  const roots = document.querySelectorAll(".lg2"); if (!roots.length) return;
  const dark = typeof force === "boolean" ? force : !roots[0].classList.contains("lg2-dark");
  roots.forEach(r => r.classList.toggle("lg2-dark", dark));
  try { localStorage.setItem("starsLoginTheme", dark ? "dark" : "light"); } catch (e) {}
}
try { if (localStorage.getItem("starsLoginTheme") === "dark") document.addEventListener("DOMContentLoaded", () => loginToggleTheme(true)); } catch (e) {}
/* ---- Dropdown component: <select data-dd> becomes a styled, keyboard-accessible listbox ---- */
function ddInit(sel) {
  if (!sel || sel._dd) return;
  const wrap = document.createElement("div"); wrap.className = "dd";
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "dd-btn";
  btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = '<span class="dd-label"></span><i class="fa-solid fa-chevron-down dd-chev"></i>';
  const list = document.createElement("div"); list.className = "dd-list"; list.setAttribute("role", "listbox");
  wrap.append(btn, list); sel.style.display = "none"; sel.after(wrap); sel._dd = wrap;
  let active = -1;
  const label = btn.firstChild;
  const rebuild = () => {
    const opts = Array.from(sel.options);
    list.innerHTML = opts.map((o, i) => `<div class="dd-opt${i === sel.selectedIndex ? " sel" : ""}" role="option" data-i="${i}" aria-selected="${i === sel.selectedIndex}">${esc(o.textContent)}</div>`).join("");
    const cur = sel.options[sel.selectedIndex];
    label.textContent = cur ? cur.textContent : "Select";
  };
  const open = () => {
    rebuild(); active = sel.selectedIndex;
    wrap.classList.remove("up");
    wrap.classList.add("open"); btn.setAttribute("aria-expanded", "true");
    const r = btn.getBoundingClientRect(), need = Math.min(list.scrollHeight, 240) + 12;
    if (window.innerHeight - r.bottom < need && r.top > need) wrap.classList.add("up");
    const s = list.querySelector(".sel"); if (s) s.scrollIntoView({ block: "nearest" });
  };
  const close = () => { wrap.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); };
  const pick = (i) => { if (i < 0 || i >= sel.options.length) return; sel.selectedIndex = i; rebuild(); close(); sel.dispatchEvent(new Event("change", { bubbles: true })); btn.focus(); };
  const mark = (i) => { active = Math.max(0, Math.min(sel.options.length - 1, i)); list.querySelectorAll(".dd-opt").forEach((el, n) => el.classList.toggle("act", n === active)); const el = list.children[active]; if (el) el.scrollIntoView({ block: "nearest" }); };
  btn.addEventListener("click", () => wrap.classList.contains("open") ? close() : open());
  list.addEventListener("mousedown", e => e.preventDefault());
  list.addEventListener("click", e => { const o = e.target.closest(".dd-opt"); if (o) pick(+o.dataset.i); });
  btn.addEventListener("keydown", e => {
    const isOpen = wrap.classList.contains("open");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!isOpen) { open(); return; } mark(active + (e.key === "ArrowDown" ? 1 : -1)); }
    else if (e.key === "Home" && isOpen) { e.preventDefault(); mark(0); }
    else if (e.key === "End" && isOpen) { e.preventDefault(); mark(sel.options.length - 1); }
    else if ((e.key === "Enter" || e.key === " ") && isOpen) { e.preventDefault(); pick(active); }
    else if (e.key === "Escape" && isOpen) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") close();
  });
  document.addEventListener("click", e => { if (!wrap.contains(e.target)) close(); });
  sel.addEventListener("change", rebuild);
  new MutationObserver(rebuild).observe(sel, { childList: true });
  rebuild();
}
function ddInitAll(root) { (root || document).querySelectorAll("select[data-dd]").forEach(ddInit); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => ddInitAll()); else ddInitAll();
/* ===== File attachment component: <input type="file" data-fu> becomes a drop zone with a file chip ===== */
function fileFmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
function fileIcon(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  return ext === "pdf" ? "fa-file-pdf" : ["doc", "docx"].includes(ext) ? "fa-file-word" : ["jpg", "jpeg", "png", "webp"].includes(ext) ? "fa-file-image" : "fa-file-lines";
}
try {
  let ddQueued = false;
  new MutationObserver(() => {
    if (ddQueued) return; ddQueued = true;
    requestAnimationFrame(() => { ddQueued = false; document.querySelectorAll("select[data-dd]").forEach((sel) => { if (!sel._dd) ddInit(sel); }); });
  }).observe(document.documentElement, { childList: true, subtree: true });
} catch (_) {}
function fileInit(inp) {
  if (!inp || inp._fu) return;
  const max = +(inp.dataset.max || 1572864);
  const allowed = String(inp.accept || "").split(",").map((s) => s.trim().replace(/^\./, "").toLowerCase()).filter((s) => s && !s.includes("/"));
  const hint = inp.dataset.hint || `${allowed.map((e) => e.toUpperCase()).join(", ")}${allowed.length ? " · " : ""}max ${fileFmtSize(max)}`;
  const wrap = document.createElement("div"); wrap.className = "fu";
  wrap.innerHTML = `<div class="fu-drop" tabindex="0" role="button" aria-label="Choose a file to attach"><span class="fu-ic"><i class="fa-solid fa-cloud-arrow-up"></i></span><span class="fu-txt"><span><b>Choose a file</b> or drag it here</span><small>${esc(hint)}</small></span></div>
    <div class="fu-file" hidden><span class="fu-ic fu-ic-file"><i class="fa-solid fa-file"></i></span><span class="fu-meta"><b></b><small></small></span><button type="button" class="fu-btn fu-change">Change</button><button type="button" class="fu-x" aria-label="Remove file" title="Remove file"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="fu-err" role="alert" hidden></div>`;
  inp.style.display = "none"; inp.after(wrap); inp._fu = wrap;
  const drop = wrap.querySelector(".fu-drop"), chip = wrap.querySelector(".fu-file"), err = wrap.querySelector(".fu-err");
  const check = (f) => {
    const ext = f.name.split(".").pop().toLowerCase();
    if (allowed.length && !allowed.includes(ext)) return `That file type isn’t allowed. Use ${allowed.map((e) => e.toUpperCase()).join(", ")}.`;
    if (f.size > max) return `File is too large (${fileFmtSize(f.size)}). The limit is ${fileFmtSize(max)}.`;
    return "";
  };
  const paint = () => {
    const f = inp.files && inp.files[0];
    drop.hidden = !!f; chip.hidden = !f;
    if (f) {
      chip.querySelector(".fu-ic-file i").className = "fa-solid " + fileIcon(f.name);
      chip.querySelector(".fu-meta b").textContent = f.name;
      chip.querySelector(".fu-meta small").textContent = fileFmtSize(f.size);
    }
  };
  const take = (f) => {
    const e = f ? check(f) : "";
    err.hidden = !e; err.textContent = e;
    if (e) { inp.value = ""; paint(); return; }
    if (f && !(inp.files && inp.files[0] === f)) { try { const dt = new DataTransfer(); dt.items.add(f); inp.files = dt.files; } catch {} }
    paint();
  };
  inp.addEventListener("change", () => take(inp.files && inp.files[0]));
  const pick = () => inp.click();
  drop.addEventListener("click", pick);
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  chip.querySelector(".fu-change").addEventListener("click", pick);
  chip.querySelector(".fu-x").addEventListener("click", () => { inp.value = ""; err.hidden = true; paint(); inp.dispatchEvent(new Event("input", { bubbles: true })); });
  ["dragenter", "dragover"].forEach((t) => wrap.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => wrap.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  wrap.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) take(f); });
  paint();
}
function fileInitAll(root) { (root || document).querySelectorAll("input[type=file][data-fu]").forEach(fileInit); }
function fileClear(inp) { if (!inp) return; inp.value = ""; inp.dispatchEvent(new Event("change", { bubbles: true })); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => fileInitAll()); else fileInitAll();
/* ---- Shared top bar: breadcrumb (left) · notifications + profile (right). Used by every signed-in page. ---- */
const TOPBAR_LABELS = {
  "page-student": "Dashboard", "page-appointment": "My Appointments", "page-myrequests": "My Requests", "page-referral": "Referrals", "page-idapp": "ID Applications",
  "page-bulletin": "Student Bulletin", "page-helpdesk": "Help Desk", "page-ticket-new": "New Ticket", "page-tickets": "Help Desk", "page-faq": "FAQs", "page-complaint": "Complaints", "page-complaint-new": "New Complaint",
  "page-forms": "Forms", "page-account": "My Profile",
  "page-admin": "Dashboard", "page-appointments": "All Appointments", "page-manage": "Service Management", "page-settings": "System Settings", "page-requests": "All Requests",
  "page-masterlist": "Masterlist", "page-accounts": "Accounts", "page-system": "Analytics", "page-audit": "Audit Logs", "page-memo": "Email Blast", "page-scanner": "QR Scanner"
};
function topbarCrumb(pageId) {
  const el = document.getElementById("tbCrumb"); if (!el || !session) return;
  const staff = session.role !== "student";
  const home = staff ? (session.role === "scanner" ? "page-scanner" : "page-admin") : "page-student";
  let label = TOPBAR_LABELS[pageId] || "";
  if (pageId === "page-appointment-book") label = bookingMode === "request" ? "New Request" : "Schedule a Visit";
  const root = staff ? "Admin" : "Home";
  const icon = staff ? "fa-shield-halved" : "fa-house";
  el.innerHTML = `<a href="#" onclick="goTo('${home}');return false;"><i class="fa-solid ${icon}"></i>${root}</a>` + (pageId === home || !label ? (label ? `<span class="tb-sep">/</span><span aria-current="page">${esc(label)}</span>` : "") : `<span class="tb-sep">/</span><span aria-current="page">${esc(label)}</span>`);
}
(function () { const upd = () => { const t = document.getElementById("appTopbar"); if (t) t.classList.toggle("scrolled", window.scrollY > 8); }; window.addEventListener("scroll", upd, { passive: true }); })();
/* ---- Profile dropdown (top-right, all signed-in pages) ---- */
function pmRefresh() {
  if (!session) return;
  const nm = String(session.name || "Account").trim();
  const ini = nm.split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase() || "A";
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set("pmInitials", ini); set("pmInitials2", ini); set("pmName", nm.split(/\s+/)[0]); set("pmFull", nm);
  set("pmRole", String(session.role || "").split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));
}
function pmToggle(e) { if (e) e.stopPropagation(); const w = document.getElementById("profileMenu"); w.classList.contains("open") ? pmClose() : pmOpen(); }
function pmOpen() { const w = document.getElementById("profileMenu"); if (!w) return; w.classList.add("open"); document.getElementById("pmBtn").setAttribute("aria-expanded", "true"); const p = document.getElementById("bellPanel"); if (p) p.style.display = "none"; const f = w.querySelector(".pm-item"); if (f) f.focus(); }
function pmClose() { const w = document.getElementById("profileMenu"); if (!w) return; w.classList.remove("open"); const b = document.getElementById("pmBtn"); if (b) b.setAttribute("aria-expanded", "false"); }
function pmGo(page) { pmClose(); goTo(page); }
document.addEventListener("click", e => { const w = document.getElementById("profileMenu"); if (w && w.classList.contains("open") && !w.contains(e.target)) pmClose(); });
document.addEventListener("keydown", e => {
  const w = document.getElementById("profileMenu"); if (!w || !w.classList.contains("open")) return;
  if (e.key === "Escape") { pmClose(); document.getElementById("pmBtn").focus(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const it = Array.from(w.querySelectorAll(".pm-item")); const i = it.indexOf(document.activeElement); it[(i + (e.key === "ArrowDown" ? 1 : -1) + it.length) % it.length].focus(); }
});
let passScanInst = null;
function loginScanQr() {
  closePassCheck();
  const el = document.createElement("div");
  el.id = "passCheckModal"; el.className = "lgh-overlay";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Check a QR pass");
  el.onclick = e => { if (e.target === el) closePassCheck(); };
  el.innerHTML = `<div class="lgh-box" style="max-width:440px"><div class="lgh-head"><div><h3>Check a QR Pass</h3><p>See the status of your appointment. No login needed.</p></div><button type="button" class="lgh-close" onclick="closePassCheck()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="lgh-body"><div id="passResult"></div><div id="passScanArea"><div id="passReader" class="pc-reader"></div><button type="button" id="passCamBtn" class="lgh-ok pc-wide" onclick="passStartCam()"><i class="fa-solid fa-camera"></i> Scan with camera</button></div><div class="pc-or"><span>or enter it manually</span></div><div class="pc-form"><input id="passCode" class="pc-input" placeholder="Appointment code (APT-123)" maxlength="30" autocomplete="off"><input id="passSn" class="pc-input" placeholder="Student number" maxlength="30" autocomplete="off" onkeydown="if(event.key==='Enter')passCheckManual()"><button type="button" class="lgh-ok pc-wide" onclick="passCheckManual()">Check status</button></div></div></div>`;
  document.body.appendChild(el);
  document.addEventListener("keydown", passCheckEsc);
}
function passCheckEsc(e) { if (e.key === "Escape") closePassCheck(); }
async function passStopCam() {
  if (passScanInst) { try { await passScanInst.stop(); } catch {} try { await passScanInst.clear(); } catch {} passScanInst = null; }
  const r = document.getElementById("passReader"); if (r) r.style.display = "none";
  const b = document.getElementById("passCamBtn"); if (b) b.style.display = "";
}
function closePassCheck() {
  document.removeEventListener("keydown", passCheckEsc);
  passStopCam();
  const m = document.getElementById("passCheckModal");
  if (!m || m.classList.contains("closing")) return;
  m.classList.add("closing");
  setTimeout(() => m.remove(), 100);
}
async function passStartCam() {
  if (typeof window.Html5Qrcode === "undefined") { passShow({ error: "Camera scanner is still loading. Try again or enter the code manually." }); return; }
  const r = document.getElementById("passReader"), b = document.getElementById("passCamBtn");
  r.style.display = "block"; b.style.display = "none";
  try {
    passScanInst = new window.Html5Qrcode("passReader");
    await passScanInst.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 220, height: 220 } }, async (text) => {
      await passStopCam();
      passLookup({ payload: text });
    }, () => {});
  } catch {
    await passStopCam();
    passShow({ error: "Camera access was denied or is unavailable. Enter the code manually below." });
  }
}
function passCheckManual() {
  const code = (document.getElementById("passCode").value || "").trim();
  const studentId = (document.getElementById("passSn").value || "").trim();
  if (!code || !studentId) { passShow({ error: "Enter both the appointment code and your student number." }); return; }
  passLookup({ code, studentId });
}
async function passLookup(body) {
  passShow({ loading: true });
  try {
    const res = await fetch("/api/public/pass-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    passShow(res.ok ? { data } : { error: data.error || "Could not check the pass." });
  } catch { passShow({ error: "Network problem. Please try again." }); }
}
function passShow(o) {
  const box = document.getElementById("passResult"); if (!box) return;
  if (o.loading) { box.innerHTML = `<div class="pc-msg"><i class="fa-solid fa-spinner fa-spin"></i> Checking…</div>`; return; }
  if (o.error) { box.innerHTML = `<div class="pc-msg pc-err"><i class="fa-solid fa-circle-exclamation"></i> ${esc(o.error)}</div>`; return; }
  const d = o.data;
  box.innerHTML = `<div class="pc-card"><div class="pc-code">${esc(d.code)}</div><div class="pc-status">${esc(d.status)}</div><div class="pc-row"><i class="fa-solid fa-clipboard-list"></i>${esc(d.service)}</div><div class="pc-row"><i class="fa-solid fa-calendar-day"></i>${esc(d.dateLabel)}</div><div class="pc-row"><i class="fa-solid fa-clock"></i>${esc(d.time)}</div><p class="pc-note">Log in to see the full details or manage this appointment.</p></div>`;
}
function loginNeedHelp() {
  closeLoginHelp();
  const steps = [
    ["fa-user-plus", "I don't have an account yet", ["Click <b>Register here</b> under the login button.", "Enter your student number, name and your active email, then tap <b>Send OTP</b>.", "Type the 6-digit code sent to your email (check Spam if it is missing).", "Create a password and press <b>Create Account</b>. You can log in right away."]],
    ["fa-right-to-bracket", "How do I log in?", ["Enter your <b>student number or email</b> and your password.", "Use the eye icon to check what you typed.", "Too many wrong attempts can lock the account for a few minutes. Wait, then try again."]],
    ["fa-key", "I forgot my password", ["Type your student number or email in the first field.", "Click <b>Forgot Password?</b> and follow the instructions sent to your email.", "Still stuck? Visit the Student Services Office with your school ID."]],
    ["fa-qrcode", "What is the QR pass?", ["After you schedule a visit or request a pickup, a QR pass appears in your account.", "Show it at the office so staff can scan it. No need to line up to get a number.", "Keep your screen brightness up; a screenshot works offline.", "No login? Use <b>Scan QR Pass</b> on this page to check your appointment status."]],
    ["fa-calendar-check", "What can I do once I'm in?", ["<b>Schedule a Visit</b> for ID, registrar, and other office appointments.", "<b>New Request</b> for documents, ID applications, referrals, and complaints.", "Track every item under <b>My Requests</b> and <b>My Appointments</b>."]],
    ["fa-headset", "Still need help?", ["Log in and open <b>Help Desk</b> to chat with the assistant any time.", "Or visit the <b>Student Services Office, PUP San Pedro</b> during office hours and bring your school ID."]]
  ];
  const body = steps.map((st, n) => `<div class="lgh-item${n === 0 ? " open" : ""}" style="--i:${n}"><button type="button" class="lgh-sum" aria-expanded="${n === 0}" onclick="loginHelpToggle(this)"><i class="fa-solid ${st[0]}"></i><span>${st[1]}</span><i class="fa-solid fa-chevron-down lgh-chev"></i></button><div class="lgh-panel"><div class="lgh-inner"><ol>${st[2].map(x => `<li>${x}</li>`).join("")}</ol></div></div></div>`).join("");
  const el = document.createElement("div");
  el.id = "loginHelpModal"; el.className = "lgh-overlay";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Login help guide");
  el.onclick = e => { if (e.target === el) closeLoginHelp(); };
  el.innerHTML = `<div class="lgh-box"><div class="lgh-head"><div><h3>How can we help?</h3><p>Quick guide to getting into STARS</p></div><button type="button" class="lgh-close" onclick="closeLoginHelp()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="lgh-body">${body}</div><div class="lgh-foot"><button type="button" class="lgh-ok" onclick="closeLoginHelp()">Got it</button></div></div>`;
  document.body.appendChild(el);
  document.addEventListener("keydown", loginHelpEsc);
}
function loginHelpEsc(e) { if (e.key === "Escape") closeLoginHelp(); }
function loginHelpToggle(btn) {
  const item = btn.parentElement, wasOpen = item.classList.contains("open");
  document.querySelectorAll("#loginHelpModal .lgh-item").forEach(i => { i.classList.remove("open"); i.querySelector(".lgh-sum").setAttribute("aria-expanded", "false"); });
  if (!wasOpen) { item.classList.add("open"); btn.setAttribute("aria-expanded", "true"); }
}
function closeLoginHelp() {
  document.removeEventListener("keydown", loginHelpEsc);
  const m = document.getElementById("loginHelpModal");
  if (!m || m.classList.contains("closing")) return;
  m.classList.add("closing");
  setTimeout(() => m.remove(), 100);
}
async function loadPublicSplash() {
  try {
    const res = await api("/api/settings/public");
    if (!res.ok || !res.data) return;
    const saved = res.data.loginSplashUrl;
    const url = !saved || saved === "/pup-san-pedro-campus.svg" ? "/pup-campus.png" : saved;
    const cap = res.data.loginSplashCaption || "PUP San Pedro Campus — Student Services Office";
    document.querySelectorAll(".auth-splash-img").forEach((img) => { img.onerror = () => { img.onerror = null; img.src = "/pup-campus.png"; }; img.src = url; });
    document.querySelectorAll(".auth-splash-caption").forEach((el) => { el.textContent = cap; });
  } catch {}
}

window.addEventListener("hashchange", () => {
  if (!session) return;
  const { pageId, params } = parseRouteHash(window.location.hash);
  if (!pageId || !canAccessPage(session.role, pageId)) return;
  const active = document.querySelector(".page.active")?.id;
  if (pageId !== active || (params.filter && pageId === "page-appointment" && params.filter !== myApptFilter)) {
    goTo(pageId, { params, skipHash: true });
  }
});

async function restoreSession() {
  void loadPublicSplash();
  syncFloatingChatbotVisibility("page-login");
  const r = await api("/api/auth/me");
  if (r.ok && r.data && r.data.user) {
    session = r.data.user;
    startLiveUpdates();
    const fromHash = parseRouteHash(window.location.hash);
    let saved = "";
    try { saved = sessionStorage.getItem(LAST_ROUTE_KEY) || ""; } catch {}
    const fromStorage = parseRouteHash(saved);
    const chosen = canAccessPage(session.role, fromHash.pageId)
      ? fromHash
      : canAccessPage(session.role, fromStorage.pageId)
        ? fromStorage
        : { pageId: defaultPageForRole(session.role), params: {} };
    await goTo(chosen.pageId, { params: chosen.params });
  }
}


async function doLogin() {
  const userVal = document.getElementById("loginUser").value.trim();
  const passVal = document.getElementById("loginPass").value;
  let valid = true;

  ["loginUser", "loginPass"].forEach((id) => document.getElementById(id).classList.remove("error"));
  ["loginUserErr", "loginPassErr"].forEach((id) => document.getElementById(id).classList.remove("show"));

  if (!userVal) {
    document.getElementById("loginUser").classList.add("error");
    document.getElementById("loginUserErr").classList.add("show");
    document.getElementById("loginUserErrMsg").textContent = "Please enter your student number or email.";
    valid = false;
  }
  if (!passVal) {
    document.getElementById("loginPass").classList.add("error");
    document.getElementById("loginPassErr").classList.add("show");
    document.getElementById("loginPassErrMsg").textContent = "Please enter your password.";
    valid = false;
  }
  if (!valid) return;

  const { ok, data } = await api("/api/auth/login", { method: "POST", body: { identifier: userVal, password: passVal } });

  if (!ok) {
    const code = data && data.code;
    if (code === "NOT_APPROVED") {
      document.getElementById("loginUser").classList.add("error");
      document.getElementById("loginUserErr").classList.add("show");
      document.getElementById("loginUserErrMsg").textContent = data.error;
      showToast("⏳ Your account is awaiting admin approval.", "rgba(180,130,0,.85)");
      return;
    }
    document.getElementById("loginUser").classList.add("error");
    document.getElementById("loginPass").classList.add("error");
    document.getElementById("loginPassErr").classList.add("show");
    document.getElementById("loginPassErrMsg").textContent = (data && data.error) || "Incorrect credentials. Please try again.";
    const box = document.getElementById("loginPass").closest(".modal-box");
    box.classList.remove("shake"); void box.offsetWidth; box.classList.add("shake");
    showToast("❌ Invalid credentials.", "rgba(155,22,22,.85)");
    return;
  }

  session = data.user;
  startLiveUpdates();
  if (session.role === "student") await goTo("page-student");
  else if (session.role === "admin" || session.role === "super_admin") await goTo("page-admin");
  else await goTo("page-scanner");
  showToast("✅ Welcome, " + session.name + "!");
}

function showRegError(msg) {
  const el = document.getElementById("regError");
  if (el) { el.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:5px;"></i>${esc(msg)}`; el.style.display = "block"; }
}
function clearRegError() { const el = document.getElementById("regError"); if (el) el.style.display = "none"; }

let regOtpCooldownTimer = null;
async function sendRegisterOtp() {
  const btn = document.getElementById("regSendOtpBtn");
  const statusEl = document.getElementById("regOtpStatus");
  if (btn?.disabled) return;
  clearRegError();
  const sn = (document.getElementById("regStudNum")?.value || "").trim();
  const email = (document.getElementById("regEmail")?.value || "").trim();
  if (!sn || !email) {
    showRegError("Enter your student number and email address before requesting an OTP.");
    return;
  }
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px;"></i>Sending…'; }
  const { ok, data } = await api("/api/auth/register/send-otp", { method: "POST", body: { sn, email } });
  if (!ok) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="margin-right:5px;"></i>Send OTP'; }
    showRegError((data && data.error) || "Could not send verification code.");
    return;
  }
  const devHint = data && data.devOtp ? ` (Dev OTP: ${data.devOtp})` : "";
  if (statusEl) {
    statusEl.style.color = "#15803d";
    statusEl.innerHTML = `<i class="fa-solid fa-circle-check" style="margin-right:4px;"></i>6-digit OTP sent to <b>${esc(email)}</b> (valid for 10 minutes).${esc(devHint)}`;
  }
  showToast("✅ Verification code sent to your email!");
  let left = 60;
  if (regOtpCooldownTimer) clearInterval(regOtpCooldownTimer);
  regOtpCooldownTimer = setInterval(() => {
    left--;
    if (!btn) return;
    if (left <= 0) {
      clearInterval(regOtpCooldownTimer);
      regOtpCooldownTimer = null;
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="margin-right:5px;"></i>Resend OTP';
    } else {
      btn.textContent = `Resend (${left}s)`;
    }
  }, 1000);
}

async function handleRegister() {
  const submitButton = document.getElementById("registerSubmitBtn");
  if (submitButton?.disabled) return;
  clearRegError();
  const first = document.getElementById("regFirst").value.trim();
  const last = document.getElementById("regLast").value.trim();
  const sn = document.getElementById("regStudNum").value.trim();
  const email = document.getElementById("regEmail").value.trim();
  const otp = (document.getElementById("regOtp")?.value || "").trim();
  const pass = document.getElementById("regPass").value;
  const passConfirm = (document.getElementById("regPassConfirm")?.value || "");
  const course = document.getElementById("regCourse").value;
  const year = document.getElementById("regYear").value;

  if (!first || !last || !sn || !email || !pass) {
    showRegError("Please complete all fields before creating your account.");
    return;
  }
  if (!/^\d{6}$/.test(otp)) {
    showRegError("Please enter the 6-digit verification code (OTP) sent to your email.");
    return;
  }
  if (pass.length < 9 || !/[A-Z]/.test(pass) || !/[a-z]/.test(pass) || !/[0-9]/.test(pass) || !/[^A-Za-z0-9]/.test(pass)) {
    showRegError("Password must be more than 8 characters (9+) and include uppercase, lowercase, a number, and a special character.");
    return;
  }
  if (pass !== passConfirm) {
    showRegError("Passwords do not match. Please re-enter your confirmation password.");
    return;
  }

  if (submitButton) { submitButton.disabled = true; submitButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px;"></i>CREATING ACCOUNT…'; }
  const { ok, data } = await api("/api/auth/register", { method: "POST", body: { first, last, sn, email, otp, password: pass, course, year } });
  if (!ok) {
    if (submitButton) { submitButton.disabled = false; submitButton.innerHTML = '<i class="fa-solid fa-user-plus" style="margin-right:8px;"></i>CREATE ACCOUNT'; }
    showRegError((data && data.error) || "Could not create your account.");
    return;
  }

  showToast(data && data.approved
    ? "✅ Account created! Sign in now — scheduling opens once the SSO verifies your student number."
    : "✅ Account created! It will be reviewed by the SSO — you can sign in once approved.");
  ["regFirst", "regLast", "regStudNum", "regEmail", "regOtp", "regPass", "regPassConfirm"].forEach((id) => { const e = document.getElementById(id); if (e) e.value = ""; });
  if (submitButton) { submitButton.disabled = false; submitButton.innerHTML = '<i class="fa-solid fa-user-plus" style="margin-right:8px;"></i>CREATE ACCOUNT'; }
  setTimeout(() => goTo("page-login"), 1200);
}
function clearLoginForm() {
  ["loginUser", "loginPass"].forEach((id) => {
    const field = document.getElementById(id);
    if (field) { field.value = ""; field.classList.remove("error"); }
  });
  ["loginUserErr", "loginPassErr"].forEach((id) => document.getElementById(id)?.classList.remove("show"));
  const remember = document.querySelector('#page-login input[type="checkbox"]');
  if (remember) remember.checked = false;
}

/* ---- Registration wizard ---- */
let rgStep = 1;
const RG_LAST = 4;
function rgGo(n) {
  rgStep = Math.max(1, Math.min(RG_LAST, n));
  document.querySelectorAll("#page-register .rg-step").forEach(s => s.classList.toggle("active", +s.dataset.step === rgStep));
  document.querySelectorAll("#page-register .rg-st").forEach(s => { const i = +s.dataset.s; s.classList.toggle("active", i === rgStep); s.classList.toggle("done", i < rgStep); });
  const q = id => document.getElementById(id);
  if (q("rgBack")) q("rgBack").style.display = rgStep === 1 ? "none" : "flex";
  if (q("rgSignin")) q("rgSignin").style.display = rgStep === 1 ? "" : "none";
  if (q("rgNext")) q("rgNext").style.display = rgStep === RG_LAST ? "none" : "";
  if (q("registerSubmitBtn")) q("registerSubmitBtn").style.display = rgStep === RG_LAST ? "" : "none";
  if (rgStep === RG_LAST) rgRenderReview();
  clearRegError();
  const first = document.querySelector(`#page-register .rg-step[data-step="${rgStep}"] input, #page-register .rg-step[data-step="${rgStep}"] .dd-btn`);
  if (first && rgStep < RG_LAST) setTimeout(() => { try { first.focus({ preventScroll: true }); } catch {} }, 60);
}
function rgValidate(n) {
  const v = id => (document.getElementById(id)?.value || "").trim();
  if (n === 1) {
    if (!v("regFirst") || !v("regLast")) return "Enter your first and last name.";
    if (!/^\d{4}-\d{5}-SP-\d$/.test(v("regStudNum"))) return "Student number must look like 2024-00000-SP-0.";
    const c = v("regCourse"); if (!c || /^loading/i.test(c)) return "Choose your course.";
  }
  if (n === 2) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v("regEmail"))) return "Enter a valid email address.";
    if (!/^\d{6}$/.test(v("regOtp"))) return "Enter the 6-digit code we sent to your email. Use Send OTP if you have not received one.";
  }
  if (n === 3) {
    const p = document.getElementById("regPass")?.value || "";
    if (p.length < 9 || !/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/[0-9]/.test(p) || !/[^A-Za-z0-9]/.test(p)) return "Password must be 9+ characters with uppercase, lowercase, a number and a symbol.";
    if (p !== (document.getElementById("regPassConfirm")?.value || "")) return "Passwords do not match.";
  }
  return "";
}
function rgNext() {
  clearRegError();
  const err = rgValidate(rgStep);
  if (err) { showRegError(err); return; }
  rgGo(rgStep + 1);
}
function rgBack() { rgGo(rgStep - 1); }
function rgRenderReview() {
  const v = id => (document.getElementById(id)?.value || "").trim();
  const rows = [
    [1, "Name", `${v("regFirst")} ${v("regLast")}`],
    [1, "Student number", v("regStudNum")],
    [1, "Course", v("regCourse")],
    [1, "Year level", v("regYear")],
    [2, "Email", v("regEmail")],
    [2, "Verification code", "\u2022".repeat(6)],
    [3, "Password", "\u2022".repeat(Math.min(12, (document.getElementById("regPass")?.value || "").length))]
  ];
  const box = document.getElementById("rgReview"); if (!box) return;
  box.innerHTML = rows.map(r => `<div class="rg-rv-row"><dt>${esc(r[1])}</dt><dd>${esc(r[2])}</dd><button type="button" class="rg-edit" onclick="rgGo(${r[0]})">Edit</button></div>`).join("");
}
document.addEventListener("input", e => { if (e.target && e.target.closest && e.target.closest("#page-register .rg-step")) clearRegError(); });
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" || rgStep === RG_LAST) return;
  const t = e.target; if (!t || t.tagName !== "INPUT" || !t.closest("#page-register")) return;
  e.preventDefault(); rgNext();
});
function clearRegisterForm() {
  if (typeof rgGo === "function") rgGo(1);
  ["regFirst", "regLast", "regStudNum", "regEmail", "regOtp", "regPass", "regPassConfirm"].forEach((id) => {
    const field = document.getElementById(id);
    if (field) { field.value = ""; field.style.borderColor = ""; }
  });
  const otpStatus = document.getElementById("regOtpStatus");
  if (otpStatus) { otpStatus.style.color = "rgba(30,5,5,.7)"; otpStatus.textContent = "We'll send a 6-digit verification code to verify your email."; }
  ["regCourse", "regYear"].forEach((id) => {
    const field = document.getElementById(id);
    if (field) { field.selectedIndex = 0; field.dispatchEvent(new Event("change")); }
  });
  clearRegError();
  const helper = document.getElementById("studNumHelper");
  if (helper) helper.innerHTML = '<i class="fa-solid fa-circle-info" style="margin-right:3px;"></i>Format: 2024-00000-SP-0';
  checkStrength("");
  const button = document.getElementById("registerSubmitBtn");
  if (button) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-user-plus" style="margin-right:8px;"></i>CREATE ACCOUNT'; }
}


async function goTo(pageId, opts) {
  const params = (opts && opts.params) || {};
  // page-services was removed — stale links/deep-links land on the dashboard.
  if (pageId === "page-services") pageId = "page-student";
  const publicPages = ["page-login", "page-register"];
  if (!publicPages.includes(pageId) && !session) {
    showToast("⚠️ Please sign in first.", "rgba(139,26,26,.9)");
    pageId = "page-login";
  }
  if (session) {
    if (pageId === "page-memo" && !isSuperAdmin()) {
      showToast("⚠️ Email Blast is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (pageId === "page-settings" && !isSuperAdmin()) {
      showToast("⚠️ System Settings is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (pageId === "page-masterlist" && !isSuperAdmin()) {
      showToast("\u26a0\ufe0f Masterlist is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (pageId === "page-system" && !isSuperAdmin()) {
      showToast("\u26a0\ufe0f Analytics is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (pageId === "page-audit" && !isSuperAdmin()) {
      showToast("\u26a0\ufe0f Audit Logs is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (pageId === "page-accounts" && !isSuperAdmin()) {
      showToast("\u26a0\ufe0f Accounts is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (session.role === "student" && (pageId === "page-admin" || pageId === "page-manage" || pageId === "page-appointments")) {
      showToast("⚠️ Access denied.", "rgba(139,26,26,.9)"); return;
    }
    if ((session.role === "admin" || session.role === "super_admin") && (pageId === "page-student" || pageId === "page-appointment" || pageId === "page-myrequests" || pageId === "page-appointment-book" || pageId === "page-complaint-new" || pageId === "page-tickets" || pageId === "page-ticket-new")) {
      showToast("⚠️ Access denied.", "rgba(139,26,26,.9)"); return;
    }
  }
  if (pageId === "page-appointment" && params.filter) {
    myApptFilter = String(params.filter);
  }
  if (pageId === "page-appointments" && params.view && ["calendar", "list"].includes(params.view)) {
    adminApptView = params.view;
  }
  if (pageId === "page-appointments" && params.status != null) {
    adminApptStatus = String(params.status);
  }
  if (document.querySelector(".page.active")?.id === "page-admin" && pageId !== "page-admin") {
    if (donutChart) { try { donutChart.destroy(); } catch (e) {} donutChart = null; }
    if (barChartInst) { try { barChartInst.destroy(); } catch (e) {} barChartInst = null; }
  }
  prevPage = document.querySelector(".page.active")?.id;
  if (prevPage === "page-scanner" && pageId !== "page-scanner" && typeof stopQrScanner === "function") void stopQrScanner();
  if (prevPage === "page-login" && pageId !== "page-login") clearLoginForm();
  if (prevPage === "page-register" && pageId !== "page-register") clearRegisterForm();
  if (pageId === "page-login" && prevPage !== "page-login") clearLoginForm();
  if (pageId === "page-register" && prevPage !== "page-register") clearRegisterForm();
  window.__qrsPageScroll = window.__qrsPageScroll || {};
  if (prevPage && prevPage !== pageId) window.__qrsPageScroll[prevPage] = window.scrollY;
  document.querySelectorAll(".page").forEach((p) => { p.classList.remove("active"); p.style.display = "none"; });
  const p = document.getElementById(pageId);
  p.classList.add("active");
  p.style.display = publicPages.includes(pageId) ? "flex" : "block";
  const savedScroll = window.__qrsPageScroll[pageId] || 0;
  requestAnimationFrame(() => window.scrollTo({ top: savedScroll, left: 0, behavior: "auto" }));

  if (!opts?.skipHash && session && !publicPages.includes(pageId)) {
    const routeParams = {};
    if (pageId === "page-appointment" && myApptFilter && myApptFilter !== "all") routeParams.filter = myApptFilter;
    if (pageId === "page-appointments" && adminApptView && adminApptView !== "calendar") routeParams.view = adminApptView;
    persistActiveRoute(pageId, routeParams);
  }

  const noNav = ["page-login", "page-register"];
  document.getElementById("mainNav").style.display = noNav.includes(pageId) ? "none" : "block";
  { const tb = document.getElementById("appTopbar"); if (tb) tb.style.display = (noNav.includes(pageId) || !session) ? "none" : "flex"; pmClose(); topbarCrumb(pageId); }
  if (noNav.includes(pageId)) closeMobileMenu();
  void updateNav(pageId); // sidebar active state updates immediately; data loads below never block it
  if (pageId === "page-student") { const keys = ["requests", "idapps", "events2", "referrals", "tickets"]; if (keys.every((k) => MOD_LOADED.has(k))) renderStudentPage(); await Promise.all(keys.map((k) => loadModule(k))); renderStudentPage(); }
  if (pageId === "page-admin") {
    if (window.__adminWarm) renderAdminPage();
    await Promise.all([loadQueueData(), loadAuditLog(), loadEmailLog(), loadEmailStatus(), loadPendingAccounts(), refreshMasterlistStatus(), loadAdminActivity()]);
    window.__adminWarm = true;
    renderAdminPage();
  }
  if (pageId === "page-appointments") { const keys = ["requests", "idapps", "events2", "referrals"]; if (window.__apptWarm && keys.every((k) => MOD_LOADED.has(k))) renderAdminAppointments(); await Promise.all([loadQueueData(), ...keys.map((k) => loadModule(k))]); window.__apptWarm = true; renderAdminAppointments(); }
  const _bp = document.getElementById("bellPanel"); if (_bp) _bp.style.display = "none";
  if (pageId === "page-appointment") renderMyAppointments();
  if (pageId === "page-myrequests") renderMyRequests();
  if (pageId === "page-appointment-book") { buildServiceChips(); buildCalendar(); }
  if (pageId === "page-complaint-new") void cnInit();
  if (pageId === "page-scanner") loadScannerQueue();
  if (pageId === "page-manage") renderManageHub();
  if (pageId === "page-masterlist") await loadMasterlistPage();
  if (pageId === "page-accounts") await loadAccountsPage();
  if (pageId === "page-system") await loadSystemPage();
  if (pageId === "page-audit") await renderAuditPage();
  if (pageId === "page-settings") renderSettingsPage();
  if (pageId === "page-account") renderAccountPage();
  if (pageId === "page-referral") await warmRender(["referrals"], renderReferral);
  if (pageId === "page-idapp") await warmRender(["idapps"], renderIdApp);
  if (pageId === "page-bulletin") await warmRender(["bulletins"], renderBulletin);
  if (pageId === "page-tickets") {
    pageId = "page-helpdesk";
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    document.getElementById("page-helpdesk")?.classList.add("active");
    topbarCrumb("page-helpdesk");
    void updateNav("page-helpdesk");
  }
  const isFullHelpdesk = pageId === "page-helpdesk" && !!session;
  document.body.classList.toggle("is-helpdesk-full", isFullHelpdesk);
  if (!isFullHelpdesk) {
    tktAdoptTopbarControls(false);
  } else {
    const tb = document.getElementById("appTopbar");
    if (tb) tb.style.display = "none";
  }
  syncFloatingChatbotVisibility(pageId);
  if (pageId === "page-helpdesk") {
    void ensureMyFeedbackLoaded();
    await warmRender(["tickets"], renderHelpdesk);
  }
  if (pageId === "page-ticket-new") {
    await loadModule("tickets");
    renderNewTicketPage();
  }
  if (pageId === "page-faq") await warmRender(["faqs"], renderFaq, [loadFaqCategories(), loadCuration()]);
  if (pageId === "page-requests") await warmRender(isAdmin() ? ["requests", "idapps"] : ["requests"], renderServiceRequests);
  if (pageId === "page-complaint") { await loadComplaintData(); renderComplaint(); }
  if (pageId === "page-forms") await warmRender(["forms"], renderForms);
  if (pageId === "page-memo") await warmRender(["memos"], renderMemo);
  if (["page-login", "page-register"].includes(pageId)) {
    await Promise.all([refreshMasterlistStatus(), loadRegistrationCourses(), loadPublicSplash()]);
  }
}
async function goBack() { await goTo(prevPage || (isAdmin() ? "page-admin" : "page-student")); }


async function updateNav(pageId) {
  if (!session) return;
  pmRefresh();
  if (!NOTIFS_STARTED) {
    NOTIFS_STARTED = true;
    loadNotifs().then(() => { if (!knownNotificationIds.size) knownNotificationIds = new Set(NOTIFS.map((n) => n.id)); startNotificationPolling(); startAdminDashboardPolling(); updateBellBadge(); });
  }
  const role = session.role === "super_admin" ? "admin" : session.role;
  const links = {
    student: [{ label: "Dashboard", icon: "fa-house", page: "page-student" }, { label: "Requests", icon: "fa-file-lines", page: "page-myrequests" }, { label: "Appointments", icon: "fa-calendar-check", page: "page-appointment" }],
    admin: [{ label: "Dashboard", icon: "fa-gauge", page: "page-admin" }, { label: "Manage", icon: "fa-table-cells-large", page: "page-manage" }],
    scanner: [{ label: "Scanner", icon: "fa-qrcode", page: "page-scanner" }],
  };
  const iconMap = { student: "fa-user-graduate", admin: "fa-shield-halved", scanner: "fa-qrcode" };
  const items = links[role] || links.student;
  let navItems, mobileItems;
  if (role === "admin") {
    window.__qrsCurrentPage = pageId;
    const dashActive = pageId === "page-admin" ? " active" : "";
    navItems = `<button onclick="goTo('page-admin')" class="nav-link${dashActive}"><i class="fa-solid fa-gauge"></i><span>Dashboard</span></button>` + adminNavGroupsHtml(pageId, false);
    mobileItems = `<button onclick="goTo('page-admin');closeMobileMenu();" class="nav-link" style="justify-content:flex-start;"><i class="fa-solid fa-gauge" style="font-size:11px;color:#F5C518;"></i>Dashboard</button>` + adminNavGroupsHtml(pageId, true);
  } else if (role === "student") {
    window.__qrsCurrentPage = pageId;
    const dashActive = pageId === "page-student" ? " active" : "";
    navItems = `<button onclick="goTo('page-student')" class="nav-link${dashActive}"><i class="fa-solid fa-house"></i><span>Dashboard</span></button>` + studentNavGroupsHtml(pageId, false);
    mobileItems = `<button onclick="goTo('page-student');closeMobileMenu();" class="nav-link" style="justify-content:flex-start;"><i class="fa-solid fa-house" style="font-size:11px;color:#F5C518;"></i>Dashboard</button>` + studentNavGroupsHtml(pageId, true);
  } else {
    navItems = items.map((l) => `<button onclick="goTo('${l.page}')" class="nav-link ${pageId === l.page ? "active" : ""}"><i class="fa-solid ${l.icon}"></i><span>${l.label}</span></button>`).join("");
    mobileItems =
      items.map((l) => `<button onclick="goTo('${l.page}');closeMobileMenu();" class="nav-link" style="justify-content:flex-start;"><i class="fa-solid ${l.icon}" style="font-size:11px;color:#F5C518;"></i>${l.label}</button>`).join("");
  }
  document.getElementById("desktopNavLinks").innerHTML = navItems;
  pmRefresh();
  updateBellBadge();
  document.getElementById("mobileMenuLinks").innerHTML =
    mobileItems +
    `<div style="height:1px;background:rgba(255,255,255,.14);margin:10px 0;"></div>` +
    `<button onclick="goTo('page-account');closeMobileMenu();" class="nav-link" style="justify-content:flex-start;"><i class="fa-solid fa-gear" style="font-size:11px;color:#F5C518;"></i>My Profile</button>` +
    `<button onclick="signOut()" class="nav-link" style="color:rgba(239,68,68,.7);justify-content:flex-start;margin-top:4px;"><i class="fa-solid fa-right-from-bracket"></i>Logout</button>`;
}
/* ===== Account Settings: profile card + section nav on the left, one section at a time on the right ===== */
let ACC_TAB = "profile";
function accTab(t) {
  ACC_TAB = t === "security" ? "security" : "profile";
  document.querySelectorAll("#accountBody .as-nav button").forEach((b) => { const on = b.dataset.t === ACC_TAB; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  document.querySelectorAll("#accountBody .as-sec").forEach((s) => { s.hidden = s.dataset.t !== ACC_TAB; });
}
function accPwField(label, id, placeholder, hint) {
  return bkField(label, `<div class="bk-input"><input id="${id}" type="password" autocomplete="${id === "cpCurrent" ? "current-password" : "new-password"}" placeholder="${placeholder}" oninput="accPwLive()"><button type="button" class="as-eye" onclick="togglePass('${id}',this)" aria-label="Show or hide password"><i class="fa-solid fa-eye"></i></button></div>`, { for: id, req: true, help: hint });
}
function accPwLive() {
  const v = document.getElementById("cpNew")?.value || "", c = document.getElementById("cpConfirm")?.value || "";
  const rules = { len: v.length >= 9, up: /[A-Z]/.test(v), low: /[a-z]/.test(v), num: /[0-9]/.test(v), sym: /[^A-Za-z0-9]/.test(v) };
  Object.entries(rules).forEach(([k, ok]) => { const e = document.querySelector(`#accPwRules [data-r="${k}"]`); if (e) e.classList.toggle("ok", ok); });
  const m = document.getElementById("cpMatch");
  if (m) { m.hidden = !c; const same = c && v === c; m.className = "bk-help as-match " + (same ? "ok" : "bad"); m.innerHTML = same ? '<i class="fa-solid fa-circle-check"></i>Passwords match' : '<i class="fa-solid fa-circle-xmark"></i>Passwords don’t match yet'; }
  pwNote("");
}
function pwNote(text, ok) { const m = document.getElementById("pwMsg"); if (!m) return; m.textContent = text || ""; m.hidden = !text; m.className = "as-msg " + (ok ? "ok" : "bad"); }
async function renderAccountPage() {
  const box = document.getElementById("accountBody");
  if (!box || !session) return;
  const u = session;
  const isStudent = u.role === "student";
  const roleLabel = (u.role || "").split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const ini = String(u.name || "A").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "A";
  let pu = u, pending = null, courses = DEFAULT_REGISTRATION_COURSES;
  if (isStudent) {
    const [cur, reg] = await Promise.all([api("/api/profile"), api("/api/settings?public=registration")]);
    if (cur.ok) { pu = cur.data.user || u; pending = cur.data.pending || null; }
    if (reg.ok && Array.isArray(reg.data?.courses) && reg.data.courses.length) courses = reg.data.courses;
  }
  const opt = (list, val) => { const l = val && !list.includes(val) ? [val, ...list] : list; return l.map((o) => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join(""); };
  const kv = (label, value) => value ? `<div class="dm-kv"><span>${esc(label)}</span><b>${esc(value)}</b></div>` : "";
  let profile;
  if (isStudent) {
    const details = `<div class="dm-kvs dm-kvs-box">${kv("Student number", u.id)}${kv("Role", roleLabel)}</div>`;
    profile = pending
      ? `${details}<div class="ml-notice" style="margin-top:16px;"><i class="fa-solid fa-hourglass-half"></i><span><b>Update awaiting verification.</b> Student Services is reviewing the changes below. You can submit another update once this one is processed.</span></div>
         <div class="dm-kvs dm-kvs-box">${kv("Full name", pending.name)}${kv("Email", pending.email)}${kv("Course", pending.course)}${kv("Year level", pending.year)}</div>`
      : `${details}<h3 class="bk-h" style="margin-top:22px;">Edit profile</h3>
         <div class="bk-form" style="max-width:640px;">
           <div class="dm-two">
             ${bkField("Full name", `<div class="bk-input"><input id="profileName" type="text" autocomplete="name" value="${esc(pu.name || "")}"></div>`, { for: "profileName", req: true })}
             ${bkField("Email", `<div class="bk-input"><input id="profileEmail" type="email" autocomplete="email" value="${esc(pu.email || "")}"></div>`, { for: "profileEmail", req: true })}
           </div>
           <div class="dm-two">
             ${bkField("Course", `<div class="bk-input"><select id="profileCourse" data-dd="1">${opt(courses, pu.course || "")}</select></div>`)}
             ${bkField("Year level", `<div class="bk-input"><select id="profileYear" data-dd="1">${opt(["1st Year", "2nd Year", "3rd Year", "4th Year"], pu.year || "")}</select></div>`)}
           </div>
           <div class="bk-note" style="margin:0;"><i class="fa-solid fa-circle-info"></i><span>Changes are reviewed by Student Services before they are applied.</span></div>
           <div><button type="button" class="bk-btn bk-btn-fill" onclick="saveProfileEdit()"><i class="fa-solid fa-paper-plane"></i>Submit for review</button></div>
         </div>`;
  } else {
    profile = `<div class="dm-kvs dm-kvs-box">${kv("Name", u.name)}${kv("Email", u.email)}${kv("Role", roleLabel)}</div>
      <div class="bk-note"><i class="fa-solid fa-circle-info"></i><span>Staff profile details are managed by a Super Admin.</span></div>`;
  }
  const rule = (k, t) => `<span data-r="${k}"><i class="fa-solid fa-circle-check"></i>${t}</span>`;
  box.innerHTML = `<div class="as">
    <aside class="as-side">
      <div class="as-card">
        <div class="as-av" aria-hidden="true">${esc(ini)}</div>
        <div class="as-name">${esc(u.name || "")}</div>
        <div class="as-mail">${esc(u.email || "")}</div>
        <span class="bl-cat">${esc(roleLabel)}</span>
        ${isStudent && (u.course || u.year) ? `<div class="as-meta">${esc([u.course, u.year].filter(Boolean).join(" · "))}</div>` : ""}
      </div>
      <nav class="as-nav" role="tablist" aria-label="Account sections">
        <button type="button" role="tab" data-t="profile" onclick="accTab('profile')"><i class="fa-solid fa-user"></i>Profile</button>
        <button type="button" role="tab" data-t="security" onclick="accTab('security')"><i class="fa-solid fa-lock"></i>Security</button>
      </nav>
    </aside>
    <div class="as-panel">
      <section class="as-sec" data-t="profile"><h2 class="as-h">Profile</h2><p class="as-sub">Your account information.</p>${profile}</section>
      <section class="as-sec" data-t="security" hidden><h2 class="as-h">Security</h2><p class="as-sub">Change the password you use to sign in.</p>
        <div class="bk-form" style="max-width:520px;">
          ${accPwField("Current password", "cpCurrent", "Enter your current password")}
          ${accPwField("New password", "cpNew", "Create a new password")}
          <div class="as-rules" id="accPwRules">${rule("len", "9+ characters")}${rule("up", "Uppercase")}${rule("low", "Lowercase")}${rule("num", "Number")}${rule("sym", "Symbol")}</div>
          ${accPwField("Confirm new password", "cpConfirm", "Type the new password again")}
          <div id="cpMatch" class="bk-help as-match" hidden></div>
          <div id="pwMsg" class="as-msg" role="alert" hidden></div>
          <div><button type="button" class="bk-btn bk-btn-fill" onclick="submitChangePassword()"><i class="fa-solid fa-key"></i>Update password</button></div>
        </div>
      </section>
    </div></div>`;
  ddInitAll(box);
  accTab(ACC_TAB);
}
function openAdminDashboardShortcut(status) {
  goTo("page-appointments", { params: { view: "list", status: status || "" } });
}
async function submitChangePassword() {
  const currentPassword = document.getElementById("cpCurrent")?.value;
  const newPassword = document.getElementById("cpNew")?.value;
  const confirmPassword = document.getElementById("cpConfirm")?.value;
  if (!currentPassword || !newPassword) { pwNote("Enter your current and new password."); return; }
  if (newPassword.length < 9 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
    pwNote("Password must be 9+ characters with uppercase, lowercase, a number and a symbol.");
    return;
  }
  if (newPassword !== confirmPassword) { pwNote("New passwords do not match."); return; }
  const result = await api("/api/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
  pwNote(result.ok ? "Password updated." : (result.error || "Could not update password."), result.ok);
  if (result.ok) { ["cpCurrent", "cpNew", "cpConfirm"].forEach((id) => { const e = document.getElementById(id); if (e) e.value = ""; }); accPwLive(); pwNote("Password updated.", true); }
  showToast(result.ok ? "Password updated." : (result.error || "Could not update password."), result.ok ? undefined : "rgba(155,22,22,.85)");
}
function toggleMobileMenu() { document.getElementById("mobileMenu").classList.toggle("open"); document.getElementById("mobileMenuBackdrop").classList.toggle("open"); }
function closeMobileMenu() { document.getElementById("mobileMenu").classList.remove("open"); document.getElementById("mobileMenuBackdrop").classList.remove("open"); }
async function signOut() {
  await api("/api/auth/logout", { method: "POST" });
  if (liveEventSource) { liveEventSource.close(); liveEventSource = null; }
  session = null;
  MOD_LOADED.clear(); NOTIFS_STARTED = false; NOTIFS = []; window.__adminWarm = false; window.__apptWarm = false; // never show the previous user's cached data
  myApptFilter = "all";
  MY_FEEDBACK = {};
  MY_FEEDBACK_LOADED = false;
  ML_A = null; ML_R = null; ML_Q = { a: "", r: "" };
  if (BATCH_SEL) { Object.values(BATCH_SEL).forEach((s) => s.clear()); }
  try { sessionStorage.removeItem(LAST_ROUTE_KEY); } catch {}
  try { history.replaceState(null, "", "#page-login"); } catch {}
  await goTo("page-login");
  showToast("Signed out successfully.");
}


async function renderStudentPage() {
  if (!session || session.role !== "student") return;
  document.getElementById("studentWelcomeName").textContent = String(session.name || "Student").trim().split(/\s+/)[0];
  const vb = document.getElementById("verifyBanner");
  if (vb) {
    const unverified = session.verified === false;
    vb.style.display = unverified ? "flex" : "none";
    document.querySelectorAll("#page-student .sd-qbtn").forEach((b) => { b.classList.toggle("is-locked", unverified); b.title = unverified ? "Available once the SSO verifies your student number" : ""; });
  }

  const hist = await api("/api/queue?mine=1&history=1");
  const visits = hist.ok ? hist.data : [];
  MOD.visits = visits;
  const approved = visits.filter(isApprovedVisit);
  const pickups = studentPickups();

  const sid0 = session.id;
  const myReqs = (MOD.requests || []).filter((r) => r.sn === sid0);
  const myIdApps = (MOD.idapps || []).filter((x) => x.sn === sid0);
  const myEvents = (MOD.events2 || []).filter((x) => x.sn === sid0);
  const myRefs = (MOD.referrals || []).filter((x) => x.sn === sid0);
  const myTickets = (MOD.tickets || []).filter((t) => t.sn === sid0);

  // 1. Upcoming Visits & Pickups
  const upcomingCount = approved.length + pickups.length;
  const nextVisit = [...approved].sort((a, b) => new Date(a.startsAt || a.date || 0) - new Date(b.startsAt || b.date || 0))[0];
  const nextPickup = pickups[0];
  let upcomingSub = "No visits scheduled";
  if (nextVisit) {
    upcomingSub = `Next: ${nextVisit.dateLabel || nextVisit.date || "Scheduled"}${nextVisit.time ? ` · ${nextVisit.time}` : ""}`;
  } else if (nextPickup) {
    upcomingSub = `Pickup: ${nextPickup.dateLabel || nextPickup.pickupDate || "Ready at OSS"}`;
  }
  const kPend = document.getElementById("kpiPending"); if (kPend) kPend.textContent = upcomingCount;
  const kPendSub = document.getElementById("kpiPendingSub"); if (kPendSub) kPendSub.textContent = upcomingSub;

  // 2. Ready for Action (ready to claim/pickup OR revision requested)
  const readyIds = new Set();
  pickups.forEach((p) => readyIds.add(p.id || p.q || p.code || JSON.stringify(p)));
  myReqs.filter((r) => !REQ_TERMINAL_RE.test(r.status || "") && /(ready|pickup|for release|for claim)/i.test(r.status || "")).forEach((r) => readyIds.add(r.id));
  myIdApps.filter((x) => !isTerminalIdApp(x.status) && /(ready|pickup|for release|for claim)/i.test(x.status || "")).forEach((x) => readyIds.add(x.id));
  const revCount =
    myReqs.filter((r) => !REQ_TERMINAL_RE.test(r.status || "") && /(revision|returned|incomplete|action)/i.test(r.status || "")).length +
    myIdApps.filter((x) => !isTerminalIdApp(x.status) && /(revision|returned|incomplete|action)/i.test(x.status || "")).length +
    myEvents.filter((x) => !isTerminalEvent(x.status) && /(revision|returned|incomplete|action)/i.test(x.status || "")).length +
    myRefs.filter((x) => !isTerminalReferral(x.status) && /(revision|returned|incomplete|action)/i.test(x.status || "")).length;
  const readyCount = readyIds.size;
  const actionTotal = readyCount + revCount;
  const kReady = document.getElementById("kpiReady"); if (kReady) kReady.textContent = actionTotal;
  const kReadyBadge = document.getElementById("kpiReadyBadge");
  if (kReadyBadge) {
    if (actionTotal > 0) {
      kReadyBadge.textContent = readyCount > 0 ? "Ready" : "Action";
      kReadyBadge.hidden = false;
    } else {
      kReadyBadge.hidden = true;
    }
  }
  const kReadySub = document.getElementById("kpiReadySub");
  if (kReadySub) {
    if (readyCount && revCount) kReadySub.textContent = `${readyCount} ready to claim · ${revCount} revision`;
    else if (readyCount) kReadySub.textContent = `${readyCount} ${readyCount === 1 ? "item" : "items"} ready for pickup`;
    else if (revCount) kReadySub.textContent = `${revCount} ${revCount === 1 ? "request needs" : "requests need"} revision`;
    else kReadySub.textContent = "All caught up";
  }

  // 3. Active Requests (in-progress across documents, IDs, events, referrals)
  const activeAll = [
    ...myReqs.filter((r) => !REQ_TERMINAL_RE.test(r.status || "")),
    ...myIdApps.filter((x) => !isTerminalIdApp(x.status)),
    ...myEvents.filter((x) => !isTerminalEvent(x.status)),
    ...myRefs.filter((x) => !isTerminalReferral(x.status)),
  ];
  const pendingReqs = activeAll.filter((x) => /^(pending|submitted|pending review)/i.test((x.status || "").trim())).length;
  const inReviewReqs = activeAll.length - pendingReqs;
  const kAct = document.getElementById("kpiActive"); if (kAct) kAct.textContent = activeAll.length;
  const kActSub = document.getElementById("kpiActiveSub");
  if (kActSub) {
    if (!activeAll.length) kActSub.textContent = "No active requests";
    else if (pendingReqs && inReviewReqs) kActSub.textContent = `${pendingReqs} pending · ${inReviewReqs} in progress`;
    else if (pendingReqs) kActSub.textContent = `${pendingReqs} awaiting SSO review`;
    else kActSub.textContent = `${inReviewReqs} being processed`;
  }

  // 4. Support Tickets (open & answered Help Desk tickets)
  const openTickets = myTickets.filter((t) => t.status !== "Closed");
  const answeredTickets = openTickets.filter((t) => t.status === "Answered");
  const unratedClosed = myTickets.filter((t) => t.status === "Closed" && !hdTicketFeedback(t));
  const kTkt = document.getElementById("kpiTickets"); if (kTkt) kTkt.textContent = openTickets.length;
  const kTktBadge = document.getElementById("kpiTicketsBadge");
  if (kTktBadge) {
    if (answeredTickets.length > 0) {
      kTktBadge.textContent = `${answeredTickets.length} reply`;
      kTktBadge.hidden = false;
    } else if (unratedClosed.length > 0 && openTickets.length === 0) {
      kTktBadge.textContent = "Rate";
      kTktBadge.hidden = false;
    } else {
      kTktBadge.hidden = true;
    }
  }
  const kTktSub = document.getElementById("kpiTicketsSub");
  if (kTktSub) {
    if (answeredTickets.length > 0) kTktSub.textContent = `${answeredTickets.length} new ${answeredTickets.length === 1 ? "reply" : "replies"} from OSS`;
    else if (openTickets.length > 0) kTktSub.textContent = "Awaiting OSS response";
    else if (unratedClosed.length > 0) kTktSub.textContent = `${unratedClosed.length} closed · rate support`;
    else kTktSub.textContent = "No open tickets";
  }

  renderDashboardAppointments(visits);
  renderStudentCalendar();
  renderStudentBulletin();
  renderStudentAppointment();
  renderStudentRequestCard(visits);
}

function openDashboardShortcut(kind) {
  if (kind === "tickets") { goTo("page-helpdesk"); return; }
  if (kind === "requests" || kind === "ready") { myReqFilter = "active"; goTo("page-myrequests"); return; }
  if (kind === "next") {
    const s = window.__qrsNextShortcut;
    if (s && s.type === "appointment" && s.code) { viewMyAppointment(s.code); return; }
    if (s && s.type === "pickup" && s.id) { viewMyRequest("request", s.id); return; }
    goTo("page-appointment-book");
    return;
  }
  myApptFilter = kind || "all";
  goTo("page-appointment", { params: { filter: myApptFilter } });
}

function setMyApptFilter(filter) {
  myApptFilter = filter || "all";
  persistActiveRoute("page-appointment", myApptFilter === "all" ? {} : { filter: myApptFilter });
  renderMyAppointments(true);
}


// ── Student dashboard: personal calendar + monthly bulletin ──
var STU_CAL = { y: new Date().getFullYear(), m: new Date().getMonth(), sel: "", items: [], closed: [] };
var STU_CAL_ICON = { appointment: "fa-calendar-check", pickup: "fa-box-open", event: "fa-star" };
function stuIso(y, m, d) { return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
function stuCalMove(delta) { const d = new Date(STU_CAL.y, STU_CAL.m + delta, 1); STU_CAL.y = d.getFullYear(); STU_CAL.m = d.getMonth(); STU_CAL.sel = ""; renderStudentCalendar(); }
function stuCalToday() { const d = new Date(); STU_CAL.y = d.getFullYear(); STU_CAL.m = d.getMonth(); STU_CAL.sel = stuIso(d.getFullYear(), d.getMonth(), d.getDate()); renderStudentCalendar(); }
function stuCalSelect(iso) { STU_CAL.sel = iso; drawStudentCalendar(); }
async function renderStudentCalendar() {
  const box = document.getElementById("studentCalendar"); if (!box) return;
  const last = new Date(STU_CAL.y, STU_CAL.m + 1, 0).getDate();
  const r = await api(`/api/calendar?from=${stuIso(STU_CAL.y, STU_CAL.m, 1)}&to=${stuIso(STU_CAL.y, STU_CAL.m, last)}`);
  STU_CAL.items = r.ok ? r.data.items : []; STU_CAL.closed = r.ok ? r.data.closed : [];
  drawStudentCalendar();
}
function drawStudentCalendar() {
  const box = document.getElementById("studentCalendar"); if (!box) return;
  const { y, m } = STU_CAL;
  const first = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate();
  const now = new Date(), todayIso = stuIso(now.getFullYear(), now.getMonth(), now.getDate());
  const by = {}; STU_CAL.items.forEach((i) => { (by[i.date] = by[i.date] || []).push(i); });
  let cells = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => `<div class="sc-dow">${d}</div>`).join("");
  for (let i = 0; i < first; i++) cells += `<div></div>`;
  for (let d = 1; d <= last; d++) {
    const iso = stuIso(y, m, d), its = by[iso] || [], closed = STU_CAL.closed.includes(iso);
    const types = [...new Set(its.map((i) => i.type))];
    const label = `${new Date(y, m, d).toLocaleDateString("en-US", { month: "long", day: "numeric" })}${its.length ? `: ${its.length} item${its.length === 1 ? "" : "s"}` : ""}${closed ? " (office closed)" : ""}`;
    cells += `<button type="button" class="sc-day${iso === todayIso ? " today" : ""}${iso === STU_CAL.sel ? " sel" : ""}${closed ? " closed" : ""}" title="${esc(label)}" aria-label="${esc(label)}" onclick="stuCalSelect('${iso}')"><span>${d}</span><span class="sc-dots">${types.map((t) => `<i class="fa-solid ${STU_CAL_ICON[t]}"></i>`).join("")}</span></button>`;
  }
  const title = new Date(y, m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  box.innerHTML = `<div style="font-weight:800;font-size:13px;text-align:center;margin-bottom:8px;">${esc(title)}</div><div class="sc-grid">${cells}</div>
    <div class="sc-legend"><span><i class="fa-solid fa-calendar-check"></i> Appointment</span><span><i class="fa-solid fa-box-open"></i> Pickup</span><span><i class="fa-solid fa-star"></i> Event</span></div>`;
  const dayBox = document.getElementById("studentCalDay"); if (!dayBox) return;
  const sel = STU_CAL.sel, list = sel ? (by[sel] || []) : [];
  if (!sel) { dayBox.innerHTML = `<div class="insight-hint">Select a day to see what is scheduled.</div>`; return; }
  const nice = new Date(`${sel}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  dayBox.innerHTML = `<div style="font-size:12px;font-weight:800;margin-bottom:6px;">${esc(nice)}${STU_CAL.closed.includes(sel) ? ' <span class="badge badge-rejected">Office closed</span>' : ""}</div>` +
    (list.length ? list.map((i) => `<button type="button" class="sc-item" onclick="stuCalOpen('${esc(i.type)}','${esc(i.ref)}')" title="Open details"><i class="fa-solid ${STU_CAL_ICON[i.type]}"></i><span><b>${esc(i.title)}</b><br><small>${esc(i.time)} \u00b7 ${esc(i.ref)} \u00b7 ${esc(String(i.status).replace(/_/g, " "))}</small></span></button>`).join("") : `<div class="insight-hint">Nothing scheduled.</div>`);
}
function stuCalOpen(type, ref) {
  if (type === "appointment") return viewMyAppointment(ref);
  if (type === "event") return viewMyRequest("event", ref);
  return viewMyRequest(/^IDA/i.test(ref) ? "idapp" : "request", ref);
}
var STU_BUL = { month: "" };
function stuBulSet(v) { STU_BUL.month = v; drawStudentBulletin(); }
async function renderStudentBulletin() {
  if (!document.getElementById("studentBulletin")) return;
  await loadModule("bulletins");
  drawStudentBulletin();
}
function bulletinAge(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return "Today"; if (d === 1) return "Yesterday"; if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function drawStudentBulletin() {
  const box = document.getElementById("studentBulletin"); if (!box) return;
  const now = Date.now();
  const when = (b) => +new Date(b.publishAt || b.createdAt);
  const list = (MOD.bulletins || []).filter((b) => (b.status === "Published" || !b.status) && (!b.publishAt || b.publishAt <= now))
    .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || when(b) - when(a));
  window.__saList = list.slice(0, 4);
  const kind = (c) => /event|org/i.test(c || "") ? ["fa-calendar-days", "sa-ev"] : /urgent|advis|notice/i.test(c || "") ? ["fa-triangle-exclamation", "sa-ur"] : ["fa-bullhorn", "sa-an"];
  box.innerHTML = window.__saList.length ? `<div class="sa-list">${window.__saList.map((b, n) => {
    const [ic, cls] = kind(b.category);
    const body = String(b.body || "").replace(/\s+/g, " ").trim();
    return `<button type="button" class="sa-item" onclick="openAnnouncement(${n})"><span class="sa-thumb ${cls}" aria-hidden="true"><i class="fa-solid ${ic}"></i></span><span class="sa-body"><span class="sa-tags"${b.featured ? "" : ' hidden'}>${b.featured ? '<span class="sa-tag sa-pin"><i class="fa-solid fa-thumbtack"></i>Pinned</span>' : ""}</span><b>${esc(b.title)}</b>${body ? `<span class="sa-ex">${esc(body)}</span>` : ""}<small>${esc(bulletinAge(when(b)))}</small></span><i class="fa-solid fa-chevron-right sa-go" aria-hidden="true"></i></button>`;
  }).join("")}</div>` : `<div class="dt-empty" style="padding:26px;"><i class="fa-solid fa-bullhorn"></i>No announcements yet.<br><small>New advisories from the Student Services Office will show up here.</small></div>`;
}
function openAnnouncement(n) {
  const b = (window.__saList || [])[n]; if (!b) return;
  const ts = +new Date(b.publishAt || b.createdAt);
  openAppModal({ title: b.title, subtitle: `${b.category || "Announcement"} \u00b7 ${new Date(ts).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`, icon: "fa-bullhorn", content: `<div style="font-size:14px;line-height:1.65;color:#2a1214;white-space:pre-wrap;">${esc(b.body || "")}</div><div style="margin-top:16px;text-align:right;"><button class="btn-ghost" onclick="closeAppModal();goTo('page-bulletin')" style="padding:8px 14px;font-size:12px;">Open Student Bulletin</button></div>` });
}

// ── Shared student list components (My Appointments + My Requests) ──
// Same tabs, same table shell, same columns on both pages.
function dtTabs(tabs, active, handler, plain) {
  return `<div class="dt-tabs" role="tablist">${tabs.map((t) => `<button type="button" role="tab" aria-selected="${active === t.key}" title="${esc(t.tip || t.label)}" onclick="${handler}('${t.key}')" class="dt-tab${active === t.key ? " active" : ""}">${plain ? "" : `<i class="fa-solid ${t.icon || "fa-list"}"></i>`}${esc(t.label)} <span class="dt-count">${t.count}</span></button>`).join("")}</div>`;
}
function dtTable({ headers, rows, empty, emptyIcon, alignLast = true }) {
  if (!rows.length) return `<div class="dt-empty"><i class="fa-solid ${emptyIcon || "fa-inbox"}"></i><div>${empty}</div></div>`;
  return `<div class="dt-wrap"><table class="glass-table dt-table"><thead><tr>${headers.map((h, i) => `<th${alignLast && i === headers.length - 1 ? ' style="text-align:right;"' : ""}>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

// Visit routing (student dashboard): PENDING_APPROVAL bookings wait under
// My Requests; confirmed (BOOKED/RESCHEDULED/CHECKED_IN) visits and scheduled
// pickups live under My Appointments.
function isAwaitingVisit(a) { return a.status === "PENDING_APPROVAL"; }
function isApprovedVisit(a) { return ["BOOKED", "RESCHEDULED", "PENDING", "CHECKED_IN"].includes(a.status); }
function studentPickups() {
  if (!session) return [];
  const linkedPickupIds = new Set((MOD.visits || []).filter((v) => isApprovedVisit(v) && v.linkedId).map((v) => v.linkedId));
  return (MOD.requests || []).filter((r) => r.sn === session.id && r.status === "Pickup Scheduled" && !linkedPickupIds.has(r.id));
}
function isTerminalReferral(s) { return /^(completed|rejected|cancelled|no.?show)$/i.test((s || "").trim()); }
function isTerminalIdApp(s) { return /^(claimed|completed|rejected|cancelled)$/i.test((s || "").trim()); }
function isTerminalEvent(s) { return /^(completed|rejected|disapproved|cancelled)$/i.test((s || "").trim()); }
/** Re-render every student visit/request view after a booking change. */
async function refreshStudentVisitViews(visits) {
  if (!visits) {
    const hist = await api("/api/queue?mine=1&history=1");
    visits = hist.ok ? hist.data : [];
  }
  renderDashboardAppointments(visits);
  renderStudentRequestCard(visits);
  await renderStudentAppointment();
  await renderMyAppointments();
}

// Dashboard model (same as the full pages):
//   Appointments = every time you must show up: visits (incl. awaiting approval) + scheduled pickups.
//   Requests     = what you filed and is still being processed (documents, IDs, events, referrals).
// An item appears in exactly one of the two lists; a request with a visit/pickup just shows a "Linked" chip.
const REQ_TERMINAL_RE = /^(rejected|completed|cancelled|claimed|no.?show)$/i;
function dlRow({ icon, title, meta, pill: pl, onclick, chip }) {
  return `<button type="button" class="dl-row" onclick="${onclick}"><span class="dl-ico"><i class="fa-solid ${icon}"></i></span><span class="dl-body"><b>${esc(title)}</b><small>${meta}</small></span>${chip ? `<span class="dl-chip">${esc(chip)}</span>` : ""}<span class="dl-pill">${pl}</span><i class="fa-solid fa-chevron-right dl-go" aria-hidden="true"></i></button>`;
}
function dlHead(icon, title, sub, count, viewAll, newBtn) {
  return `<div class="dl-head"><div><div class="dl-title"><i class="fa-solid ${icon}"></i>${title}${count ? `<span class="dl-count">${count}</span>` : ""}</div><div class="dl-sub">${sub}</div></div><div class="dl-actions">${newBtn || ""}<button onclick="${viewAll}" class="btn-ghost" style="padding:6px 12px;font-size:11px;">View all</button></div></div>`;
}
function dlEmpty(icon, text, btn) { return `<div class="dl-empty"><i class="fa-solid ${icon}"></i><div>${text}</div>${btn || ""}</div>`; }
function pickupWhen(r) { const t = Date.parse(`${r.pickupDate} ${r.pickupTime}`); return Number.isFinite(t) ? t : Infinity; }
function dashAppointmentItems(visits) {
  const act = (visits || []).filter((a) => isApprovedVisit(a) || isAwaitingVisit(a)).map((a) => ({ t: Date.parse(a.startsAt) || Infinity, kind: "visit", a }));
  const pk = studentPickups().map((r) => ({ t: pickupWhen(r), kind: "pickup", r }));
  return [...act, ...pk].sort((x, y) => x.t - y.t);
}
function renderDashboardAppointments(visits) {
  const box = document.getElementById("dashboardAppointments");
  if (!box) return;
  const items = dashAppointmentItems(visits);
  const rows = items.slice(0, 4).map((it) => it.kind === "visit"
    ? dlRow({ icon: "fa-calendar-check", title: it.a.serviceLabel || it.a.service || "Visit", meta: `${esc(it.a.dateLabel)} &middot; ${esc(it.a.time)} &middot; ${esc(it.a.q)}`, pill: stChip(apptStatusLabel(it.a.status)), onclick: `viewMyAppointment('${esc(it.a.q)}')` })
    : dlRow({ icon: "fa-box-open", title: `${reqServiceLabel(it.r.service)} pickup`, meta: `${esc(it.r.pickupDate)} &middot; ${esc(it.r.pickupTime)} &middot; ${esc(it.r.id)}`, pill: stChip(it.r.status), onclick: `viewMyRequest('request','${esc(it.r.id)}')` }));
  box.innerHTML = dlHead("fa-calendar-day", "Appointments", "When you need to be at the office: visits and pickups.", items.length || "", "goTo('page-appointment')")
    + (rows.length ? `<div class="dl-list">${rows.join("")}</div>` : dlEmpty("fa-calendar-plus", "Nothing scheduled right now.", `<button onclick="openScheduleVisit()" class="btn-maroon" style="margin-top:10px;padding:9px 18px;font-size:12px;"><i class="fa-solid fa-calendar-plus" style="margin-right:6px;"></i>Schedule a Visit</button>`));
}

function renderStudentRequestCard() {
  const el = document.getElementById("studentRequestCard");
  if (!el || !session) return;
  const sid = session.id;
  const mine = (arr) => (arr || []).filter((x) => x.sn === sid);
  const all = [
    ...mine(MOD.requests).filter((r) => !REQ_TERMINAL_RE.test(r.status || "")).map((r) => ({ id: r.id, kind: "request", icon: "fa-file-lines", title: reqServiceLabel(r.service), status: r.status, ts: r.ts, ref: r.appointmentCode })),
    ...mine(MOD.idapps).filter((x) => !isTerminalIdApp(x.status)).map((x) => ({ id: x.id, kind: "idapp", icon: "fa-id-card", title: x.type, status: x.status, ts: x.ts, ref: null })),
    ...mine(MOD.events2).filter((x) => !isTerminalEvent(x.status)).map((x) => ({ id: x.id, kind: "event", icon: "fa-star", title: `Event — ${x.title}`, status: x.status, ts: x.ts, ref: x.appointmentCode })),
    ...mine(MOD.referrals).filter((x) => !isTerminalReferral(x.status)).map((x) => ({ id: x.id, kind: "referral", icon: "fa-hand-holding-heart", title: `Referral — ${x.category}`, status: x.status, ts: x.ts, ref: x.appointmentCode })),
  ].reverse();
  el.style.display = "block";
  const rows = all.slice(0, 4).map((r) => dlRow({ icon: r.icon, title: r.title, meta: `${esc(r.id)} &middot; filed ${esc(r.ts || "")}`, pill: stChip(r.status), onclick: `viewMyRequest('${r.kind}','${esc(r.id)}')`, chip: r.ref ? `Linked ${r.ref}` : "" }));
  el.innerHTML = dlHead("fa-file-circle-check", "Requests in Progress", "Documents, IDs, events and referrals you filed.", all.length || "", "goTo('page-myrequests')", `<button onclick="openNewRequest()" class="btn-maroon" style="padding:6px 12px;font-size:11px;"><i class="fa-solid fa-plus" style="margin-right:5px;"></i>New Request</button>`)
    + (rows.length ? `<div class="dl-list">${rows.join("")}</div>` : dlEmpty("fa-circle-check", "No requests in progress. You&rsquo;re all caught up.", ""));
}

async function renderStudentAppointment() {
  const card = document.getElementById("studentAppointmentCard");
  if (!card) return;
  const head = `<div class="nv-head"><i class="fa-solid fa-ticket"></i>Your Next Visit</div>`;
  const result = await api("/api/queue?mine=1&history=1");
  const visits = result.ok ? result.data : [];
  const now = Date.now();
  const ap = visits.filter(isApprovedVisit).sort((x, y) => (Date.parse(x.startsAt) || Infinity) - (Date.parse(y.startsAt) || Infinity));
  const appt = ap.find((a) => (Date.parse(a.startsAt) || 0) >= now - 3 * 3600000) || ap[0];
  if (appt) {
    card.innerHTML = `${head}<div class="nv-body"><div class="nv-qr" id="dashApptQrWrap"><span class="nv-ld">Loading pass&hellip;</span></div><div class="nv-info"><div class="nv-date">${esc(appt.dateLabel)}</div><div class="nv-time">${esc(appt.time)}</div><div class="nv-svc">${esc(appt.serviceLabel || appt.service || "")}</div><div class="nv-meta"><span class="nv-code">${esc(appt.q)}</span>${stChip(apptStatusLabel(appt.status))}</div></div></div><div class="nv-actions"><button onclick="viewMyAppointment('${esc(appt.q)}')" class="btn-maroon" style="padding:9px 10px;font-size:12px;"><i class="fa-solid fa-qrcode" style="margin-right:6px;"></i>View Pass</button><button onclick="downloadAppointmentIcs('${esc(appt.q)}')" class="btn-ghost" style="padding:9px 10px;font-size:12px;"><i class="fa-solid fa-calendar-plus" style="margin-right:6px;"></i>Add to Calendar</button></div>`;
    void loadAppointmentQrInto(appt.q, "dashApptQrWrap", 112);
    return;
  }
  const waiting = visits.filter(isAwaitingVisit)[0];
  if (waiting) {
    card.innerHTML = `${head}<div class="nv-wait"><i class="fa-solid fa-hourglass-half"></i><div><b>Awaiting approval</b><p>${esc(waiting.serviceLabel || waiting.service || "Your visit")} on ${esc(waiting.dateLabel)} at ${esc(waiting.time)}. Your QR pass appears here once the SSO approves it.</p></div></div><div class="nv-actions" style="grid-template-columns:1fr;"><button onclick="viewMyAppointment('${esc(waiting.q)}')" class="btn-ghost" style="padding:9px 10px;font-size:12px;">View booking</button></div>`;
    return;
  }
  const pickup = studentPickups().sort((x, y) => pickupWhen(x) - pickupWhen(y))[0];
  if (pickup) {
    card.innerHTML = `${head}<div class="nv-body"><div class="nv-qr nv-pk"><i class="fa-solid fa-box-open"></i></div><div class="nv-info"><div class="nv-date">${esc(pickup.pickupDate)}</div><div class="nv-time">${esc(pickup.pickupTime)}</div><div class="nv-svc">${esc(reqServiceLabel(pickup.service))} pickup</div><div class="nv-meta"><span class="nv-code">${esc(pickup.id)}</span></div></div></div><div class="nv-actions" style="grid-template-columns:1fr;"><button onclick="viewMyRequest('request','${esc(pickup.id)}')" class="btn-maroon" style="padding:9px 10px;font-size:12px;">View request</button></div>`;
    return;
  }
  card.innerHTML = `${head}<div class="nv-empty"><i class="fa-solid fa-calendar-plus"></i><div>No upcoming visit.</div><button onclick="openScheduleVisit()" class="btn-maroon" style="margin-top:10px;padding:9px 18px;font-size:12px;"><i class="fa-solid fa-calendar-plus" style="margin-right:6px;"></i>Schedule a Visit</button></div>`;
}

function apptStatusPill(status) { return stChip(apptStatusLabel(status)); }
/* ===== Shared "My ..." list components (My Appointments + My Requests) ===== */
const APPT_STATUS_LABELS = { PENDING_APPROVAL: "Awaiting approval", BOOKED: "Confirmed", PENDING: "Confirmed", RESCHEDULED: "Rescheduled", CHECKED_IN: "Checked in", IN_PROGRESS: "Checked in", SERVED: "Completed", CANCELLED: "Cancelled", NO_SHOW: "No show" };
function apptStatusLabel(s) { return APPT_STATUS_LABELS[s] || String(s || "Confirmed").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()); }
/** One status chip for both pages: dot + plain-case label, colour by meaning. */
function stChip(text) {
  const s = String(text || "").toLowerCase();
  const tone = /(archiv|draft)/.test(s) ? "mute" : /(reject|cancel|no.?show|disapprov|fail|dismiss|declin)/.test(s) ? "bad"
    : /(complete|served|claimed|approved|verified|resolved|published|ready|pickup scheduled|confirmed|sent)/.test(s) ? "ok"
    : /(review|process|ongoing|investigat|reschedul|checked.?in|in.?progress|scheduled|open)/.test(s) ? "info" : "warn";
  return `<span class="st-chip st-${tone}"><i></i>${esc(text || "Pending")}</span>`;
}
function splitWhen(str) {
  const m = String(str || "").match(/^(.*?\d{4}),?\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
  return m ? [m[1], m[2]] : [str || "—", ""];
}
function shortDate(label) {
  const t = Date.parse(label);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : label;
}
function mlAct(icon, tip, onclick, cls) {
  return `<button type="button" class="ml-act ${cls || ""}" title="${esc(tip)}" aria-label="${esc(tip)}" onclick="${onclick}"><i class="fa-solid ${icon}"></i></button>`;
}
function mlActOff(icon, tip) {
  return `<button type="button" class="ml-act" disabled title="${esc(tip)}" aria-label="${esc(tip)}"><i class="fa-solid ${icon}"></i></button>`;
}
/** One table row template shared by both pages, so a column change hits both. */
function mlRow({ code, svc, sub, linked, d, t, status, acts, open }) {
  return `<tr class="ml-tr" tabindex="0" onclick="${open}" onkeydown="if(event.key==='Enter'&&event.target===this){${open}}">
    <td class="c-code" data-l="Reference"><span class="ml-code">${esc(code)}</span></td>
    <td class="c-svc"><div class="ml-svc">${esc(svc)}</div>${sub ? `<div class="ml-sub2">${esc(sub)}</div>` : ""}${linked ? `<div class="ml-link"><i class="fa-solid fa-link"></i>${esc(linked)}</div>` : ""}</td>
    <td class="c-when"><div class="ml-d">${esc(d || "—")}</div>${t ? `<div class="ml-t">${esc(t)}</div>` : ""}</td>
    <td class="c-status">${status}</td>
    <td class="c-act" onclick="event.stopPropagation()"><div class="ml-acts">${acts}</div></td>
  </tr>`;
}
function mlTable(headers, rows, emptyHtml, emptyIcon) {
  if (!rows.length) return `<div class="dt-empty ml-empty"><i class="fa-solid ${emptyIcon || "fa-inbox"}"></i><div>${emptyHtml}</div></div>`;
  return `<div class="dt-wrap ml-card"><table class="dt-table ml-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
function mlToolbar(tabs, active, handler, searchId, q, placeholder, onsearch) {
  return `<div class="ml-toolbar">${dtTabs(tabs, active, handler, true)}<label class="ml-search"><i class="fa-solid fa-magnifying-glass"></i><input id="${searchId}" type="search" autocomplete="off" value="${esc(q)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" oninput="${onsearch}(this.value)"></label></div>`;
}
function mlEmptyCta(label, icon, fn) { return `<div style="margin-top:14px;"><button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="${fn}()"><i class="fa-solid ${icon}"></i>${label}</button></div>`; }
const ML_HEADERS = (when) => ["Reference", "Service", when, "Status", "Actions"];

// ── My Appointments ──
let ML_A = null;      // cached fetch: { list, archived }
let ML_Q = { a: "", r: "" };
function mlApptSearch(v) { ML_Q.a = String(v || ""); drawMyAppointmentsTable(); }
async function renderMyAppointments(cached) {
  const box = document.getElementById("myAppointmentsList");
  if (!box) return;
  if (!(cached && ML_A)) {
    if (!ML_A) box.innerHTML = `<div class="ml-loading">Loading appointments…</div>`;
    const [result, reqRes, refRes, idaRes, evtRes, fbRes] = await Promise.all([
      api("/api/queue?mine=1&history=1"), api("/api/modules/requests"), api("/api/modules/referrals"),
      api("/api/modules/idapps"), api("/api/modules/events2"), api("/api/feedback"),
    ]);
    const list = result.ok ? result.data : [];
    MOD.visits = list;
    if (reqRes.ok) MOD.requests = reqRes.data;
    if (refRes.ok) MOD.referrals = refRes.data;
    if (idaRes.ok) MOD.idapps = idaRes.data;
    if (evtRes.ok) MOD.events2 = evtRes.data;
    if (fbRes.ok && Array.isArray(fbRes.data?.items)) setMyFeedbackList(fbRes.data.items);
    ML_A = { list, archived: null };
  }
  if (myApptFilter === "archived" && !(cached && ML_A.archived)) {
    const archRes = await api("/api/queue?mine=1&history=1&archived=1");
    ML_A.archived = archRes.ok ? archRes.data : [];
  }
  const list = ML_A.list, myPickups = studentPickups();
  const awaiting = list.filter(isAwaitingVisit);
  const approved = list.filter(isApprovedVisit);
  const completed = list.filter((a) => a.status === "SERVED");
  const cancelled = list.filter((a) => ["CANCELLED", "NO_SHOW"].includes(a.status));
  const tabs = [
    { key: "all", label: "View all", tip: "Every appointment", count: list.length + myPickups.length },
    { key: "upcoming", label: "Upcoming", tip: "Confirmed visits and scheduled pickups", count: approved.length + myPickups.length },
    { key: "pending", label: "Pending", tip: "Waiting for SSO approval", count: awaiting.length },
    { key: "completed", label: "Completed", tip: "Visits already served", count: completed.length },
    { key: "cancelled", label: "Cancelled / No Show", tip: "Cancelled or missed visits", count: cancelled.length },
    { key: "archived", label: "Archived", tip: "Finished appointments older than 30 days", count: ML_A.archived ? ML_A.archived.length : "·" },
  ];
  box.innerHTML = mlToolbar(tabs, myApptFilter, "setMyApptFilter", "mlSearchA", ML_Q.a, "Search by code, service or status", "mlApptSearch") + `<div id="mlTableA"></div>`;
  drawMyAppointmentsTable();
}
function drawMyAppointmentsTable() {
  const host = document.getElementById("mlTableA"); if (!host || !ML_A) return;
  const list = ML_A.list, myPickups = studentPickups();
  const awaiting = list.filter(isAwaitingVisit), approved = list.filter(isApprovedVisit);
  const completed = list.filter((a) => a.status === "SERVED");
  const cancelled = list.filter((a) => ["CANCELLED", "NO_SHOW"].includes(a.status));
  const past = list.filter((a) => !isAwaitingVisit(a) && !isApprovedVisit(a));
  const q = esc2q(ML_Q.a);
  const visitItem = (a) => {
    const code = esc(a.q), active = isAwaitingVisit(a) || isApprovedVisit(a), served = a.status === "SERVED";
    let acts = mlAct("fa-eye", "View details", `viewMyAppointment('${code}')`);
    if (isApprovedVisit(a)) acts += (a.reschedulesLeft ?? 1) > 0
      ? mlAct("fa-clock-rotate-left", `Reschedule (${a.reschedulesLeft ?? 1} left)`, `rescheduleAppointment('${code}')`)
      : mlActOff("fa-clock-rotate-left", "Reschedule limit reached — cancel and book a new visit instead");
    if (active) acts += mlAct("fa-calendar-xmark", "Cancel appointment", `cancelAppointment('${code}')`, "ml-act-bad");
    if (served) acts += mlRateAct(a.q, a.serviceLabel || a.service || "SSO Visit");
    const st = apptStatusLabel(a.status);
    return { text: `${a.q} ${a.serviceLabel || a.service || ""} ${a.purpose || ""} ${st} ${a.linkedId || ""}`, html: mlRow({ code: a.q, svc: a.serviceLabel || a.service || "Visit", sub: a.purpose ? `${a.purpose}${a.copies ? ` ×${a.copies}` : ""}` : "", linked: a.linkedId, d: shortDate(a.dateLabel), t: a.time, status: stChip(st), acts, open: `viewMyAppointment('${code}')` }) };
  };
  const pickupItem = (r) => ({ text: `${r.id} ${reqServiceLabel(r.service)} pickup ${r.status}`, html: mlRow({ code: r.id, svc: `${reqServiceLabel(r.service)} pickup`, sub: r.pickupNote || "", d: shortDate(r.pickupDate), t: r.pickupTime, status: stChip(r.status), acts: mlAct("fa-eye", "View details", `viewMyRequest('request','${esc(r.id)}')`), open: `viewMyRequest('request','${esc(r.id)}')` }) });
  const upcoming = approved.map(visitItem).concat(myPickups.map(pickupItem));
  const pending = awaiting.map(visitItem);
  let items, emptyMsg;
  if (myApptFilter === "upcoming") { items = upcoming; emptyMsg = "No upcoming visits or pickups."; }
  else if (myApptFilter === "pending") { items = pending; emptyMsg = "Nothing is waiting for approval."; }
  else if (myApptFilter === "completed") { items = completed.map(visitItem); emptyMsg = "No completed visits yet."; }
  else if (myApptFilter === "cancelled") { items = cancelled.map(visitItem); emptyMsg = "No cancelled or missed visits."; }
  else if (myApptFilter === "archived") { items = (ML_A.archived || []).map(visitItem); emptyMsg = "No archived appointments."; }
  else { items = upcoming.concat(pending, past.map(visitItem)); emptyMsg = "You have no appointments yet."; }
  if (q) items = items.filter((i) => i.text.toLowerCase().includes(q));
  const cta = !q && (myApptFilter === "all" || myApptFilter === "upcoming") ? mlEmptyCta("Schedule a Visit", "fa-calendar-plus", "openScheduleVisit") : "";
  host.innerHTML = mlTable(ML_HEADERS("Date &amp; Time"), items.map((i) => i.html), q ? "No appointments match your search." : emptyMsg + cta, "fa-calendar");
}
function esc2q(v) { return String(v || "").trim().toLowerCase(); }
function mlRateAct(code, label) {
  const ex = MY_FEEDBACK[code];
  if (ex) return `<span class="ml-rated" title="${esc(ex.comment || "Your rating")}"><i class="fa-solid fa-star"></i>${ex.rating}/5</span>`;
  return mlAct("fa-star", "Rate this visit", `openFeedbackModal('${esc(code)}','${esc(label)}')`, "ml-act-star");
}

// ── My Requests ──
let myReqFilter = "all";
let ML_R = null; // cached fetch for the active tab: { archived, items }
function setMyReqFilter(f) { myReqFilter = f || "all"; renderMyRequests(); }
function mlReqSearch(v) { ML_Q.r = String(v || ""); drawMyRequestsTable(); }
async function renderMyRequests() {
  const box = document.getElementById("myRequestsList");
  if (!box) return;
  const archived = myReqFilter === "archived";
  if (!ML_R) box.innerHTML = `<div class="ml-loading">Loading requests…</div>`;
  const qs = archived ? "?archived=1" : "";
  const [reqRes, refRes, idaRes, evtRes] = await Promise.all([
    api("/api/modules/requests" + qs), api("/api/modules/referrals" + qs), api("/api/modules/idapps" + qs), api("/api/modules/events2" + qs),
  ]);
  const sid = (session && session.id) || "";
  const mine = (res) => (res.ok ? res.data : []).filter((x) => x.sn === sid);
  // Keep the detail viewer (viewMyRequest) able to find archived rows too.
  const keep = (key, res) => { if (!res.ok) return; const seen = new Set(res.data.map((x) => x.id)); MOD[key] = [...(archived ? (MOD[key] || []).filter((x) => !seen.has(x.id)) : []), ...res.data]; };
  keep("requests", reqRes); keep("referrals", refRes); keep("idapps", idaRes); keep("events2", evtRes);
  const items = [
    ...mine(reqRes).map((r) => ({ id: r.id, ts: r.ts, label: reqServiceLabel(r.service), sub: r.subject ? `${r.subject}${r.copies > 1 ? ` ×${r.copies}` : ""}` : "", ref: r.appointmentCode, status: r.status, kind: "request", terminal: REQ_TERMINAL_RE.test(r.status || "") })),
    ...mine(evtRes).map((e) => ({ id: e.id, ts: e.ts, label: "Event Request", sub: e.title || "", ref: e.appointmentCode, status: e.status, kind: "event", terminal: isTerminalEvent(e.status) })),
    ...mine(refRes).map((r) => ({ id: r.id, ts: r.ts, label: "Referral", sub: r.category || "", ref: r.appointmentCode, status: r.status, kind: "referral", terminal: isTerminalReferral(r.status) })),
    ...mine(idaRes).map((a) => ({ id: a.id, ts: a.ts, label: "ID Application", sub: a.type || "", ref: null, status: a.status, kind: "idapp", terminal: isTerminalIdApp(a.status) })),
  ].reverse();
  ML_R = { archived, items };
  const isDone = (i) => /^(completed|claimed)$/i.test((i.status || "").trim());
  const isBad = (i) => i.terminal && !isDone(i);
  const dot = "·";
  const tabs = [
    { key: "all", label: "View all", tip: "Every request", count: archived ? dot : items.length },
    { key: "active", label: "Active", tip: "Requests still being processed", count: archived ? dot : items.filter((i) => !i.terminal).length },
    { key: "completed", label: "Completed", tip: "Completed or claimed", count: archived ? dot : items.filter(isDone).length },
    { key: "rejected", label: "Rejected / Cancelled", tip: "Rejected or cancelled requests", count: archived ? dot : items.filter(isBad).length },
    { key: "archived", label: "Archived", tip: "Finished requests older than 30 days", count: archived ? items.length : dot },
  ];
  box.innerHTML = mlToolbar(tabs, myReqFilter, "setMyReqFilter", "mlSearchR", ML_Q.r, "Search by code, request or status", "mlReqSearch") + `<div id="mlTableR"></div>`;
  drawMyRequestsTable();
}
function drawMyRequestsTable() {
  const host = document.getElementById("mlTableR"); if (!host || !ML_R) return;
  const isDone = (i) => /^(completed|claimed)$/i.test((i.status || "").trim());
  const isBad = (i) => i.terminal && !isDone(i);
  let shown = ML_R.items;
  if (myReqFilter === "active") shown = shown.filter((i) => !i.terminal);
  else if (myReqFilter === "completed") shown = shown.filter(isDone);
  else if (myReqFilter === "rejected") shown = shown.filter(isBad);
  const q = esc2q(ML_Q.r);
  if (q) shown = shown.filter((i) => `${i.id} ${i.label} ${i.sub} ${i.status} ${i.ref || ""}`.toLowerCase().includes(q));
  const rows = shown.map((i) => mlRow({ code: i.id, svc: i.label, sub: i.sub, linked: i.ref, d: splitWhen(i.ts)[0], t: splitWhen(i.ts)[1], status: stChip(i.status), acts: mlAct("fa-eye", "View details", `viewMyRequest('${i.kind}','${esc(i.id)}')`), open: `viewMyRequest('${i.kind}','${esc(i.id)}')` }));
  const cta = !q && (myReqFilter === "all" || myReqFilter === "active") ? mlEmptyCta("New Request", "fa-file-circle-plus", "openNewRequest") : "";
  host.innerHTML = mlTable(ML_HEADERS("Submitted"), rows, q ? "No requests match your search." : (myReqFilter === "archived" ? "No archived requests." : "No requests here yet.") + cta, "fa-file-lines");
}

// ── Student read-only appointment viewer ─────────────────────────
// Shared detail-modal pieces (dm-*): used by both "View" modals.
function dmKv(label, value, raw) { return value ? `<div class="dm-kv"><span>${esc(label)}</span><b>${raw ? value : esc(value)}</b></div>` : ""; }
async function viewMyAppointment(code) {
  let a = (MOD.visits || []).find((x) => x.q === code);
  if (!a) {
    // Dashboard cards don't share the My Appointments cache — fetch on demand.
    const res = await api("/api/queue?mine=1&history=1");
    if (res.ok) MOD.visits = res.data;
    a = (MOD.visits || []).find((x) => x.q === code);
  }
  if (!a) { showToast("❌ Appointment not found.", "rgba(155,22,22,.85)"); return; }
  const q = esc(a.q);
  const closed = ["CANCELLED", "NO_SHOW"].includes(a.status);
  const active = isAwaitingVisit(a) || isApprovedVisit(a);
  const canResched = isApprovedVisit(a) && (a.reschedulesLeft ?? 1) > 0;
  const left = a.reschedulesLeft ?? 1;
  const qrCard = closed ? "" : `<div class="dm-qr-panel">
      <div id="modalApptQrWrap" class="qrp-host"><div class="qrp-loading"><i class="fa-solid fa-qrcode"></i><span>Generating QR Pass…</span></div></div>
      <div class="dm-qr-acts">
        <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="downloadAppointmentQr('${q}')"><i class="fa-solid fa-download"></i>Download ID</button>
        <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="printAppointmentQr('${q}')"><i class="fa-solid fa-print"></i>Print</button>
      </div>
    </div>`;
  const cal = closed ? "" : `<div class="dm-cal"><span>Add to calendar</span>
      <button type="button" class="bk-btn bk-btn-text bk-btn-sm" onclick="downloadAppointmentIcs('${q}')"><i class="fa-solid fa-calendar-arrow-down"></i>.ics file</button>
      <button type="button" class="bk-btn bk-btn-text bk-btn-sm" onclick="openGoogleCalendarForAppointment('${q}')"><i class="fa-brands fa-google"></i>Google</button>
    </div>`;
  const fb = a.status === "SERVED" ? `<div class="dm-box"><div><b><i class="fa-solid fa-star"></i>Service feedback</b><small>${MY_FEEDBACK[a.q] ? `You rated this visit ${MY_FEEDBACK[a.q].rating}/5${MY_FEEDBACK[a.q].comment ? ` — “${esc(MY_FEEDBACK[a.q].comment)}”` : ""}` : "Help the SSO improve by rating your visit."}</small></div>${MY_FEEDBACK[a.q] ? "" : `<button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="openFeedbackModal('${q}','${esc(a.serviceLabel || a.service || "SSO Visit")}')"><i class="fa-solid fa-star"></i>Rate</button>`}</div>` : "";
  const foot = `<button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Close</button>`
    + (canResched ? `<button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="rescheduleAppointment('${q}')" title="${left} reschedule${left === 1 ? "" : "s"} left"><i class="fa-solid fa-clock-rotate-left"></i>Reschedule</button>` : "")
    + (active ? `<button type="button" class="bk-btn bk-btn-danger bk-btn-sm" onclick="cancelAppointment('${q}')"><i class="fa-solid fa-calendar-xmark"></i>Cancel appointment</button>` : "");
  openAppModal({ title: a.serviceLabel || a.service || "Visit", subtitle: `${a.q} · ${a.dateLabel || ""} · ${a.time || ""}`, icon: "fa-calendar-days", wide: !closed, content: `
    <div class="dm-grid${closed ? " single" : ""}">
      ${qrCard}
      <div class="dm-info">
        <div class="dm-status">${stChip(apptStatusLabel(a.status))}${a.status === "PENDING_APPROVAL" ? '<span class="dm-muted">The SSO will confirm your visit shortly.</span>' : ""}</div>
        <div class="dm-kvs">
          ${dmKv("Service", a.serviceLabel || a.service || "")}
          ${dmKv("Date", a.dateLabel || "")}
          ${dmKv("Time", a.time || "")}
          ${dmKv("Reference", a.q)}
          ${dmKv("Purpose", a.purpose ? `${a.purpose}${a.copies ? ` ×${a.copies}` : ""}` : "")}
          ${dmKv("Linked request", a.linkedId || "")}
          ${dmKv("Booked by", a.bookedBy || "")}
          ${active && isApprovedVisit(a) ? dmKv("Reschedules left", left <= 0 ? "None — cancel and book a new visit" : String(left)) : ""}
          ${dmKv("Cancel reason", a.cancelReason || "")}
        </div>
        ${a.notes ? `<div class="dm-quote">“${esc(a.notes)}”</div>` : ""}
        ${cal}
      </div>
    </div>
    ${fb}
    <div class="dm-sec">${apptStepperHtml(a)}</div>
    <div class="app-modal-actions">${foot}</div>` });
  if (!closed) void loadAppointmentQrInto(a.q, "modalApptQrWrap", 180, { idCard: true });
}

window.__qrsQrCache = window.__qrsQrCache || {};
async function fetchAppointmentQr(code) {
  if (window.__qrsQrCache[code]) return window.__qrsQrCache[code];
  const res = await api(`/api/queue/${encodeURIComponent(code)}/qr`);
  if (res.ok && res.data && res.data.dataUrl) {
    window.__qrsQrCache[code] = res.data;
    return res.data;
  }
  return null;
}

function qrPassSubline(qr) {
  return (qr.courseYear || [qr.course, qr.year].filter(Boolean).join(" · ") || qr.studentId || "").trim();
}

function qrPassValidText(qr) {
  const datePart = qr.shortDate || qr.dateLabel || "";
  const timePart = qr.timeRange || qr.time || "";
  return [datePart, timePart].filter(Boolean).join(" • ");
}

function qrPassIdCardHtml(qr) {
  const sub = qrPassSubline(qr);
  const validText = qrPassValidText(qr);
  return `
    <div class="qrp-card">
      <div class="qrp-head">
        <div class="qrp-brand">
          <img src="/pup-seal-icon.png" alt="PUP San Pedro Seal" class="qrp-seal" />
          <div class="qrp-brand-txt">
            <div class="qrp-campus">PUP San Pedro</div>
            <div class="qrp-sys">STARS · ${esc(qr.code)}</div>
          </div>
        </div>
        <button type="button" class="qrp-dl-btn" onclick="downloadAppointmentQr('${esc(qr.code)}')" title="Download QR Pass ID" aria-label="Download QR Pass ID">
          <i class="fa-solid fa-download"></i>
        </button>
      </div>

      <div class="qrp-banner">Your QR Pass</div>

      <div class="qrp-stage">
        <div class="qrp-frame">
          <span class="qrp-br qrp-br-tl" aria-hidden="true"></span>
          <span class="qrp-br qrp-br-tr" aria-hidden="true"></span>
          <span class="qrp-br qrp-br-bl" aria-hidden="true"></span>
          <span class="qrp-br qrp-br-br" aria-hidden="true"></span>
          <img src="${qr.dataUrl}" alt="QR pass for ${esc(qr.code)}" class="qrp-img" />
        </div>
        <div class="qrp-name">${esc(qr.name || "Student")}</div>
        <div class="qrp-sub">${esc(sub || qr.serviceLabel || "")}</div>
      </div>

      <div class="qrp-valid">
        <span class="qrp-valid-chk" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
        <div class="qrp-valid-txt">
          <div class="qrp-valid-lbl">Valid for:</div>
          <div class="qrp-valid-val">${esc(validText)}</div>
        </div>
      </div>

      <div class="qrp-foot">
        <span class="qrp-info-dot" aria-hidden="true"><i class="fa-solid fa-info"></i></span>
        <span>Present this QR code at the OSS office.</span>
      </div>
    </div>`;
}

function qrLoadImg(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function qrRoundRect(ctx, x, y, w, h, r) {
  const rad = typeof r === "number" ? { tl: r, tr: r, br: r, bl: r } : r;
  ctx.beginPath();
  ctx.moveTo(x + rad.tl, y);
  ctx.lineTo(x + w - rad.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad.tr);
  ctx.lineTo(x + w, y + h - rad.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad.br, y + h);
  ctx.lineTo(x + rad.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad.bl);
  ctx.lineTo(x, y + rad.tl);
  ctx.quadraticCurveTo(x, y, x + rad.tl, y);
  ctx.closePath();
}

async function renderQrPassIdDataUrl(qr) {
  const W = 720, H = 960;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return qr.dataUrl;

  const [qrImg, sealImg, campusImg] = await Promise.all([
    qrLoadImg(qr.dataUrl),
    qrLoadImg("/pup-seal-icon.png"),
    qrLoadImg("/pup-campus.png"),
  ]);

  // Outer subtle canvas backdrop
  ctx.fillStyle = "#F6F1F1";
  ctx.fillRect(0, 0, W, H);

  // Portrait ID card surface
  const cx = 24, cy = 24, cw = W - 48, ch = H - 48;
  ctx.save();
  ctx.shadowColor = "rgba(60, 10, 15, 0.12)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  qrRoundRect(ctx, cx, cy, cw, ch, 36);
  ctx.fillStyle = "#FCFBFB";
  ctx.fill();
  ctx.restore();

  qrRoundRect(ctx, cx, cy, cw, ch, 36);
  ctx.strokeStyle = "#E6D4D6";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Clip inside card
  ctx.save();
  qrRoundRect(ctx, cx, cy, cw, ch, 36);
  ctx.clip();

  // Subtle washed-out campus backdrop in lower center behind QR
  if (campusImg) {
    ctx.save();
    ctx.globalAlpha = 0.09;
    const scale = Math.max(cw / campusImg.width, 460 / campusImg.height);
    const dw = campusImg.width * scale;
    const dh = campusImg.height * scale;
    ctx.drawImage(campusImg, cx + (cw - dw) / 2, 340, dw, dh);
    ctx.restore();

    const fade = ctx.createLinearGradient(0, 320, 0, 740);
    fade.addColorStop(0, "rgba(252,251,251,0.96)");
    fade.addColorStop(0.45, "rgba(252,251,251,0.58)");
    fade.addColorStop(1, "rgba(252,251,251,0.94)");
    ctx.fillStyle = fade;
    ctx.fillRect(cx, 320, cw, 430);
  }

  // Header: PUP Seal + PUP San Pedro / STARS
  const sealR = 46;
  const sealX = 166;
  const sealY = 104;
  if (sealImg) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(sealX, sealY, sealR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(sealImg, sealX - sealR, sealY - sealR, sealR * 2, sealR * 2);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(sealX, sealY, sealR, 0, Math.PI * 2);
    ctx.strokeStyle = "#7A0F1F";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  ctx.fillStyle = "#220A0D";
  ctx.font = "800 32px Inter, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("PUP San Pedro", sealX + sealR + 22, sealY - 14);
  ctx.fillStyle = "#5F494B";
  ctx.font = "700 22px Inter, system-ui, -apple-system, sans-serif";
  ctx.fillText(`STARS · ${qr.code}`, sealX + sealR + 22, sealY + 20);

  // Maroon Banner: "Your QR Pass"
  const bx = cx + 28, by = 182, bw = cw - 56, bh = 68;
  qrRoundRect(ctx, bx, by, bw, bh, { tl: 20, tr: 20, br: 0, bl: 0 });
  ctx.fillStyle = "#7A0F1F";
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "800 29px Inter, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Your QR Pass", W / 2, by + bh / 2 + 1);

  // White QR inner panel backdrop
  const qx = (W - 310) / 2, qy = 296, qs = 310;
  ctx.fillStyle = "#FFFFFF";
  qrRoundRect(ctx, qx - 16, qy - 16, qs + 32, qs + 32, 18);
  ctx.fill();

  // QR Image
  if (qrImg) {
    ctx.drawImage(qrImg, qx, qy, qs, qs);
  }

  // 4 Corner Brackets (top maroon, bottom soft rose-taupe)
  const fx = qx - 24, fy = qy - 24, fw = qs + 48, fh = qs + 48, blen = 42, brad = 16;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  // Top-left
  ctx.strokeStyle = "#6E0A1B";
  ctx.beginPath();
  ctx.moveTo(fx, fy + blen);
  ctx.lineTo(fx, fy + brad);
  ctx.quadraticCurveTo(fx, fy, fx + brad, fy);
  ctx.lineTo(fx + blen, fy);
  ctx.stroke();
  // Top-right
  ctx.beginPath();
  ctx.moveTo(fx + fw - blen, fy);
  ctx.lineTo(fx + fw - brad, fy);
  ctx.quadraticCurveTo(fx + fw, fy, fx + fw, fy + brad);
  ctx.lineTo(fx + fw, fy + blen);
  ctx.stroke();
  // Bottom-left
  ctx.strokeStyle = "#C9B4B7";
  ctx.beginPath();
  ctx.moveTo(fx, fy + fh - blen);
  ctx.lineTo(fx, fy + fh - brad);
  ctx.quadraticCurveTo(fx, fy + fh, fx + brad, fy + fh);
  ctx.lineTo(fx + blen, fy + fh);
  ctx.stroke();
  // Bottom-right
  ctx.beginPath();
  ctx.moveTo(fx + fw - blen, fy + fh);
  ctx.lineTo(fx + fw - brad, fy + fh);
  ctx.quadraticCurveTo(fx + fw, fy + fh, fx + fw, fy + fh - brad);
  ctx.lineTo(fx + fw, fy + fh - blen);
  ctx.stroke();

  // Student Name & Course / Year
  ctx.fillStyle = "#1A0709";
  ctx.font = "800 32px Inter, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(qr.name || "Student"), W / 2, 676);

  const sub = qrPassSubline(qr) || qr.serviceLabel || "";
  ctx.fillStyle = "#4A3437";
  ctx.font = "600 24px Inter, system-ui, -apple-system, sans-serif";
  ctx.fillText(sub, W / 2, 718);

  // Maroon "Valid for:" Pill Banner
  const vx = cx + 28, vy = 758, vw = cw - 56, vh = 96;
  qrRoundRect(ctx, vx, vy, vw, vh, 22);
  ctx.fillStyle = "#7A0F1F";
  ctx.fill();

  // White check circle
  const chkX = vx + 94, chkY = vy + vh / 2, chkR = 23;
  ctx.beginPath();
  ctx.arc(chkX, chkY, chkR, 0, Math.PI * 2);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.strokeStyle = "#7A0F1F";
  ctx.lineWidth = 4.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(chkX - 9, chkY + 1);
  ctx.lineTo(chkX - 2, chkY + 8);
  ctx.lineTo(chkX + 10, chkY - 7);
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.font = "500 20px Inter, system-ui, -apple-system, sans-serif";
  ctx.fillText("Valid for:", chkX + 46, chkY - 15);
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "700 23px Inter, system-ui, -apple-system, sans-serif";
  ctx.fillText(qrPassValidText(qr), chkX + 46, chkY + 18);

  // Footer instruction row
  const fyRow = 894;
  ctx.font = "600 21px Inter, system-ui, -apple-system, sans-serif";
  const footMsg = "Present this QR code at the OSS office.";
  const footW = ctx.measureText(footMsg).width;
  const dotR = 14;
  const totalW = dotR * 2 + 14 + footW;
  const startX = (W - totalW) / 2;

  ctx.beginPath();
  ctx.arc(startX + dotR, fyRow, dotR, 0, Math.PI * 2);
  ctx.fillStyle = "#7A0F1F";
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "800 18px Inter, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("i", startX + dotR, fyRow + 1);

  ctx.fillStyle = "#2A1518";
  ctx.font = "600 21px Inter, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(footMsg, startX + dotR * 2 + 14, fyRow + 1);

  ctx.restore();
  return canvas.toDataURL("image/png");
}

async function loadAppointmentQrInto(code, containerId, size, opts) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const qr = await fetchAppointmentQr(code);
  if (!qr) {
    el.innerHTML = `<span style="font-size:12px;color:var(--bk-muted);">QR pass unavailable — present code <b>${esc(code)}</b></span>`;
    return;
  }
  if (opts && opts.idCard) {
    el.innerHTML = qrPassIdCardHtml(qr);
    return;
  }
  const px = size || 180;
  el.innerHTML = `<img src="${qr.dataUrl}" alt="QR pass for ${esc(code)}" style="width:${px}px;height:${px}px;border-radius:10px;background:#fff;padding:6px;display:block;cursor:pointer;" onclick="viewMyAppointment('${esc(code)}')" title="Click to open QR Pass ID">`;
}

async function downloadAppointmentQr(code) {
  const qr = await fetchAppointmentQr(code);
  if (!qr) { showToast("Could not generate QR pass.", "rgba(155,22,22,.85)"); return; }
  const idUrl = await renderQrPassIdDataUrl(qr);
  const a = document.createElement("a");
  a.href = idUrl;
  a.download = `STARS-QR-Pass-${code}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast("✅ QR Pass ID downloaded!");
}

async function printAppointmentQr(code) {
  const qr = await fetchAppointmentQr(code);
  if (!qr) { showToast("Could not generate QR pass.", "rgba(155,22,22,.85)"); return; }
  const idUrl = await renderQrPassIdDataUrl(qr);
  const w = window.open("", "_blank", "width=460,height=660");
  if (!w) { showToast("Allow pop-ups to print your QR pass.", "rgba(180,130,0,.9)"); return; }
  w.document.write(`<!doctype html><html><head><title>STARS QR Pass — ${esc(qr.code)}</title><style>body{margin:0;padding:24px;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;box-sizing:border-box;background:#F6F1F1;font-family:Inter,Arial,sans-serif}img{width:360px;max-width:100%;height:auto;border-radius:18px;box-shadow:0 12px 32px rgba(60,10,15,.14)}.noprint{margin-top:16px}button{background:#7A0F1F;color:#fff;border:0;border-radius:10px;padding:10px 20px;font:700 13px Inter,sans-serif;cursor:pointer}@media print{body{background:#fff;padding:0}.noprint{display:none}img{box-shadow:none}}</style></head><body><img src="${idUrl}" alt="STARS QR Pass ${esc(qr.code)}"/><div class="noprint"><button onclick="window.print()">Print QR Pass</button></div><script>setTimeout(()=>window.print(),300);<\/script></body></html>`);
  w.document.close();
}

// ── Student read-only request viewer ─────────────────────────────
// Read-only: no admin actions, no remarks editing, everything esc()'d.
function viewMyRequest(kind, id) {
  let item = null;
  if (kind === "referral") item = (MOD.referrals || []).find((x) => x.id === id);
  else if (kind === "idapp") item = (MOD.idapps || []).find((x) => x.id === id);
  else if (kind === "event") item = (MOD.events2 || []).find((x) => x.id === id);
  else item = (MOD.requests || []).find((x) => x.id === id);
  if (!item) { showToast("❌ Record not found.", "rgba(155,22,22,.85)"); return; }
  let title, kvs = "", files = "", icon = "fa-file-lines";
  if (kind === "referral") {
    title = "Referral"; icon = "fa-hand-holding-heart";
    kvs = dmKv("Category", item.category || "") + dmKv("Details", item.details || "");
  } else if (kind === "idapp") {
    title = "ID Application"; icon = "fa-id-card";
    kvs = dmKv("Application type", item.type || "") + dmKv("Reason", item.reason || "") + (item.pickedUpAt ? dmKv("Claimed", "Yes") : "");
    files = (item.orUrl ? fileLink(item.orName, item.orUrl, "OR receipt") : "") + (item.affidavitUrl ? fileLink(item.affidavitName, item.affidavitUrl, "Affidavit of Loss") : "");
  } else if (kind === "event") {
    title = "Event Request"; icon = "fa-people-group";
    kvs = dmKv("Event", item.title || "") + dmKv("Details", item.details || item.description || "");
  } else {
    title = reqServiceLabel(item.service);
    kvs = dmKv("Subject", item.subject ? `${item.subject}${item.copies > 1 ? ` ×${item.copies}` : ""}` : "") + dmKv("Details", item.details || "");
    files = item.docUrl ? fileLink(item.docName, item.docUrl, "Supporting document") : "";
  }
  const visit = item.appointmentCode
    ? dmKv("Linked visit", `<span>${esc(item.appointmentCode)}${item.dateLabel ? ` · ${esc(item.dateLabel)}` : ""}${item.time ? ` ${esc(item.time)}` : ""}${item.appointmentDate ? ` · ${esc(item.appointmentDate)}` : ""}${item.appointmentTime ? ` ${esc(item.appointmentTime)}` : ""}</span> <button type="button" class="bk-btn bk-btn-text bk-btn-sm" onclick="closeAppModal();viewMyAppointment('${esc(item.appointmentCode)}')">View visit</button>`, true)
    : "";
  const hist = Array.isArray(item.history) && item.history.length
    ? `<div class="dm-hist"><div class="dm-h">Activity</div>${item.history.slice().reverse().map((h) => `<div class="dm-hi"><i></i><div><b>${esc(h.status)}</b><small>${esc(h.ts)}${h.by ? ` · ${esc(h.by)}` : ""}</small>${h.note ? `<p>${esc(h.note)}</p>` : ""}</div></div>`).join("")}</div>`
    : "";
  openAppModal({ title, subtitle: `${item.id}${item.ts ? ` · filed ${item.ts}` : ""}`, icon, content: `
    <div class="dm-info">
      <div class="dm-status">${stChip(item.status)}</div>
      <div class="dm-kvs">
        ${kvs}${visit}
        ${item.pickupDate ? dmKv("Pickup", `${item.pickupDate} ${item.pickupTime || ""}${item.pickupNote ? ` — ${item.pickupNote}` : ""}`) : ""}
        ${dmKv("Staff remarks", item.remarks || "")}
      </div>
      ${files ? `<div class="dm-files">${files}</div>` : ""}
    </div>
    <div class="dm-sec">${wfStepperHtml(kind === "request" ? "request" : kind, item)}</div>
    ${hist}
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Close</button></div>` });
}

async function renderAdminCsat() {
  const box = document.getElementById("adminCsatCard"); if (!box) return;
  const r = await api("/api/reports/csat-summary");
  if (!r.ok) { box.style.display = "none"; return; }
  box.style.display = "";
  const d = r.data, max = Math.max(1, ...d.distribution.map((x) => x.count));
  const diff = d.total && d.previousTotal ? Math.round((d.average - d.previousAverage) * 100) / 100 : null;
  const trend = diff === null ? `<span class="insight-hint">No earlier period to compare</span>` : diff > 0 ? `<span style="color:#15803d;font-weight:800;" title="Up from ${d.previousAverage} in the previous 30 days"><i class="fa-solid fa-arrow-trend-up"></i> +${diff}</span>` : diff < 0 ? `<span style="color:#b91c1c;font-weight:800;" title="Down from ${d.previousAverage} in the previous 30 days"><i class="fa-solid fa-arrow-trend-down"></i> ${diff}</span>` : `<span class="insight-hint"><i class="fa-solid fa-minus"></i> No change</span>`;
  box.innerHTML = `<div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
    <div><div class="dl-title" style="font-size:14px;margin-bottom:4px;"><i class="fa-solid fa-star"></i>Client Satisfaction \u00b7 last ${d.days} days</div>
      <div style="display:flex;align-items:baseline;gap:10px;"><span style="font-size:34px;font-weight:900;color:#1a0505;">${d.total ? d.average.toFixed(2) : "\u2014"}</span><span style="font-size:12px;color:rgba(30,5,5,.65);">/ 5 \u00b7 ${d.total} rating${d.total === 1 ? "" : "s"}</span>${trend}</div></div>
    <div style="flex:1;min-width:220px;display:grid;gap:3px;">${d.distribution.map((x) => `<div style="display:flex;align-items:center;gap:8px;font-size:11px;"><span style="width:26px;">${x.star} \u2605</span><div style="flex:1;height:7px;background:rgba(139,26,26,.1);border-radius:99px;overflow:hidden;"><div style="height:100%;width:${Math.round(x.count / max * 100)}%;background:#8B1A1A;"></div></div><span style="width:22px;text-align:right;">${x.count}</span></div>`).join("")}</div>
    ${isSuperAdmin() ? `<button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="goTo('page-system')" title="Open the full Analytics page"><i class="fa-solid fa-chart-column"></i>Full analytics</button>` : ""}
  </div>`;
}

function renderAdminPage() {
  const nm = document.getElementById("adminWelcomeName"); if (nm && session) nm.textContent = String(session.name || "Admin").trim().split(/\s+/)[0];
  const dl = document.getElementById("adminDateLabel"); if (dl) dl.textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  renderAdminCsat();
  renderAdminKPIs();
  renderAdminActivity();
  renderAdminTable();
  renderQueue();
  renderAuditLog();
  renderCharts();
  updateMasterlistStatus();
  renderAcctApprovals();
}
function renderAdminActivity() {
  const el = document.getElementById("adminActivity");
  if (!el || !ADMIN_ACTIVITY) return;
  const items = [
    ["fa-id-card", ADMIN_ACTIVITY.pendingIdApps, "Pending ID apps", "page-requests"],
    ["fa-calendar-check", ADMIN_ACTIVITY.waitingAppointments, "Waiting appointments", "page-appointments"],
    ["fa-shield-heart", ADMIN_ACTIVITY.openComplaints, "Open complaints", "page-complaint"],
    ["fa-envelope-circle-check", ADMIN_ACTIVITY.emailFailures, "Email failures", ""],
  ];
  el.style.display = "block";
  el.innerHTML = `<div class="dl-head" style="margin-bottom:10px;"><div><div class="dl-title"><i class="fa-solid fa-bolt"></i>Staff Activity</div><div class="dl-sub">What needs your attention right now.</div></div></div>
    <div class="ad-act">${items.map(([icon, count, label, page]) => `<${page ? `button type="button" onclick="goTo('${page}')"` : "div"} class="ad-act-i"><span class="dl-ico"><i class="fa-solid ${icon}"></i></span><span><b>${count}</b><small>${label}</small></span></${page ? "button" : "div"}>`).join("")}</div>`;
}

function renderAdminKPIs() {
  const active = queueData.filter((q) => !q.served && !["CANCELLED", "NO_SHOW"].includes(q.status));
  const served = queueData.filter((q) => q.served || q.status === "SERVED").length;
  const noshow = queueData.filter((q) => q.status === "NO_SHOW").length;
  const total = queueData.length;
  const serveRate = total > 0 ? Math.round((served / total) * 100) : 0;

  document.getElementById("adminKpiTotal").textContent = total;
  document.getElementById("adminKpiPending").textContent = active.length;
  document.getElementById("adminKpiApproved").textContent = served;
  document.getElementById("adminKpiRejected").textContent = noshow;
  document.getElementById("adminKpiClearance").textContent = serveRate + "% served rate";
  document.getElementById("clearanceBadge").textContent = serveRate + "% Served";
  document.getElementById("legendApproved").textContent = served;
  document.getElementById("legendPending").textContent = active.length;
  document.getElementById("legendRejected").textContent = noshow;
}

let adminQTab = "all";
const ADMIN_QTABS = [
  { key: "all", label: "All", test: () => true },
  { key: "approval", label: "Needs approval", test: (a) => a.status === "PENDING_APPROVAL" },
  { key: "active", label: "Active", test: (a) => ["BOOKED", "PENDING", "RESCHEDULED", "CHECKED_IN", "IN_PROGRESS"].includes(a.status) && !a.served },
  { key: "done", label: "Completed", test: (a) => a.served || a.status === "SERVED" },
  { key: "closed", label: "Cancelled / No-show", test: (a) => ["CANCELLED", "NO_SHOW"].includes(a.status) },
];
function setAdminQTab(k) { adminQTab = k; renderAdminTable(); }

function renderAdminTable() {
  const q = (document.getElementById("adminSearch")?.value || "").toLowerCase();
  const tabDef = ADMIN_QTABS.find((t) => t.key === adminQTab) || ADMIN_QTABS[0];
  const tabsEl = document.getElementById("adminQTabs");
  if (tabsEl) tabsEl.innerHTML = dtTabs(ADMIN_QTABS.map((t) => ({ key: t.key, label: t.label, count: queueData.filter(t.test).length })), adminQTab, "setAdminQTab", true);
  const svcSel = document.getElementById("adminDocFilter");
  let svcF = "";
  if (svcSel) {
    svcF = svcSel.value;
    const svcs = [...new Set(queueData.map((a) => a.serviceLabel || a.service))].sort();
    svcSel.innerHTML = '<option value="">All Services</option>' + svcs.map((d) => `<option value="${esc(d)}" ${d === svcF ? "selected" : ""}>${esc(d)}</option>`).join("");
    if (svcF && !svcs.includes(svcF)) svcF = "";
  }
  const sortMode = document.getElementById("adminSort")?.value || "new";
  const sorted = [...queueData].sort((a, b) => {
    if (sortMode === "old") return new Date(a.startsAt || 0) - new Date(b.startsAt || 0);
    if (sortMode === "svc") return (a.serviceLabel || "").localeCompare(b.serviceLabel || "");
    if (sortMode === "stu") return a.name.localeCompare(b.name);
    return new Date(b.startsAt || 0) - new Date(a.startsAt || 0);
  });
  const filtered = sorted.filter((a) => {
    const matchStatus = tabDef.test(a);
    const matchSvc = !svcF || (a.serviceLabel || a.service) === svcF;
    const matchQ = !q || a.name.toLowerCase().includes(q) || a.studentId.toLowerCase().includes(q) || a.q.toLowerCase().includes(q) || (a.serviceLabel || "").toLowerCase().includes(q);
    return matchStatus && matchSvc && matchQ;
  });
  const filterKey = `${q}|${adminQTab}|${svcF}|${sortMode}`;
  if (filterKey !== lastAdminTableFilterKey) {
    adminRequestPage = 1;
    lastAdminTableFilterKey = filterKey;
  }

  const tbody = document.getElementById("adminTable");
  const empty = document.getElementById("adminTableEmpty");
  const pagination = document.getElementById("adminTablePagination");

  if (filtered.length === 0) { tbody.innerHTML = ""; empty.style.display = "block"; if (pagination) pagination.innerHTML = ""; return; }
  empty.style.display = "none";
  const totalPages = Math.ceil(filtered.length / REQUESTS_PER_PAGE);
  adminRequestPage = Math.min(adminRequestPage, totalPages);
  const pageRows = filtered.slice((adminRequestPage - 1) * REQUESTS_PER_PAGE, adminRequestPage * REQUESTS_PER_PAGE);

  tbody.innerHTML = pageRows.map((a) => {
    const done = a.served || a.status === "SERVED";
    let actions;
    if (done || a.status === "CANCELLED" || a.status === "NO_SHOW") {
      actions = "";
    } else if (a.status === "PENDING_APPROVAL") {
      actions = pendingApptActions(a.q);
    } else {
      // Day-of steps live in the manage modal (stepper + step actions).
      actions = `<div class="ml-acts">${mlAct("fa-sliders", "Manage appointment", `openApptModal('${a.q}')`)}</div>`;
    }
    return `<tr class="ml-tr" tabindex="0" onclick="openApptModal('${a.q}')" onkeydown="if(event.key==='Enter'&&event.target===this){openApptModal('${a.q}')}">
      <td><div class="ml-svc">${esc(a.name)}</div><div class="ml-code">${esc(a.studentId)} \u00b7 ${esc(a.q)}</div></td>
      <td><div class="ml-svc" style="font-weight:600;">${esc(a.serviceLabel || a.service || "")}</div>${a.purpose ? `<div class="ml-sub2">${esc(a.purpose)}${a.copies ? ` \u00d7${a.copies}` : ""}</div>` : ""}</td>
      <td><div class="ml-d">${esc(a.dateLabel)}</div><div class="ml-t">${esc(a.time)}</div></td>
      <td>${apptStatusPill(a.status)}</td>
      <td style="text-align:right;">${actions}</td>
    </tr>`;
  }).join("");
  renderTablePagination(pagination, adminRequestPage, totalPages, filtered.length, "setAdminRequestPage");
}

function renderTablePagination(container, page, totalPages, totalCount, fnName, perPage = REQUESTS_PER_PAGE) {
  if (!container) return;
  if (!totalCount) { container.innerHTML = ""; return; }
  const start = (page - 1) * perPage;
  container.innerHTML = totalPages <= 1
    ? `<div class="ml-pager"><span>Showing ${totalCount} of ${totalCount}</span></div>`
    : mlPager(`Showing ${start + 1}-${Math.min(start + perPage, totalCount)} of ${totalCount}`, page > 1, page < totalPages, page, totalPages, `${fnName}(${page - 1})`, `${fnName}(${page + 1})`);
}

function setAdminRequestPage(page) {
  adminRequestPage = Math.max(1, page);
  renderAdminTable();
}

let qrScannerInst = null;
let qrScannerFacing = "environment";
let qrLastScanPayload = "";
let qrLastScanAt = 0;
let SCANNER_DATE_ISO = "";
let SCANNER_TAB = "all";
let SCANNER_Q = "";
let SCANNER_ITEMS = [];
let SCANNER_RECENT = [];

function scannerTodayIso() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}
function scannerIsoToLabel(iso) {
  const dt = new Date(`${iso}T12:00:00+08:00`);
  if (Number.isNaN(dt.getTime())) return typeof todayManilaLabel === "function" ? todayManilaLabel() : "";
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function scannerSyncDateInputs(iso) {
  SCANNER_DATE_ISO = iso || scannerTodayIso();
  const picker = document.getElementById("scannerDatePicker");
  const hidden = document.getElementById("scannerDate");
  if (picker && picker.value !== SCANNER_DATE_ISO) picker.value = SCANNER_DATE_ISO;
  if (hidden) hidden.value = scannerIsoToLabel(SCANNER_DATE_ISO);
}
function scannerSetDateIso(iso) {
  if (!iso) return;
  scannerSyncDateInputs(iso);
  void loadScannerQueue();
}
function scannerShiftDay(delta) {
  const base = new Date(`${SCANNER_DATE_ISO || scannerTodayIso()}T12:00:00+08:00`);
  base.setDate(base.getDate() + delta);
  const nextIso = base.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  scannerSyncDateInputs(nextIso);
  void loadScannerQueue();
}
function scannerToday() {
  scannerSyncDateInputs(scannerTodayIso());
  void loadScannerQueue();
}
function scannerSetTab(tab) {
  SCANNER_TAB = tab || "all";
  renderScannerQueue();
}
function scannerFilterQueue(val) {
  SCANNER_Q = String(val || "");
  renderScannerQueue();
}
function clearScannerRecent() {
  SCANNER_RECENT = [];
  renderScannerRecent();
}
function renderScannerRecent() {
  const wrap = document.getElementById("scannerRecentWrap");
  const list = document.getElementById("scannerRecentList");
  if (!wrap || !list) return;
  if (!SCANNER_RECENT.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  list.innerHTML = SCANNER_RECENT.map((r) => `
    <button type="button" class="sc-recent-item" onclick="handleQrScanResult('${esc(r.q)}')">
      <span class="ml-code">${esc(r.q)}</span>
      <span class="sc-recent-name">${esc(r.name)}</span>
      <span class="sc-recent-ts">${esc(r.at)}</span>
    </button>`).join("");
}

function scannerSetCameraUi(active) {
  const idle = document.getElementById("scCamIdle");
  const wrap = document.getElementById("scannerReaderWrap");
  const startBtn = document.getElementById("btnStartQrScan");
  const stopBtn = document.getElementById("btnStopQrScan");
  const flipBtn = document.getElementById("btnSwitchQrCam");
  const badge = document.getElementById("scCamState");
  if (idle) idle.style.display = active ? "none" : "flex";
  if (wrap) wrap.style.display = active ? "block" : "none";
  if (startBtn) startBtn.style.display = active ? "none" : "";
  if (stopBtn) stopBtn.style.display = active ? "" : "none";
  if (flipBtn) flipBtn.style.display = active ? "" : "none";
  if (badge) {
    badge.className = `st-chip ${active ? "st-ok" : "st-info"}`;
    badge.innerHTML = `<i></i>${active ? "Scanning Live" : "Camera Off"}`;
  }
}

async function startQrScanner() {
  if (typeof window.Html5Qrcode === "undefined") {
    showToast("QR camera library is still loading. Try again or use manual code lookup.", "rgba(180,130,0,.9)");
    return;
  }
  await stopQrScanner();
  scannerSetCameraUi(true);
  try {
    qrScannerInst = new window.Html5Qrcode("scannerReader");
    await qrScannerInst.start(
      { facingMode: qrScannerFacing },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (decodedText) => {
        const now = Date.now();
        if (decodedText === qrLastScanPayload && now - qrLastScanAt < 2500) return;
        qrLastScanPayload = decodedText;
        qrLastScanAt = now;
        void handleQrScanResult(decodedText);
      },
      () => {}
    );
  } catch (err) {
    showToast("Camera access denied or unavailable. Use manual code lookup below.", "rgba(155,22,22,.85)");
    await stopQrScanner();
  }
}

async function stopQrScanner() {
  if (qrScannerInst) {
    try { await qrScannerInst.stop(); } catch {}
    try { await qrScannerInst.clear(); } catch {}
    qrScannerInst = null;
  }
  scannerSetCameraUi(false);
}

async function switchQrCamera() {
  qrScannerFacing = qrScannerFacing === "environment" ? "user" : "environment";
  await startQrScanner();
}

async function submitManualQrScan() {
  const input = document.getElementById("scannerCodeInput");
  const val = (input?.value || "").trim();
  if (!val) { showToast("Enter an appointment code or QR payload.", "rgba(180,130,0,.9)"); return; }
  await handleQrScanResult(val);
}

async function scannerAction(code, action) {
  await queueStatus(code, action);
  await Promise.all([handleQrScanResult(code), loadScannerQueue()]);
}

async function handleQrScanResult(payload) {
  const box = document.getElementById("scannerResultCard");
  if (!box) return;
  const autoCheckIn = Boolean(document.getElementById("scannerAutoCheckIn")?.checked);
  box.style.display = "block";
  box.innerHTML = `<div class="sc-res-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>Verifying QR pass…</span></div>`;
  const res = await api("/api/queue/scan", { method: "POST", body: { payload, autoCheckIn } });
  if (!res.ok) {
    box.innerHTML = `<div class="sc-res-card is-error">
      <div class="sc-res-err-row"><i class="fa-solid fa-circle-xmark"></i><div><b>Verification Failed</b><p>${esc(res.error || "Invalid or unrecognized QR code.")}</p></div></div>
    </div>`;
    showToast("❌ " + (res.error || "Invalid QR code."), "rgba(155,22,22,.85)");
    return;
  }
  const { appointment: a, verified, checkedInNow, warning } = res.data;
  const canAct = ["BOOKED", "RESCHEDULED", "CHECKED_IN"].includes(a.status);
  const toneCls = warning ? "is-warn" : "is-ok";
  const nowStr = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  SCANNER_RECENT = [{ q: a.q, name: a.name, at: nowStr }, ...SCANNER_RECENT.filter((x) => x.q !== a.q)].slice(0, 5);
  renderScannerRecent();

  box.innerHTML = `
    <div class="sc-res-card ${toneCls}">
      <div class="sc-res-top">
        <div class="sc-res-id">
          <span class="sc-res-code">${esc(a.q)}</span>
          ${verified ? `<span class="st-chip st-ok"><i></i>QR Verified</span>` : `<span class="st-chip st-info"><i></i>Code Lookup</span>`}
          ${checkedInNow ? `<span class="st-chip st-info"><i></i>Auto Checked In</span>` : ""}
        </div>
        ${apptStatusPill(a.status)}
      </div>

      <div class="sc-res-student">
        <div class="sc-res-name">${esc(a.name)}</div>
        <div class="sc-res-meta">${esc(a.studentId)} · ${esc(a.serviceLabel || a.service || "")}</div>
        <div class="sc-res-meta"><i class="fa-regular fa-clock" style="margin-right:4px;"></i>${esc(a.dateLabel)} at ${esc(a.time)}${a.linkedId ? ` · Ref ${esc(a.linkedId)}` : ""}</div>
      </div>

      ${warning ? `<div class="sc-res-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>${esc(warning)}</span></div>` : ""}

      <div class="sc-res-acts">
        ${canAct && a.status !== "CHECKED_IN" ? `<button type="button" onclick="scannerAction('${esc(a.q)}','checkin')" class="bk-btn bk-btn-out bk-btn-sm"><i class="fa-solid fa-right-to-bracket"></i>Check In</button>` : ""}
        ${canAct ? `<button type="button" onclick="scannerAction('${esc(a.q)}','serve')" class="bk-btn bk-btn-fill bk-btn-sm"><i class="fa-solid fa-check"></i>Mark Served</button>` : ""}
        ${canAct ? `<button type="button" onclick="scannerAction('${esc(a.q)}','noshow')" class="bk-btn bk-btn-out bk-btn-sm sc-btn-danger-out">No Show</button>` : ""}
        <button type="button" onclick="printAppointmentQr('${esc(a.q)}')" class="bk-btn bk-btn-text bk-btn-sm" title="Print QR Pass ID"><i class="fa-solid fa-print"></i>Pass</button>
      </div>
    </div>`;
  if (checkedInNow) {
    showToast(`✅ ${a.q} checked in via QR scan!`);
    void loadScannerQueue();
  }
}

async function loadScannerQueue() {
  const box = document.getElementById("scannerQueueList");
  if (!box) return;
  if (!SCANNER_DATE_ISO) scannerSyncDateInputs(scannerTodayIso());
  const date = document.getElementById("scannerDate")?.value || scannerIsoToLabel(SCANNER_DATE_ISO);
  box.innerHTML = `<div class="ml-loading">Loading queue for ${esc(date)}…</div>`;
  const result = await api(`/api/queue/manifest?date=${encodeURIComponent(date)}`);
  SCANNER_ITEMS = result.ok ? (result.data.appointments || []) : [];
  const dateSub = document.getElementById("scKpiDateSub");
  if (dateSub) dateSub.textContent = date;
  renderScannerQueue();
}

function renderScannerQueue() {
  const box = document.getElementById("scannerQueueList");
  const tabsEl = document.getElementById("scannerQueueTabs");
  if (!box) return;
  const list = SCANNER_ITEMS || [];
  const checkedIn = list.filter((a) => a.status === "CHECKED_IN");
  const waiting = list.filter((a) => ["BOOKED", "RESCHEDULED"].includes(a.status));
  const served = list.filter((a) => a.status === "SERVED");
  const total = list.length;

  const setNum = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  setNum("scKpiTotal", total);
  setNum("scKpiWaiting", waiting.length);
  setNum("scKpiCheckedIn", checkedIn.length);
  setNum("scKpiServed", served.length);
  const pct = total ? Math.round((served.length / total) * 100) : 0;
  const pctEl = document.getElementById("scKpiServedSub");
  if (pctEl) pctEl.textContent = `${pct}% completed`;

  const tabs = [
    { key: "all", label: "All", count: total },
    { key: "checked_in", label: "Checked In", count: checkedIn.length },
    { key: "waiting", label: "Waiting", count: waiting.length },
    { key: "served", label: "Served", count: served.length },
  ];
  if (tabsEl) {
    tabsEl.innerHTML = tabs.map((t) => `<button type="button" role="tab" aria-selected="${SCANNER_TAB === t.key}" onclick="scannerSetTab('${t.key}')" class="dt-tab${SCANNER_TAB === t.key ? " active" : ""}">${esc(t.label)} <span class="dt-count">${t.count}</span></button>`).join("");
  }

  let shown = list;
  if (SCANNER_TAB === "checked_in") shown = checkedIn;
  else if (SCANNER_TAB === "waiting") shown = waiting;
  else if (SCANNER_TAB === "served") shown = served;

  const q = SCANNER_Q.trim().toLowerCase();
  if (q) {
    shown = shown.filter((a) => `${a.q} ${a.name} ${a.studentId} ${a.serviceLabel || a.service || ""} ${a.time || ""}`.toLowerCase().includes(q));
  }

  // Priority order: CHECKED_IN -> BOOKED/RESCHEDULED -> PENDING -> SERVED/NO_SHOW
  const rank = (s) => (s === "CHECKED_IN" ? 0 : (s === "BOOKED" || s === "RESCHEDULED" ? 1 : (s === "PENDING_APPROVAL" ? 2 : 3)));
  const ordered = [...shown].sort((a, b) => rank(a.status) - rank(b.status));

  if (!ordered.length) {
    const dateLbl = document.getElementById("scannerDate")?.value || "this date";
    box.innerHTML = `<div class="dt-empty ml-empty" style="padding:44px 16px;"><i class="fa-solid fa-calendar-check"></i><div>${q ? "No appointments match your search." : `No appointments in this view for ${esc(dateLbl)}.`}</div></div>`;
    return;
  }

  box.innerHTML = ordered.map((a) => {
    const isAtDesk = a.status === "CHECKED_IN";
    const isWait = ["BOOKED", "RESCHEDULED"].includes(a.status);
    const actions = isAtDesk
      ? `<button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="scannerAction('${esc(a.q)}','serve')"><i class="fa-solid fa-check"></i>Serve</button>
         <button type="button" class="ml-act ml-act-bad" title="Mark No Show" aria-label="Mark No Show" onclick="scannerAction('${esc(a.q)}','noshow')"><i class="fa-solid fa-user-xmark"></i></button>`
      : isWait
        ? `<button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="scannerAction('${esc(a.q)}','checkin')"><i class="fa-solid fa-right-to-bracket"></i>Check In</button>
           <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="scannerAction('${esc(a.q)}','serve')">Serve</button>`
        : apptStatusPill(a.status);
    return `
      <div class="sc-qrow${isAtDesk ? " is-desk" : ""}${a.status === "SERVED" ? " is-done" : ""}">
        <div class="sc-qtime">
          <b>${esc(a.time || "—")}</b>
          <span class="ml-code">${esc(a.q)}</span>
        </div>
        <div class="sc-qmain">
          <div class="sc-qname">${esc(a.name)}${a.studentId ? `<span class="sc-qsn">${esc(a.studentId)}</span>` : ""}</div>
          <div class="sc-qsub">${esc(a.serviceLabel || a.service || "")}${a.purpose ? ` · ${esc(a.purpose)}` : ""}</div>
        </div>
        <div class="sc-qstatus">${isAtDesk || isWait ? apptStatusPill(a.status) : ""}</div>
        <div class="sc-qacts">${actions}</div>
      </div>`;
  }).join("");
}
let queueTab = "";
function setQueueTab(k) { queueTab = k; renderQueue(); }
function phDayKey(d) { return d ? new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }) : ""; }
function queueRow(q) {
  const closed = ["CANCELLED", "NO_SHOW"].includes(q.status);
  const pending = q.status === "PENDING_APPROVAL";
  const act = q.served || closed ? ""
    : pending ? pendingApptActions(q.q)
    : `<div class="ml-acts">${q.status === "CHECKED_IN" ? "" : mlAct("fa-right-to-bracket", "Check in", `queueStatus('${q.q}','checkin')`)}${mlAct("fa-bell-concierge", "Serve", `serveQueue('${q.q}')`, "ml-act-star")}</div>`;
  const when = q.startsAt ? new Date(q.startsAt) : null;
  const dateTxt = when ? when.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "Asia/Manila" }) : "";
  return `<div class="ad-ap${q.served ? " done" : ""}" tabindex="0" onclick="openApptModal('${q.q}')" onkeydown="if(event.key==='Enter'&&event.target===this){openApptModal('${q.q}')}">
    <div class="ad-ap-t"><b>${esc(q.time || "")}</b>${queueTab === "today" ? "" : `<span>${esc(dateTxt)}</span>`}</div>
    <div class="ad-ap-who"><div class="ml-svc">${esc(q.name)}</div><div class="ml-code">${esc(q.studentId)}</div></div>
    <div class="ad-ap-svc"><div>${esc(q.serviceLabel || q.service || "General")}</div><div class="ml-code">${esc(q.q)}</div></div>
    <div class="ad-ap-st">${apptStatusPill(q.served ? "SERVED" : q.status)}</div>
    <div class="ad-ap-act" onclick="event.stopPropagation()">${act}</div>
  </div>`;
}

function renderQueue() {
  const todayKey = phDayKey(Date.now());
  const open = queueData.filter((q) => !["CANCELLED", "NO_SHOW"].includes(q.status));
  const byTime = (a, b) => (Date.parse(a.startsAt) || 0) - (Date.parse(b.startsAt) || 0);
  const groups = {
    today: open.filter((q) => phDayKey(q.startsAt) === todayKey).sort(byTime),
    approval: queueData.filter((q) => q.status === "PENDING_APPROVAL").sort(byTime),
    overdue: open.filter((q) => !q.served && q.status !== "PENDING_APPROVAL" && phDayKey(q.startsAt) < todayKey).sort(byTime).reverse(),
    upcoming: open.filter((q) => !q.served && (Date.parse(q.startsAt) || 0) > Date.now() && phDayKey(q.startsAt) !== todayKey).sort(byTime),
  };
  const tabs = [
    { key: "today", label: "Today", count: groups.today.length },
    { key: "approval", label: "Needs approval", count: groups.approval.length },
    { key: "upcoming", label: "Upcoming", count: groups.upcoming.length },
    { key: "overdue", label: "Overdue", count: groups.overdue.length },
  ];
  if (!groups[queueTab]) queueTab = ["today", "approval", "overdue", "upcoming"].find((k) => groups[k].length) || "today";
  const tabsEl = document.getElementById("queueTabs");
  if (tabsEl) tabsEl.innerHTML = dtTabs(tabs, queueTab, "setQueueTab", true);
  const qs = (document.getElementById("queueSearch")?.value || "").trim().toLowerCase();
  const list = groups[queueTab].filter((q) => !qs || q.q.toLowerCase().includes(qs) || q.name.toLowerCase().includes(qs) || q.studentId.toLowerCase().includes(qs));
  const tServed = groups.today.filter((q) => q.served).length;
  const tWait = groups.today.length - tServed;
  document.getElementById("queueMeta").textContent = groups.today.length
    ? `${groups.today.length} scheduled today \u00b7 ${tWait} waiting \u00b7 ${tServed} served`
    : `Nothing scheduled today${groups.overdue.length ? ` \u00b7 ${groups.overdue.length} overdue to close out` : ""}`;
  const empty = { today: ["fa-mug-hot", "No appointments scheduled today."], approval: ["fa-circle-check", "No bookings waiting for approval."], upcoming: ["fa-calendar", "No upcoming appointments."], overdue: ["fa-circle-check", "Nothing overdue \u2014 all past visits are closed out."] }[queueTab];
  document.getElementById("queueList").innerHTML = list.length
    ? `<div class="ad-ap-head"><span>Time</span><span>Student</span><span>Service</span><span>Status</span><span></span></div>${list.map(queueRow).join("")}`
    : `<div class="dt-empty"><i class="fa-solid ${empty[0]}"></i><div>${qs ? "No matches for your search." : empty[1]}</div></div>`;
}

const ALL_APPOINTMENTS_PAGE_SIZE = 8;
let allAppointmentsView = "waiting";
const allAppointmentsPages = { waiting: 1, served: 1 };

function viewAllAppointments() {
  const modal = document.getElementById("allQueueModal");
  if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
  allAppointmentsView = "waiting";
  allAppointmentsPages.waiting = 1;
  allAppointmentsPages.served = 1;
  renderAllAppointments();
  modal?.classList.add("open");
}

function closeAllAppointments() {
  document.getElementById("allQueueModal").classList.remove("open");
}

function setAllAppointmentsView(view) {
  if (!["waiting", "served"].includes(view)) return;
  allAppointmentsView = view;
  renderAllAppointments();
}

function changeAllAppointmentsPage(delta) {
  allAppointmentsPages[allAppointmentsView] += delta;
  renderAllAppointments();
}

function renderAllAppointments() {
  const modalList = document.getElementById("allQueueModalList");
  const modalMeta = document.getElementById("allQueueModalMeta");
  if (!modalList || !modalMeta) return;
  const waiting = queueData.filter((q) => !q.served);
  const served = queueData.filter((q) => q.served);
  const activeList = allAppointmentsView === "served" ? served : waiting;
  const totalPages = Math.max(1, Math.ceil(activeList.length / ALL_APPOINTMENTS_PAGE_SIZE));
  allAppointmentsPages[allAppointmentsView] = Math.min(Math.max(1, allAppointmentsPages[allAppointmentsView]), totalPages);
  const currentPage = allAppointmentsPages[allAppointmentsView];
  const start = (currentPage - 1) * ALL_APPOINTMENTS_PAGE_SIZE;
  const pageItems = activeList.slice(start, start + ALL_APPOINTMENTS_PAGE_SIZE);
  modalMeta.textContent = `${queueData.length} appointments · ${served.length} served · ${waiting.length} waiting`;
  const item = (q) => `
    <div class="queue-item${q.served ? "" : " qi-active"}">
      <div>
        <div class="ad-q-code${q.served ? " done" : ""}">${q.q}</div>
        <div style="font-size:11px;font-weight:700;color:rgba(30,5,5,.58);margin-top:2px;">${q.name} · ${q.studentId} · ${q.time}</div>
        <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:1px;">${esc(q.serviceLabel || q.service || "General")}${q.linkedId ? ` · ${esc(q.linkedId)}` : ""}${q.status && q.status !== "BOOKED" && !q.served ? ` · ${esc((q.displayStatus || q.status || "").replace(/_/g, " "))}` : ""}</div>
      </div>
      ${q.served
        ? '<span class="st-chip st-ok"><i></i>Served</span>'
        : q.status === "PENDING_APPROVAL"
          ? pendingApptActions(q.q)
          : `<div class="ml-acts">${mlAct("fa-right-to-bracket", "Check in", `queueStatus('${q.q}','checkin')`)}${mlAct("fa-bell-concierge", "Serve", `serveQueue('${q.q}')`, "ml-act-star")}</div>`}
    </div>`;
  const shownStart = activeList.length ? start + 1 : 0;
  const shownEnd = Math.min(start + ALL_APPOINTMENTS_PAGE_SIZE, activeList.length);
  modalList.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
      <button onclick="setAllAppointmentsView('waiting')" class="${allAppointmentsView === "waiting" ? "btn-maroon" : "btn-ghost"}" style="padding:9px 12px;font-size:12px;"><i class="fa-solid fa-hourglass-half" style="margin-right:5px;"></i>Waiting (${waiting.length})</button>
      <button onclick="setAllAppointmentsView('served')" class="${allAppointmentsView === "served" ? "btn-maroon" : "btn-ghost"}" style="padding:9px 12px;font-size:12px;"><i class="fa-solid fa-check-double" style="margin-right:5px;"></i>Served (${served.length})</button>
    </div>
    <div style="font-size:10px;font-weight:800;letter-spacing:.07em;color:rgba(30,5,5,.62);text-transform:uppercase;margin:0 0 7px;">${allAppointmentsView === "served" ? "Served appointments" : "Waiting to be served"}</div>
    <div style="display:flex;flex-direction:column;gap:8px;">${pageItems.length ? pageItems.map(item).join("") : `<div class="empty-state" style="padding:24px;">No ${allAppointmentsView} appointments.</div>`}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(139,26,26,.12);">
      <span style="font-size:11px;color:rgba(30,5,5,.58);">Showing ${shownStart}–${shownEnd} of ${activeList.length}</span>
      <div style="display:flex;align-items:center;gap:7px;">
        <button onclick="changeAllAppointmentsPage(-1)" class="btn-ghost" style="padding:6px 10px;font-size:10px;" ${currentPage <= 1 ? "disabled" : ""}><i class="fa-solid fa-chevron-left"></i> Previous</button>
        <b style="font-size:11px;color:#8B1A1A;">${currentPage} / ${totalPages}</b>
        <button onclick="changeAllAppointmentsPage(1)" class="btn-ghost" style="padding:6px 10px;font-size:10px;" ${currentPage >= totalPages ? "disabled" : ""}>Next <i class="fa-solid fa-chevron-right"></i></button>
      </div>
    </div>`;
}

// ── Admin Appointments page: calendar + list views over queueData ──
let adminApptView = "list";
let adminApptTab = null;
function setAdminApptTab(k) { adminApptTab = k; adminApptPage = 1; renderAdminAppointments(); }
let adminApptYear = new Date().getFullYear();
let adminApptMonth = new Date().getMonth();
let adminApptDate = null; // dateLabel e.g. "June 23, 2026"
let adminApptSearch = "";
let adminApptSvc = "";
let adminApptStatus = "";
let adminApptPage = 1;
const ADMIN_APPT_PER_PAGE = 10;
const adminApptDateLabel = (y, m, d) => new Date(y, m, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
function setAdminApptView(view) {
  if (!["calendar", "list"].includes(view)) return;
  adminApptView = view;
  adminApptPage = 1;
  renderAdminAppointments();
}
function changeAdminApptMonth(delta) {
  const next = new Date(adminApptYear, adminApptMonth + delta, 1);
  adminApptYear = next.getFullYear();
  adminApptMonth = next.getMonth();
  renderAdminAppointments();
}
function selectAdminApptDate(dateLabel) {
  adminApptDate = dateLabel;
  renderAdminAppointments();
}
function adminApptFiltered() {
  const q = (adminApptSearch || "").trim().toLowerCase();
  return [...queueData]
    .sort((a, b) => new Date(b.startsAt || 0) - new Date(a.startsAt || 0))
    .filter((a) => {
      const matchSvc = !adminApptSvc || (a.serviceLabel || a.service) === adminApptSvc;
      const matchStatus = !adminApptStatus || a.status === adminApptStatus;
      const matchQ = !q || a.q.toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.studentId || "").toLowerCase().includes(q);
      return matchSvc && matchStatus && matchQ;
    });
}
function renderAdminAppointments() {
  if (!document.getElementById("page-appointments")?.classList.contains("active")) return;
  const calBtn = document.getElementById("adminApptViewCal");
  const listBtn = document.getElementById("adminApptViewList");
  if (calBtn) calBtn.classList.toggle("active", adminApptView === "calendar");
  if (listBtn) listBtn.classList.toggle("active", adminApptView === "list");
  const isList = adminApptView === "list";
  const pendingN = queueData.filter((a) => a.status === "PENDING_APPROVAL").length;
  if (adminApptTab === null) adminApptTab = pendingN ? "pending" : "all";
  const tabsEl = document.getElementById("adminApptTabs");
  if (tabsEl) {
    tabsEl.style.display = isList ? "" : "none";
    tabsEl.innerHTML = dtTabs([
      { key: "pending", label: "Needs approval", count: pendingN },
      { key: "all", label: "All appointments", count: queueData.length },
      { key: "pickups", label: "Pickups", count: adminPickupCount() },
    ], adminApptTab, "setAdminApptTab", true);
  }
  const calWrap = document.getElementById("adminApptCalendarWrap");
  if (calWrap) calWrap.style.display = isList ? "none" : "";
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? "" : "none"; };
  show("adminApptPendingWrap", isList && adminApptTab === "pending");
  show("adminApptListWrap", isList && adminApptTab === "all");
  show("adminApptPickupWrap", isList && adminApptTab === "pickups");
  // Keep filter selects in sync (service options come from live data).
  const svcSel = document.getElementById("adminApptSvc");
  if (svcSel) {
    const svcs = [...new Set(queueData.map((a) => a.serviceLabel || a.service))].sort();
    svcSel.innerHTML = '<option value="">All Services</option>' + svcs.map((d) => `<option value="${esc(d)}"${d === adminApptSvc ? " selected" : ""}>${esc(d)}</option>`).join("");
    if (adminApptSvc && !svcs.includes(adminApptSvc)) adminApptSvc = "";
  }
  const statusSel = document.getElementById("adminApptStatus");
  if (statusSel && statusSel.value !== adminApptStatus) statusSel.value = adminApptStatus;
  renderAdminApptPending();
  renderAdminAppointmentsCalendar();
  renderAdminAppointmentsList();
  renderAdminApptPickups();
}
/** Pending-approval inbox: every unapproved booking in one place (admin). */
function adminPendingAppts() {
  const q = (adminApptSearch || "").trim().toLowerCase();
  return [...queueData]
    .filter((a) => a.status === "PENDING_APPROVAL")
    .filter((a) => !q || a.q.toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.studentId || "").toLowerCase().includes(q))
    .sort((a, b) => new Date(a.startsAt || 0) - new Date(b.startsAt || 0));
}
function adminPickupCount() {
  const done = /^(claimed|completed|rejected|cancelled)$/i;
  return (MOD.requests || []).filter((r) => r.pickupDate && r.status === "Pickup Scheduled").length
    + (MOD.idapps || []).filter((x) => x.pickupDate && !done.test(x.status || "")).length;
}
function renderAdminApptPending() {
  const wrap = document.getElementById("adminApptPendingWrap");
  if (!wrap) return;
  const items = adminPendingAppts();
  const validCodes = new Set(items.map((a) => a.q));
  for (const c of [...BATCH_SEL.pendingAppts]) { if (!validCodes.has(c)) BATCH_SEL.pendingAppts.delete(c); }
  const selCount = BATCH_SEL.pendingAppts.size;
  const allChk = document.getElementById("chkAllPendingAppts");
  if (allChk) allChk.checked = items.length > 0 && selCount === items.length;
  const batchBar = document.getElementById("adminApptPendingBatchBar");
  if (batchBar) {
    if (isAdmin() && selCount) {
      batchBar.style.display = "flex";
      batchBar.innerHTML = `<span><i class="fa-solid fa-list-check" style="margin-right:8px;color:#8B1A1A;"></i>${selCount} selected</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn-maroon" onclick="batchPendingAppointments('approve')"><i class="fa-solid fa-check-double"></i>Approve ${selCount}</button>
          <button type="button" class="btn-ghost" onclick="batchPendingAppointments('reject')"><i class="fa-solid fa-xmark"></i>Reject ${selCount}</button>
          <button type="button" class="btn-ghost" onclick="toggleBatchSelectAll('pendingAppts', false);renderAdminAppointments()">Clear</button>
        </div>`;
    } else {
      batchBar.style.display = "none";
    }
  }
  document.getElementById("adminApptPendingTable").innerHTML = items.length ? items.map((a) => `<tr class="ml-tr" tabindex="0" onclick="openApptModal('${a.q}')" onkeydown="if(event.key==='Enter'&&event.target===this){openApptModal('${a.q}')}">
    <td class="ml-chk" onclick="event.stopPropagation()"><input type="checkbox" class="batch-chk" data-batch="pendingAppts" value="${esc(a.q)}" ${BATCH_SEL.pendingAppts.has(a.q) ? "checked" : ""} onchange="toggleBatchItem('pendingAppts','${esc(a.q)}',this.checked)" aria-label="Select ${esc(a.q)}"></td>
    <td><div class="ml-svc">${esc(a.q)}</div><div class="ml-sub2">${esc(a.serviceLabel || a.service || "")}${a.linkedId ? ` \u00b7 ${esc(a.linkedId)}` : ""}</div></td>
    <td><div class="ml-svc" style="font-weight:600;">${esc(a.name)}</div><div class="ml-code">${esc(a.studentId)}</div></td>
    <td><div class="ml-d">${esc(a.dateLabel)}</div><div class="ml-t">${esc(a.time)}</div></td>
    <td style="text-align:right;" onclick="event.stopPropagation()">${pendingApptActions(a.q)}</td>
  </tr>`).join("") : `<tr><td colspan="5"><div class="dt-empty" style="border:0;padding:40px 10px;"><i class="fa-solid fa-circle-check"></i><div>Nothing is waiting for approval.</div></div></td></tr>`;
}
function renderAdminAppointmentsCalendar() {
  const container = document.getElementById("adminApptCalendar");
  if (!container) return;
  const counts = {};
  queueData.forEach((a) => { if (a.dateLabel) counts[a.dateLabel] = (counts[a.dateLabel] || 0) + 1; });
  const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const first = new Date(adminApptYear, adminApptMonth, 1).getDay();
  const total = new Date(adminApptYear, adminApptMonth + 1, 0).getDate();
  const monthName = new Date(adminApptYear, adminApptMonth, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const now = new Date(), todayLabel = adminApptDateLabel(now.getFullYear(), now.getMonth(), now.getDate());
  let html = `<div class="ad-calnav"><button type="button" class="ml-act" onclick="changeAdminApptMonth(-1)" title="Previous month" aria-label="Previous month"><i class="fa-solid fa-chevron-left"></i></button><div>${esc(monthName)}</div><button type="button" class="ml-act" onclick="changeAdminApptMonth(1)" title="Next month" aria-label="Next month"><i class="fa-solid fa-chevron-right"></i></button></div>
  <div class="sc-grid">${days.map((d) => `<div class="sc-dow">${d}</div>`).join("")}`;
  for (let i = 0; i < first; i++) html += "<div></div>";
  for (let d = 1; d <= total; d++) {
    const label = adminApptDateLabel(adminApptYear, adminApptMonth, d);
    const n = counts[label] || 0;
    html += `<button type="button" class="sc-day${label === todayLabel ? " today" : ""}${adminApptDate === label ? " sel" : ""}" onclick="selectAdminApptDate('${esc(label)}')" title="${esc(label)}${n ? `: ${n} visit${n === 1 ? "" : "s"}` : ""}" aria-label="${esc(label)}${n ? `: ${n} visit${n === 1 ? "" : "s"}` : ""}"><span>${d}</span><span class="sc-dots">${n ? `<b class="ad-n">${n}</b>` : ""}</span></button>`;
  }
  container.innerHTML = html + "</div>";
  const title = document.getElementById("adminApptDayTitle");
  const meta = document.getElementById("adminApptDayMeta");
  const list = document.getElementById("adminApptDayList");
  if (!title || !meta || !list) return;
  if (!adminApptDate) {
    title.textContent = "Select a date";
    meta.textContent = "Pick a day on the calendar to see its visits.";
    list.innerHTML = "";
    return;
  }
  const dayItems = adminApptFiltered().filter((a) => a.dateLabel === adminApptDate);
  title.textContent = adminApptDate;
  meta.textContent = `${dayItems.length} visit${dayItems.length === 1 ? "" : "s"}`;
  list.innerHTML = dayItems.length ? dayItems.map((a) => `
    <div class="queue-item${a.served ? "" : " qi-active"}">
      <div>
        <div style="font-size:16px;font-weight:900;color:${a.served ? "rgba(30,5,5,.52)" : "#1a0505"};">${esc(a.q)}</div>
        <div style="font-size:11px;font-weight:700;color:rgba(30,5,5,.58);margin-top:2px;">${esc(a.name)} · ${esc(a.studentId)} · ${esc(a.time)}</div>
        <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:1px;">${esc(a.serviceLabel || a.service || "General")}${a.linkedId ? ` · ${esc(a.linkedId)}` : ""}</div>
        ${a.served ? "" : `<div style="margin-top:4px;">${apptStatusPill(a.status)}</div>`}
      </div>
      ${a.served
        ? '<span class="st-chip st-ok"><i></i>Served</span>'
        : a.status === "PENDING_APPROVAL"
          ? pendingApptActions(a.q)
          : a.status === "CANCELLED" || a.status === "NO_SHOW"
            ? apptStatusPill(a.status)
            : `<div class="ml-acts">${mlAct("fa-sliders", "Manage appointment", `openApptModal('${a.q}')`)}</div>`}
    </div>`).join("") : '<div class="empty-state" style="padding:24px;">No visits on this date.</div>';
}
function renderAdminAppointmentsList() {
  const tbody = document.getElementById("adminApptTable");
  if (!tbody) return;
  const empty = document.getElementById("adminApptEmpty");
  const pagination = document.getElementById("adminApptPagination");
  const meta = document.getElementById("adminApptListMeta");
  const filtered = adminApptFiltered();
  if (meta) meta.textContent = `${filtered.length} total`;
  if (!filtered.length) {
    tbody.innerHTML = "";
    if (empty) empty.style.display = "block";
    if (pagination) pagination.innerHTML = "";
    return;
  }
  if (empty) empty.style.display = "none";
  const totalPages = Math.max(1, Math.ceil(filtered.length / ADMIN_APPT_PER_PAGE));
  adminApptPage = Math.min(Math.max(1, adminApptPage), totalPages);
  const rows = filtered.slice((adminApptPage - 1) * ADMIN_APPT_PER_PAGE, adminApptPage * ADMIN_APPT_PER_PAGE);
  tbody.innerHTML = rows.map((a) => {
    const done = a.served || a.status === "SERVED";
    let actions;
    if (done || a.status === "CANCELLED" || a.status === "NO_SHOW") {
      actions = "";
    } else if (a.status === "PENDING_APPROVAL") {
      actions = pendingApptActions(a.q);
    } else {
      // Day-of steps live in the manage modal (stepper + step actions).
      actions = `<div class="ml-acts">${mlAct("fa-sliders", "Manage appointment", `openApptModal('${a.q}')`)}</div>`;
    }
    return `<tr class="ml-tr" tabindex="0" onclick="openApptModal('${a.q}')" onkeydown="if(event.key==='Enter'&&event.target===this){openApptModal('${a.q}')}">
      <td><div class="ml-svc">${esc(a.q)}</div><div class="ml-sub2">${esc(a.serviceLabel || a.service || "")}</div></td>
      <td><div class="ml-svc" style="font-weight:600;">${esc(a.name)}</div><div class="ml-code">${esc(a.studentId)}</div></td>
      <td><div class="ml-d">${esc(a.dateLabel)}</div><div class="ml-t">${esc(a.time)}</div></td>
      <td>${apptStatusPill(a.status)}</td>
      <td style="text-align:right;" onclick="event.stopPropagation()">${actions}</td>
    </tr>`;
  }).join("");
  renderTablePagination(pagination, adminApptPage, totalPages, filtered.length, "setAdminApptPage", ADMIN_APPT_PER_PAGE);
}
function setAdminApptPage(page) {
  adminApptPage = Math.max(1, Number(page) || 1);
  renderAdminAppointmentsList();
}
/** Requests with a scheduled pickup — ready to be claimed (student + admin view). */
function renderAdminApptPickups() {
  const tbody = document.getElementById("adminApptPickupTable");
  if (!tbody) return;
  const empty = document.getElementById("adminApptPickupEmpty");
  const meta = document.getElementById("adminApptPickupMeta");
  const IDA_DONE_RE = /^(claimed|completed|rejected|cancelled)$/i;
  const items = [
    ...((MOD.requests || []).filter((r) => r.pickupDate && r.status === "Pickup Scheduled").map((r) => ({
      id: r.id, title: r.subject || reqServiceLabel(r.service), sub: `${r.id} · ${reqServiceLabel(r.service)}`,
      name: r.name, sn: r.sn, when: `${r.pickupDate} ${r.pickupTime || ""}`.trim(), status: r.status, kind: "requests",
    }))),
    ...((MOD.idapps || []).filter((a) => a.pickupDate && !IDA_DONE_RE.test(a.status || "")).map((a) => ({
      id: a.id, title: a.type, sub: `${a.id} · ID Application`,
      name: a.name, sn: a.sn, when: `${a.pickupDate} ${a.pickupTime || ""}`.trim(), status: a.status, kind: "idapps",
    }))),
  ].sort((x, y) => new Date(x.when).getTime() - new Date(y.when).getTime());
  if (meta) meta.textContent = `${items.length} scheduled`;
  if (!items.length) {
    tbody.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  tbody.innerHTML = items.map((p) => `<tr>
    <td><div style="font-weight:700;font-size:13px;color:#1a0505;">${esc(p.title)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(p.sub)}</div></td>
    <td><div style="font-size:13px;font-weight:700;color:#1a0505;">${esc(p.name)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(p.sn)}</div></td>
    <td style="font-size:12px;color:#15803d;font-weight:700;white-space:nowrap;">${esc(p.when)}</td>
    <td>${pill(p.status)}</td>
    <td style="text-align:right;"><div class="ml-acts">${mlAct("fa-sliders", "Manage", `${p.kind === "idapps" ? "openIdAppModal" : "openRequestModal"}('${esc(p.id)}')`)}</div></td>
  </tr>`).join("");
}

/** Action buttons for a booking awaiting SSO approval (admin only). */
function pendingApptActions(q) {
  if (!isAdmin()) return `<span class="st-chip st-warn"><i></i>Awaiting approval</span>`;
  return `<div class="ml-acts">${mlAct("fa-check", "Approve", `queueStatus('${q}','approve')`, "ml-act-star")}${mlAct("fa-xmark", "Reject", `queueStatus('${q}','reject')`, "ml-act-bad")}${mlAct("fa-sliders", "Manage appointment", `openApptModal('${q}')`)}</div>`;
}

// ── Appointment workflow: stepper + step actions + manage modal ──
// Same dedicated-workflow pattern as wf* (requests). Fixed forward steps:
// Pending Approval → Confirmed → Checked In → Completed.
// RESCHEDULED rides at the Confirmed stage. Branches: rejected/cancelled
// closes and no-show. Approve/Reject exist only at Pending Approval.
const APPT_FLOW_STEPS = ["Pending Approval", "Confirmed", "Checked In", "Completed"];
function apptStage(a) {
  const s = (a || {}).status;
  if (s === "PENDING_APPROVAL") return 0;
  if (s === "BOOKED" || s === "RESCHEDULED" || s === "PENDING") return 1;
  // Legacy IN_PROGRESS rows (pre-2026-09-29) read as checked-in.
  if (s === "CHECKED_IN" || s === "IN_PROGRESS") return 2;
  if (s === "SERVED") return 3;
  return -1;
}
function apptIsTerminal(a) {
  return ["SERVED", "CANCELLED", "NO_SHOW"].includes((a || {}).status);
}
/** Compact "Step X of 5" line for dense table cells (student + admin). */
function apptMiniStep(a) {
  const stage = apptStage(a);
  if (stage < 0) return "";
  if (apptIsTerminal(a)) return "";
  return `<div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:3px;">Step ${stage + 1} of 4 · ${esc(APPT_FLOW_STEPS[stage])}</div>`;
}
/** Full progress stepper + branch banner for the manage modal. */
function apptStepperHtml(a) {
  const cur = (a || {}).status || "";
  const idx = apptStage(a);
  const dots = APPT_FLOW_STEPS.map((s, i) => {
    const done = idx >= 0 && i < idx;
    const isCur = i === idx;
    const bg = done ? "#15803d" : isCur ? "#8B1A1A" : "rgba(30,5,5,.15)";
    const fg = (done || isCur) ? "#fff" : "rgba(30,5,5,.55)";
    const dot = `<span title="${esc(s)}" style="min-width:20px;height:20px;border-radius:99px;background:${bg};color:${fg};font-size:10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;">${done ? "✓" : (i + 1)}</span>`;
    const lbl = `<span style="font-size:9px;font-weight:${isCur ? "800" : "400"};color:${isCur ? "#1a0505" : "rgba(30,5,5,.55)"};white-space:nowrap;">${esc(s)}</span>`;
    const cell = `<span style="display:inline-flex;flex-direction:column;align-items:center;gap:2px;">${dot}${lbl}</span>`;
    const link = i < APPT_FLOW_STEPS.length - 1 ? `<span style="flex:1;height:2px;min-width:8px;margin:0 2px 14px;background:${done ? "#15803d" : "rgba(30,5,5,.12)"};border-radius:2px;"></span>` : "";
    return cell + link;
  }).join("");
  let banner = "";
  if (cur === "CANCELLED") {
    banner = `<div style="font-size:11px;color:#4b5563;background:rgba(107,114,128,.1);border:1px solid rgba(107,114,128,.3);border-radius:10px;padding:7px 10px;margin-top:8px;"><i class="fa-solid fa-ban" style="margin-right:5px;"></i>Closed — Cancelled${a.cancelReason ? `: ${esc(a.cancelReason)}` : ""}. Read-only.</div>`;
  } else if (cur === "NO_SHOW") {
    banner = `<div style="font-size:11px;color:#4b5563;background:rgba(107,114,128,.1);border:1px solid rgba(107,114,128,.3);border-radius:10px;padding:7px 10px;margin-top:8px;"><i class="fa-solid fa-user-clock" style="margin-right:5px;"></i>Missed — marked no-show. The seat was freed for rebooking.</div>`;
  } else if (cur === "SERVED") {
    banner = `<div style="font-size:11px;color:#15803d;background:rgba(22,163,74,.1);border:1px solid rgba(22,163,74,.3);border-radius:10px;padding:7px 10px;margin-top:8px;"><i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>Finished — visit completed.</div>`;
  } else if (cur === "PENDING_APPROVAL") {
    banner = `<div style="font-size:11px;color:#a16207;background:rgba(180,130,0,.1);border:1px solid rgba(180,130,0,.3);border-radius:10px;padding:7px 10px;margin-top:8px;"><i class="fa-solid fa-hourglass-half" style="margin-right:5px;"></i>Awaiting SSO approval — approve to confirm the visit, or reject with a reason.</div>`;
  } else if (idx < 0) {
    banner = `<div style="font-size:11px;color:rgba(30,5,5,.6);margin-top:8px;">Current stage: <b>${esc(cur)}</b> (outside the standard flow).</div>`;
  }
  return `<div style="margin:4px 0 2px;"><div style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:rgba(30,5,5,.5);margin-bottom:6px;">Progress</div><div style="display:flex;align-items:flex-start;overflow-x:auto;padding-bottom:2px;">${dots}</div>${banner}</div>`;
}
/** Footer for the appointment manage modal: one primary step + a More menu for the rest. */
function apptFooterHtml(a) {
  const q = esc(a.q);
  const stage = apptStage(a);
  const ask = (action, title, text, confirm, withReason) => `maAsk({title:'${title}',text:'${text}',confirm:'${confirm}',reasonId:${withReason ? `'apptReason-${q}'` : "null"},on:&quot;apptAdvance('${q}','${action}')&quot;})`;
  if (a.status === "PENDING_APPROVAL") {
    return maFooter(maPrimary("Approve booking", "fa-check", `apptAdvance('${q}','approve')`),
      [{ label: "Reject booking", icon: "fa-xmark", danger: true, on: ask("reject", "Reject this booking?", "The student is notified. Add a reason so they know why.", "Reject booking", true) }]);
  }
  if (stage === 1 || stage === 2) {
    return maFooter(stage === 1 ? maPrimary("Check in", "fa-right-to-bracket", `apptAdvance('${q}','checkin')`) : maPrimary("Complete visit", "fa-bell-concierge", `apptAdvance('${q}','serve')`),
      [{ label: "Mark no-show", icon: "fa-user-clock", on: ask("noshow", "Mark as no-show?", "The seat is freed for rebooking.", "Mark no-show", false) },
       "-",
       { label: "Cancel visit", icon: "fa-ban", danger: true, on: ask("cancel", "Cancel this visit?", "The student is notified. Add a reason so they know why.", "Cancel visit", true) }]);
  }
  return maFooter("", []);
}
/** Dispatcher behind appointment workflow buttons (reads the inline reason box, if shown). */
async function apptAdvance(q, action) {
  const reasonEl = document.getElementById("apptReason-" + q);
  const reason = reasonEl ? reasonEl.value.trim() : "";
  return queueStatus(q, action, reason || undefined, true);
}
/** Appointment manage modal: details + stepper + step actions. */
function openApptModal(q) {
  const a = (queueData || []).find((x) => x.q === q);
  if (!a) { showToast("❌ Appointment not found.", "rgba(155,22,22,.85)"); return; }
  const terminal = apptIsTerminal(a);
  const needsReason = !terminal;
  openAppModal({ title: `${a.q} — ${esc(a.serviceLabel || a.service || "Visit")}`, subtitle: `${a.name} · ${a.studentId} · ${a.dateLabel} ${a.time}`, icon: "fa-calendar-days", wide: true, content: `
    <div style="display:grid;gap:12px;">
      <div class="glass-card" style="padding:14px;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">${apptStatusPill(a.status)}
          ${a.linkedId ? `<span style="font-size:11px;">Linked ref: <b>${esc(a.linkedId)}</b></span>` : ""}
          ${a.bookedBy ? `<span style="font-size:11px;">Booked by: <b>${esc(a.bookedBy)}</b></span>` : ""}
          ${(a.rescheduleCount || 0) > 0 ? `<span style="font-size:11px;">Rescheduled ×${a.rescheduleCount}</span>` : ""}
        </div>
        ${a.purpose ? `<div style="font-size:12px;color:rgba(30,5,5,.8);margin-top:6px;">Purpose: <b>${esc(a.purpose)}</b>${a.copies ? ` ×${a.copies}` : ""}</div>` : ""}
        ${a.notes ? `<div style="font-size:12px;color:rgba(30,5,5,.65);margin-top:4px;font-style:italic;">“${esc(a.notes)}”</div>` : ""}
      </div>
      ${apptStepperHtml(a)}
      ${apptFooterHtml(a)}
    </div>` });
}

/** Re-render whichever request view is active after a mutation. */
async function refreshAfterModuleChange(kind) {
  if (document.getElementById("page-appointments")?.classList.contains("active")) {
    await Promise.all([loadModule("requests"), loadModule("idapps"), loadQueueData()]);
    renderAdminAppointments();
    return;
  }
  if (document.getElementById("page-requests")?.classList.contains("active")) {
    await loadModule("requests"); await loadModule("idapps"); renderServiceRequests();
    return;
  }
  if (kind === "idapps") { await loadModule("idapps"); renderIdApp(); }
  else { await loadModule("requests"); renderServiceRequests(); }
}

async function serveQueue(qNum) {
  const { ok, error } = await api(`/api/queue/${encodeURIComponent(qNum)}/status`, { method: "POST", body: { action: "serve" } });
  if (!ok) { showToast(`❌ ${error || "Could not update the queue."}`, "rgba(155,22,22,.85)"); return; }
  const entry = queueData.find((q) => q.q === qNum);
  showToast(`✅ ${qNum} — ${entry ? entry.name : ""} marked as served.`);
  await loadQueueData();
  await loadAuditLog();
  renderQueue();
  if (document.getElementById("page-appointments")?.classList.contains("active")) renderAdminAppointments();
  if (document.getElementById("allQueueModal")?.classList.contains("open")) renderAllAppointments();
  renderAuditLog();
}

async function queueStatus(qNum, action, reason, skipConfirm) {
  if (skipConfirm) {
    // confirmed inline in the modal
  } else if (action === "approve" || action === "reject") {
    if (!confirm(`${action === "approve" ? "Approve" : "Reject"} booking ${qNum}?${action === "reject" ? " The student will be notified." : " It will be confirmed for the student."}`)) return;
  } else if (action === "cancel") {
    if (!confirm(`Cancel booking — ${qNum}? The student will be notified.`)) return;
  } else {
    const label = { checkin: "check in", serve: "serve", noshow: "mark as no-show" }[action] || action;
    if (!confirm(`${label === "mark as no-show" ? "Mark" : "Confirm"} ${label} — ${qNum}?`)) return;
  }
  const body = { action };
  if (reason) body.reason = reason;
  const { ok, error } = await api(`/api/queue/${encodeURIComponent(qNum)}/status`, { method: "POST", body });
  if (!ok) { showToast(`❌ ${error || "Could not update the appointment."}`, "rgba(155,22,22,.85)"); return; }
  showToast(action === "approve" ? `✅ ${qNum} approved and confirmed.` : action === "reject" ? `✅ ${qNum} rejected — student notified.` : `✅ ${qNum} updated.`);
  if (skipConfirm) closeAppModal();
  await loadQueueData();
  renderQueue();
  if (document.getElementById("page-appointments")?.classList.contains("active")) renderAdminAppointments();
  if (document.getElementById("allQueueModal")?.classList.contains("open")) renderAllAppointments();
  if (document.getElementById("scannerQueueList")) loadScannerQueue();
}


function renderCharts() {
  const active = queueData.filter((a) => ["BOOKED", "RESCHEDULED", "CHECKED_IN", "PENDING", "PENDING_APPROVAL"].includes(a.status)).length;
  const served = queueData.filter((a) => a.served || a.status === "SERVED").length;
  const missed = queueData.filter((a) => ["CANCELLED", "NO_SHOW"].includes(a.status)).length;

  const dCtx = document.getElementById("adminChart");
  if (dCtx) {
    if (donutChart) {
      try { donutChart.data.datasets[0].data = [served, active, missed]; donutChart.update(); }
      catch (e) { donutChart.destroy(); donutChart = null; }
    }
    if (!donutChart) {
      donutChart = new Chart(dCtx, {
        type: "doughnut",
        data: { labels: ["Served", "Active", "Cancelled/No-show"], datasets: [{ data: [served, active, missed], backgroundColor: ["#8B1A1A", "#D4A017", "#dc2626"], borderWidth: 2, borderColor: "rgba(255,255,255,.8)" }] },
        options: { plugins: { legend: { display: false } }, cutout: "72%" },
      });
    }
  }

  const svcCounts = {};
  queueData.forEach((a) => { const k = a.serviceLabel || a.service || "General"; svcCounts[k] = (svcCounts[k] || 0) + 1; });
  const topSvcs = Object.entries(svcCounts).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const barLabels = topSvcs.map(([k]) => k);
  const barData = topSvcs.map(([, n]) => n);
  const bCtx = document.getElementById("barChart");
  if (bCtx) {
    if (barChartInst) {
      try { barChartInst.data.labels = barLabels; barChartInst.data.datasets[0].data = barData; barChartInst.update(); }
      catch (e) { barChartInst.destroy(); barChartInst = null; }
    }
    if (!barChartInst) {
      barChartInst = new Chart(bCtx, {
        type: "bar",
        data: { labels: barLabels, datasets: [{ data: barData, backgroundColor: "#8B1A1A", borderRadius: 4 }] },
        options: { plugins: { legend: { display: false } }, scales: { y: { display: false }, x: { ticks: { color: "rgba(80,20,20,.55)", font: { size: 10, family: "Inter" } }, grid: { display: false } } } },
      });
    }
  }
}


function renderAuditLog() {
  // The audit log now lives on its own page (page-audit). Kept as a no-op so old call sites stay safe.
  const el = document.getElementById("auditLog");
  if (!el) return;
  const color = { INFO: "#4ade80", WARN: "#facc15", ERROR: "#f87171" };
  el.innerHTML = [...auditLogs].reverse().map((l) => `<div><span style="color:${color[l.type] || "#fff"};">[${esc(l.type)}]</span> ${esc(l.ts)} — ${esc(l.msg)}</div>`).join("");
}

// ── Audit Logs page (Super Admin): log-console dashboard — level cards, quick filters, live tail, CSV ──
var AUDIT_DEF = { level: "", q: "", from: "", to: "", page: 1, pageSize: 25, order: "desc", preset: "" };
var AUDIT_Q = { ...AUDIT_DEF };
var AUDIT_ROWS = [], AUDIT_TIMER = null;
const AUDIT_CHIPS = [["Sign-ins", "signed in"], ["Sign-outs", "signed out"], ["Failed", "fail"], ["Settings", "setting"], ["Memo", "memo"], ["Backup", "backup"], ["Archive", "archiv"]];
function auditYMD(d) { return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); }
async function renderAuditPage() {
  const box = document.getElementById("auditPageBody"); if (!box) return;
  if (!isSuperAdmin()) { box.innerHTML = `<div class="dt-empty ml-empty"><i class="fa-solid fa-lock"></i><div>Restricted to Super Admin.</div></div>`; return; }
  if (!box.dataset.built) {
    box.dataset.built = "1";
    box.innerHTML = `
      <div id="audStats" class="lg-stats"></div>
      <div class="lg-bar">
        <label class="ml-search"><i class="fa-solid fa-magnifying-glass"></i><input id="audQ" type="search" placeholder="Search events…" maxlength="100" aria-label="Search audit events" onkeydown="if(event.key==='Enter')auditApply()"></label>
        <div class="lg-presets" role="group" aria-label="Date range">${[["", "All time"], ["today", "Today"], ["7", "7 days"], ["30", "30 days"]].map(([k, l]) => `<button type="button" class="lg-pre" data-k="${k}" onclick="auditPreset('${k}')">${l}</button>`).join("")}</div>
        <div class="bk-input sa-date-input"><input id="audFrom" type="date" aria-label="From date" title="From date" onchange="auditApply(true)"></div>
        <div class="bk-input sa-date-input"><input id="audTo" type="date" aria-label="To date" title="To date" onchange="auditApply(true)"></div>
        <div class="bk-input ml-dd lg-dd"><select id="audOrder" data-dd="1" aria-label="Sort order" onchange="auditApply()"><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></div>
      </div>
      <div class="lg-chiprow">
        <span class="lg-chiplbl">Quick filters</span>
        ${AUDIT_CHIPS.map(([l, k]) => `<button type="button" class="lg-chip" data-q="${k}" onclick="auditChip('${k}')">${l}</button>`).join("")}
        <span class="lg-spacer"></span>
        <div class="bk-input ml-dd lg-dd lg-size"><select id="audSize" data-dd="1" aria-label="Rows per page" onchange="auditApply()"><option value="25">25 / page</option><option value="50">50 / page</option><option value="100">100 / page</option></select></div>
        <button type="button" id="audLive" class="bk-btn bk-btn-out bk-btn-sm" onclick="auditToggleLive()" title="Refresh every 10 seconds"><i class="fa-solid fa-satellite-dish"></i>Live tail</button>
        <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="auditLoad()" title="Refresh now"><i class="fa-solid fa-rotate"></i>Refresh</button>
        <button type="button" class="bk-btn bk-btn-text bk-btn-sm" onclick="auditReset()" title="Clear all filters"><i class="fa-solid fa-rotate-left"></i>Reset</button>
      </div>
      <div id="auditTable"></div>
      <div id="auditPager"></div>`;
  }
  await auditLoad();
}
function auditSync() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  set("audQ", AUDIT_Q.q); set("audFrom", AUDIT_Q.from); set("audTo", AUDIT_Q.to); set("audOrder", AUDIT_Q.order); set("audSize", String(AUDIT_Q.pageSize));
  document.querySelectorAll("#auditPageBody .lg-pre").forEach((b) => b.classList.toggle("on", b.dataset.k === (AUDIT_Q.preset || "")));
  document.querySelectorAll("#auditPageBody .lg-chip").forEach((b) => b.classList.toggle("on", !!AUDIT_Q.q && b.dataset.q === AUDIT_Q.q.toLowerCase()));
}
function auditApply(customDates) {
  AUDIT_Q.q = document.getElementById("audQ").value.trim();
  AUDIT_Q.from = document.getElementById("audFrom").value; AUDIT_Q.to = document.getElementById("audTo").value;
  AUDIT_Q.order = document.getElementById("audOrder").value; AUDIT_Q.pageSize = parseInt(document.getElementById("audSize").value, 10) || 25;
  if (customDates) AUDIT_Q.preset = "";
  AUDIT_Q.page = 1; auditLoad();
}
function auditPreset(k) {
  const now = new Date(), day = 86400000;
  AUDIT_Q.preset = k; AUDIT_Q.to = ""; AUDIT_Q.from = "";
  if (k === "today") AUDIT_Q.from = auditYMD(now);
  else if (k) AUDIT_Q.from = auditYMD(new Date(now.getTime() - (parseInt(k, 10) - 1) * day));
  AUDIT_Q.page = 1; auditLoad();
}
function auditChip(k) { const e = document.getElementById("audQ"); e.value = AUDIT_Q.q.toLowerCase() === k ? "" : k; auditApply(); }
function auditLevel(l) { AUDIT_Q.level = AUDIT_Q.level === l ? "" : l; AUDIT_Q.page = 1; auditLoad(); }
function auditReset() { AUDIT_Q = { ...AUDIT_DEF }; auditLoad(); }
function auditPage(n) { AUDIT_Q.page = n; auditLoad(); }
function auditToggleLive() {
  const btn = document.getElementById("audLive");
  if (AUDIT_TIMER) { clearInterval(AUDIT_TIMER); AUDIT_TIMER = null; btn?.classList.remove("lg-live-on"); return; }
  btn?.classList.add("lg-live-on");
  AUDIT_TIMER = setInterval(() => {
    const el = document.getElementById("auditTable");
    if (!el || !el.offsetParent) { clearInterval(AUDIT_TIMER); AUDIT_TIMER = null; document.getElementById("audLive")?.classList.remove("lg-live-on"); return; }
    auditLoad(true);
  }, 10000);
}
function auditSplitTs(ts) { const m = /^(.*?\d{4}),\s*(.*)$/.exec(ts || ""); return m ? { day: m[1], time: m[2] } : { day: "", time: ts || "" }; }
function auditMark(msg, q) {
  const safe = esc(msg);
  if (!q) return safe;
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}
function auditSpark(hourly) {
  const tot = hourly.map((h) => h.INFO + h.WARN + h.ERROR), max = Math.max(1, ...tot);
  return `<div class="lg-spark" aria-hidden="true">${hourly.map((h, i) => `<i class="${h.ERROR ? "e" : h.WARN ? "w" : ""}" style="height:${Math.max(6, Math.round(tot[i] / max * 100))}%" title="${tot[i]} event${tot[i] === 1 ? "" : "s"}"></i>`).join("")}</div>`;
}
function auditOpen(i) {
  const l = AUDIT_ROWS[i]; if (!l) return;
  const tone = { INFO: "st-info", WARN: "st-warn", ERROR: "st-bad" }[l.type] || "st-info";
  openAppModal({ title: "Log entry", subtitle: l.ts, icon: "fa-terminal", content: `
    <div class="dm-kvs dm-kvs-box">${dmKv("Time", l.ts)}${dmKv("Level", `<span class="st-chip ${tone}"><i></i>${esc(l.type)}</span>`, true)}</div>
    <pre class="lg-pre-msg">${esc(l.msg)}</pre>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Close</button><button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="auditCopy(${i})"><i class="fa-solid fa-copy"></i>Copy entry</button></div>` });
}
function auditCopy(i) {
  const l = AUDIT_ROWS[i]; if (!l) return;
  navigator.clipboard?.writeText(`${l.ts} [${l.type}] ${l.msg}`).then(() => showToast("✅ Log entry copied."), () => showToast("⚠️ Could not copy.", "rgba(180,130,0,.85)"));
}
async function auditLoad(silent) {
  const qs = new URLSearchParams({ paged: "1", level: AUDIT_Q.level, q: AUDIT_Q.q, from: AUDIT_Q.from, to: AUDIT_Q.to, page: String(AUDIT_Q.page), pageSize: String(AUDIT_Q.pageSize), order: AUDIT_Q.order });
  const r = await api("/api/audit?" + qs.toString());
  const t = document.getElementById("auditTable"), pg = document.getElementById("auditPager"), st = document.getElementById("audStats"); if (!t) return;
  if (!r.ok) { if (!silent) t.innerHTML = `<div class="dt-empty ml-empty"><i class="fa-solid fa-triangle-exclamation"></i><div>Could not load audit logs.</div></div>`; return; }
  const d = r.data; AUDIT_ROWS = d.rows; auditSync();
  const c = d.counts || { INFO: 0, WARN: 0, ERROR: 0 }, all = c.INFO + c.WARN + c.ERROR;
  if (st) st.innerHTML = [
    { k: "", label: "All events", n: all, icon: "fa-list-ul", cls: "all", sub: `${d.last24h ?? 0} in the last 24h`, extra: auditSpark(d.hourly || []) },
    { k: "INFO", label: "Info", n: c.INFO, icon: "fa-circle-info", cls: "info", sub: "Routine activity" },
    { k: "WARN", label: "Warnings", n: c.WARN, icon: "fa-triangle-exclamation", cls: "warn", sub: "Worth a look" },
    { k: "ERROR", label: "Errors", n: c.ERROR, icon: "fa-circle-xmark", cls: "bad", sub: "Needs attention" },
  ].map((x) => `<button type="button" class="lg-stat lg-${x.cls}${AUDIT_Q.level === x.k ? " on" : ""}" onclick="auditLevel('${x.k}')" aria-pressed="${AUDIT_Q.level === x.k}"><div class="lg-stat-top"><i class="fa-solid ${x.icon}"></i>${x.label}</div><b>${x.n.toLocaleString()}</b><span>${x.sub}</span>${x.extra || ""}</button>`).join("");
  if (!d.rows.length) {
    t.innerHTML = `<div class="dt-empty ml-empty"><i class="fa-solid fa-clipboard-list"></i><div>No log entries match these filters.</div></div>`;
  } else {
    let lastDay = "";
    const lines = d.rows.map((l, i) => {
      const { day, time } = auditSplitTs(l.ts);
      const sep = day !== lastDay ? `<div class="lg-day">${esc(day)}</div>` : "";
      lastDay = day;
      return `${sep}<div class="lg-row lg-${l.type}" tabindex="0" onclick="auditOpen(${i})" onkeydown="if(event.key==='Enter')auditOpen(${i})"><span class="lg-time">${esc(time)}</span><span class="lg-lvl">${esc(l.type)}</span><span class="lg-msg">${auditMark(l.msg, AUDIT_Q.q)}</span><i class="fa-regular fa-copy lg-cp" title="View / copy entry"></i></div>`;
    }).join("");
    t.innerHTML = `<div class="lg-console"><div class="lg-lines">${lines}</div></div>`;
  }
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  if (pg) {
    pg.innerHTML = `<div class="ml-pager">
      <span>Showing ${d.rows.length} of ${d.total.toLocaleString()} entr${d.total === 1 ? "y" : "ies"}</span>
      <div class="ml-pager-nav">
        <button type="button" class="bk-btn bk-btn-out bk-btn-sm" ${d.page <= 1 ? "disabled" : ""} onclick="auditPage(${d.page - 1})"><i class="fa-solid fa-chevron-left"></i>Previous</button>
        <b>${d.page} / ${pages}</b>
        <button type="button" class="bk-btn bk-btn-out bk-btn-sm" ${d.page >= pages ? "disabled" : ""} onclick="auditPage(${d.page + 1})">Next<i class="fa-solid fa-chevron-right"></i></button>
      </div>
    </div>`;
  }
}
async function auditExport() {
  const qs = new URLSearchParams({ paged: "1", export: "1", level: AUDIT_Q.level, q: AUDIT_Q.q, from: AUDIT_Q.from, to: AUDIT_Q.to, order: AUDIT_Q.order });
  const r = await api("/api/audit?" + qs.toString());
  const rows = r.ok ? r.data.rows : AUDIT_ROWS;
  const csv = "Time,Level,Event\n" + rows.map((l) => [l.ts, l.type, l.msg].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "audit-logs.csv"; a.click(); URL.revokeObjectURL(a.href);
  showToast(`✅ Exported ${rows.length} log entr${rows.length === 1 ? "y" : "ies"}.`);
}


/* ===== Booking wizard: shared by "New Request" and "Schedule a Visit" ===== */
let bookStep = "main"; // "main" (service + schedule/details) | "confirm"
const BK_ICONS = { AUTH: "fa-stamp", EXCUSE: "fa-file-pen", ID: "fa-id-card", EVENT: "fa-people-group", PSYCH: "fa-heart-pulse", GENERAL: "fa-comments" };
const BK_AUTH_DOCS = ["Transcript of Records", "Diploma", "Certificate of Registration", "Certificate of Grades", "Other"];
const BK_EXCUSE_REASONS = ["Illness", "Family emergency", "Official school activity", "Other"];
document.addEventListener("input", (e) => { if (e.target.closest && e.target.closest("#bkMain")) setBkErr(""); });
document.addEventListener("change", (e) => { if (e.target.closest && e.target.closest("#bkMain")) setBkErr(""); });
function setBkErr(msg) { const e = document.getElementById("bkErr"); if (!e) return; e.textContent = msg || ""; e.style.display = msg ? "" : "none"; }

function buildCalendar() {
  const container = document.getElementById("calendar");
  if (!container) return;
  const year = appointmentCalendarYear, month = appointmentCalendarMonth;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const first = new Date(year, month, 1).getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const atStart = year === appointmentCalendarStart.getFullYear() && month === appointmentCalendarStart.getMonth();
  const maxMonth = new Date(appointmentCalendarStart.getFullYear(), appointmentCalendarStart.getMonth() + 1, 1);
  const atEnd = year === maxMonth.getFullYear() && month === maxMonth.getMonth();
  let html = `<div class="bk-cal-head"><button type="button" class="bk-cal-nav" onclick="changeAppointmentMonth(-1)" ${atStart ? "disabled" : ""} aria-label="Previous month"><i class="fa-solid fa-chevron-left"></i></button><div class="bk-cal-month">${new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div><button type="button" class="bk-cal-nav" onclick="changeAppointmentMonth(1)" ${atEnd ? "disabled" : ""} aria-label="Next month"><i class="fa-solid fa-chevron-right"></i></button></div>
  <div class="bk-cal-grid">${days.map((d) => `<div class="bk-wd">${d}</div>`).join("")}`;
  for (let i = 0; i < first; i++) html += "<div></div>";
  for (let d = 1; d <= total; d++) {
    const date = new Date(year, month, d), ok = date >= today && date.getDay() !== 0 && date.getDay() !== 6;
    if (!ok) html += `<div class="bk-day off">${d}</div>`;
    else html += `<button type="button" class="bk-day${selectedDate === d ? " sel" : ""}" onclick="selectDate(${d})" aria-pressed="${selectedDate === d}" aria-label="${esc(appointmentDateLabel(d))}">${d}</button>`;
  }
  container.innerHTML = html + "</div>";
}
function changeAppointmentMonth(direction) {
  const candidate = new Date(appointmentCalendarYear, appointmentCalendarMonth + direction, 1);
  const latest = new Date(appointmentCalendarStart.getFullYear(), appointmentCalendarStart.getMonth() + 1, 1);
  if (candidate < appointmentCalendarStart || candidate > latest) return;
  appointmentCalendarMonth = candidate.getMonth();
  appointmentCalendarYear = candidate.getFullYear();
  selectedDate = null;
  selectedSlot = null;
  appointmentAvailability = { bookedTimes: [], myAppointment: null, slots: [] };
  document.getElementById("selectedDateLabel").textContent = "Select a date first.";
  document.getElementById("timeSlots").innerHTML = "";
  setBkErr("");
  buildCalendar();
  bookUpdateNext();
}
function apptServiceLabel(key) { return APPT_SERVICE_LABELS[key] || key; }
function buildServiceChips() {
  const box = document.getElementById("apptServiceChips");
  if (!box) return;
  if (presetAppointmentService) {
    const pre = presetAppointmentService === "ID_NEW" || presetAppointmentService === "ID_LOST" ? "ID" : presetAppointmentService;
    const preDef = APPT_SERVICES.find((s) => s.key === pre);
    if (preDef) { appointmentService = pre; bookingMode = preDef.schedule ? "visit" : "request"; }
    presetAppointmentService = null;
  }
  if (rescheduleCode) bookingMode = "visit";
  if (!bookingServices().some((s) => s.key === appointmentService)) { appointmentService = ""; }
  const isReq = bookingMode === "request";
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set("bookPageTitle", isReq ? "New Request" : "Schedule a Visit");
  set("bookPageSub", isReq ? "File a document or ID request. Staff will review it and schedule your pickup when it is ready." : "Reserve a date and time at the Student Services Office.");
  set("bkLeftTitle", isReq ? "Select Request Type" : "Select Service");
  set("bkSt2", isReq ? "Details" : "Schedule");
  box.innerHTML = bookingServices().map((s) => {
    const on = appointmentService === s.key;
    return `<button type="button" role="radio" aria-checked="${on}" class="bk-row${on ? " sel" : ""}" onclick="setAppointmentService('${s.key}')"><span class="bk-row-ic"><i class="fa-solid ${BK_ICONS[s.key] || "fa-file"}"></i></span><span class="bk-row-lbl">${esc(s.label)}</span><i class="fa-solid fa-chevron-right bk-row-chev"></i></button>`;
  }).join("");
  renderBookingServiceUI();
}
function bookingServiceDef() { return APPT_SERVICES.find((s) => s.key === appointmentService) || null; }
function bookShowStep(step) {
  bookStep = step;
  const main = document.getElementById("bkMain"), conf = document.getElementById("bkConfirm");
  if (main) main.style.display = step === "main" ? "" : "none";
  if (conf) conf.style.display = step === "confirm" ? "" : "none";
  setBkErr("");
  bookUpdateNext();
}
/** Stepper + footer buttons follow the wizard state. */
function bookUpdateNext() {
  const def = bookingServiceDef();
  const cur = bookStep === "confirm" ? 3 : def ? 2 : 1;
  document.querySelectorAll("#bkStepper .bk-st").forEach((li) => {
    const n = +li.dataset.s;
    li.classList.toggle("active", n === cur); li.classList.toggle("done", n < cur);
    if (n === cur) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
  const next = document.getElementById("bkNext"), lbl = document.getElementById("bkNextLbl"), cancel = document.getElementById("bkCancel");
  if (!next) return;
  const isReq = bookingMode === "request";
  if (bookStep === "confirm") {
    lbl.textContent = isReq ? "Submit Request" : "Confirm Booking";
    next.querySelector("i").className = "fa-solid fa-check";
    cancel.textContent = "Back";
    next.disabled = false;
  } else {
    lbl.textContent = "Next";
    next.querySelector("i").className = "fa-solid fa-arrow-right";
    cancel.textContent = "Cancel";
    next.disabled = !def || (!!def.schedule && (!selectedDate || !selectedSlot || !!appointmentAvailability.myAppointment || !!appointmentAvailability.holiday));
  }
}
/**
 * Show only what the selected service needs: date + time for visit services,
 * the details form for request services. Nothing shows until a service is chosen.
 */
function renderBookingServiceUI() {
  const def = bookingServiceDef();
  const wrap = document.getElementById("bookScheduleWrap");
  const formBox = document.getElementById("apptRequestForm");
  const notesBox = document.getElementById("apptNotes");
  const empty = document.getElementById("bkEmpty");
  selectedDate = null; selectedSlot = null;
  appointmentAvailability = { bookedTimes: [], myAppointment: null, slots: [] };
  apptNotesText = "";
  if (notesBox) notesBox.value = "";
  const noteText = document.getElementById("bkNoteText");
  if (noteText) noteText.textContent = "The SSO reviews every booking and will notify you once it is approved.";
  if (formBox) { formBox.style.display = "none"; formBox.innerHTML = ""; }
  if (wrap) wrap.style.display = "none";
  if (empty) empty.style.display = def ? "none" : "";
  if (def && def.schedule) {
    if (wrap) wrap.style.display = "";
    buildCalendar();
    const label = document.getElementById("selectedDateLabel");
    if (label) label.textContent = "Select a date first.";
    document.getElementById("timeSlots").innerHTML = "";
  } else if (def && formBox) {
    formBox.style.display = "";
    formBox.innerHTML = appointmentService === "ID" ? bookIdFormHtml() : bookReqFormHtml(appointmentService);
    ddInitAll(formBox); fileInitAll(formBox);
    if (appointmentService === "ID") toggleBidAffidavit(); else bookToggleOther();
  }
  bookShowStep("main");
}
// ── Request forms on the booking page (same fields and endpoints as before) ──
function bkField(label, inner, opts) {
  const o = opts || {};
  return `<div class="bk-field"${o.id ? ` id="${o.id}"` : ""}${o.hidden ? ' style="display:none;"' : ""}><label class="bk-label"${o.for ? ` for="${o.for}"` : ""}>${label}${o.req ? '<span class="bk-req"> *</span>' : ""}</label>${inner}${o.help ? `<div class="bk-help">${o.help}</div>` : ""}</div>`;
}
function bkSelect(id, options, onchange) {
  return `<div class="bk-input"><select id="${id}" data-dd="1"${onchange ? ` onchange="${onchange}"` : ""}>${options.map((o) => `<option>${esc(o)}</option>`).join("")}</select></div>`;
}
function bookReqFormHtml(svc) {
  const isAuth = svc === "AUTH";
  const opts = isAuth ? BK_AUTH_DOCS : BK_EXCUSE_REASONS;
  return `<h2 class="bk-h">Request Details</h2>
  <div class="bk-form">
    ${bkField(isAuth ? "Document to authenticate" : "Reason for absence", bkSelect("breqType", opts, "bookToggleOther()"), { req: true })}
    ${bkField(isAuth ? "Specify the document" : "Specify the reason", `<div class="bk-input"><input id="breqSubject" type="text" maxlength="150" placeholder="${isAuth ? "e.g. Certificate of Good Moral" : "e.g. Medical appointment"}"></div>`, { id: "breqOtherField", hidden: true, req: true })}
    ${bkField("Reason / Details", '<textarea id="breqDetails" class="bk-ta" rows="3" placeholder="Provide the details of your request…"></textarea>', { for: "breqDetails", req: true })}
    ${bkField("Copies needed", '<div class="bk-input bk-input-sm"><input id="breqCopies" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" onkeydown="return intOnlyKey(event)" oninput="intOnlyClean(this,1,10)" onpaste="setTimeout(()=>intOnlyClean(this,1,10),0)" value="1"></div>', { help: "Whole number, 1 to 10." })}
  </div>`;
}
function bookToggleOther() {
  const t = document.getElementById("breqType"), f = document.getElementById("breqOtherField");
  if (t && f) f.style.display = t.value === "Other" ? "" : "none";
}
function bookIdFormHtml() {
  return `<h2 class="bk-h">Application Details</h2>
  <div class="bk-form">
    ${bkField("Application type", bkSelect("bidType", ["New ID", "ID Replacement — Lost", "ID Replacement — Damaged"], "toggleBidAffidavit()"), { req: true })}
    ${bkField("Reason / Details", '<textarea id="bidReason" class="bk-ta" rows="3" placeholder="e.g., Lost my ID on campus last week…"></textarea>', { for: "bidReason", req: true })}
    ${bkField("Affidavit of Loss", '<input id="bidAffidavit" type="file" data-fu="1" accept=".jpg,.jpeg,.png,.pdf">', { id: "bidAffidavitField", hidden: true, req: true, help: "Required for a lost ID. JPG, PNG or PDF, max 1.5 MB." })}
  </div>`;
}
function toggleBidAffidavit() {
  const typeEl = document.getElementById("bidType");
  if (!typeEl) return;
  const aff = document.getElementById("bidAffidavitField");
  if (aff) aff.style.display = typeEl.value === "ID Replacement — Lost" ? "" : "none";
}
/** Values of the AUTH / EXCUSE form (null when invalid; validation messages are inline). */
function bookReqValues(svc) {
  const type = document.getElementById("breqType")?.value || "";
  const other = (document.getElementById("breqSubject")?.value || "").trim();
  const details = (document.getElementById("breqDetails")?.value || "").trim();
  const subject = type === "Other" ? other : type;
  const copies = document.getElementById("breqCopies") ? readIntInput("breqCopies", 1, 10, "Copies") : 1;
  return { service: svc === "AUTH" ? "AUTHENTICATION" : "EXCUSE_SLIP", type, subject, details, copies };
}
function bookValidateRequest() {
  if (appointmentService === "ID") {
    if (!(document.getElementById("bidReason")?.value || "").trim()) return "Please provide the reason or details.";
    if (document.getElementById("bidType").value === "ID Replacement — Lost" && !document.getElementById("bidAffidavit").files.length) return "An Affidavit of Loss is required for a lost ID.";
    return "";
  }
  const v = bookReqValues(appointmentService);
  if (v.type === "Other" && !v.subject) return appointmentService === "AUTH" ? "Please specify the document." : "Please specify the reason.";
  if (!v.details) return "Please provide the reason or details.";
  if (v.copies === null) return "Copies must be a whole number from 1 to 10.";
  return "";
}
async function bookReqSubmit(svc) {
  const { service, subject, details, copies } = bookReqValues(svc);
  if (copies === null) return;
  const { ok, error } = await api("/api/modules/requests", { method: "POST", body: { service, subject, details, copies } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Request submitted — the SSO will notify you.");
  goTo("page-appointment");
}
async function bookIdSubmit() {
  const type = document.getElementById("bidType").value;
  const reason = document.getElementById("bidReason").value.trim();
  if (!reason) { showToast("⚠️ Please provide the reason/details.", "rgba(180,130,0,.85)"); return; }
  const affidavitInput = document.getElementById("bidAffidavit");
  let affidavit = { fileName: "", url: "" };
  if (type === "ID Replacement — Lost") {
    if (!affidavitInput.files.length) { showToast("⚠️ An Affidavit of Loss is required for a lost ID.", "rgba(180,130,0,.85)"); return; }
    affidavit = await uploadFile(affidavitInput);
    if (affidavit === false || !affidavit.url) return;
  }
  const { ok, error } = await api("/api/modules/idapps", { method: "POST", body: { type, reason, affidavitName: affidavit.fileName, affidavitUrl: affidavit.url } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Application submitted.");
  goTo("page-idapp");
}
/** Deep link from anywhere: every service funnels through the booking page,
 * which renders date + time or the request form depending on the service. */
function bookFor(service) {
  presetAppointmentService = service;
  goTo("page-appointment-book");
}
const APPT_CLOSED_RE = /^(rejected|cancelled|disapproved|closed|resolved|completed|claimed|no.?show)$/i;
function apptBookBtn(service, status) {
  if (!service || APPT_CLOSED_RE.test(status || "")) return "";
  return `<button onclick="bookFor('${service}')" class="btn-gold" style="padding:6px 12px;font-size:11px;border-radius:10px;"><i class="fa-solid fa-calendar-plus" style="margin-right:5px;"></i>Book</button>`;
}
function setAppointmentService(svc) {
  appointmentService = svc;
  apptNotesText = "";
  buildServiceChips();
}
async function selectDate(d) {
  selectedDate = d; selectedSlot = null;
  const label = document.getElementById("selectedDateLabel");
  const dateText = appointmentDateLabel(d);
  label.textContent = `${dateText} — loading availability…`;
  buildCalendar();
  document.getElementById("timeSlots").innerHTML = "";
  setBkErr("");
  bookUpdateNext();
  const { ok, data } = await api(`/api/queue?date=${encodeURIComponent(dateText)}&service=${encodeURIComponent(appointmentService)}`);
  if (selectedDate !== d) return; // user moved on while loading
  appointmentAvailability = ok ? data : { bookedTimes: [], myAppointment: null, slots: [] };
  const mine = appointmentAvailability.myAppointment;
  label.textContent = appointmentAvailability.holiday
    ? `SSO closed — ${appointmentAvailability.holiday.name || appointmentAvailability.holiday.date}.`
    : mine
      ? mine.status === "PENDING_APPROVAL"
        ? `Awaiting SSO approval — ${mine.code} at ${mine.time} on this date.`
        : `You already booked ${mine.code} at ${mine.time} on this date.`
      : `${dateText} — pick a time.`;
  buildSlots();
  bookUpdateNext();
}
function buildSlots() {
  const fallbackTimes = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];
  const slots = (appointmentAvailability.slots && appointmentAvailability.slots.length)
    ? appointmentAvailability.slots
    : fallbackTimes.map((t) => ({ time: t, remaining: (appointmentAvailability.bookedTimes || []).includes(t) ? 0 : 1, blocked: false }));
  const lock = !!appointmentAvailability.myAppointment || !!appointmentAvailability.holiday;
  document.getElementById("timeSlots").innerHTML = slots.map((s) => {
    const full = s.remaining <= 0 || s.blocked, isSel = selectedSlot === s.time;
    const tip = s.blocked ? (s.blockedReason || "Closed") : s.remaining <= 0 ? "Full" : s.remaining > 1 ? `${s.remaining} slots left` : "1 slot left";
    const off = full || lock;
    return `<button type="button" class="bk-slot${isSel ? " sel" : ""}" ${off ? "disabled" : ""} ${off ? "" : `onclick="selectSlot('${s.time}')"`} title="${esc(tip)}" aria-pressed="${isSel}">${esc(s.time)}</button>`;
  }).join("");
}
function selectSlot(t) {
  selectedSlot = t; buildSlots(); setBkErr(""); bookUpdateNext();
}
function bkRow(icon, label, value) {
  return `<div class="bk-rv"><span class="bk-rv-ic"><i class="fa-solid ${icon}"></i></span><div><div class="bk-rv-l">${esc(label)}</div><div class="bk-rv-v">${esc(value)}</div></div></div>`;
}
function bookShowConfirm() {
  const def = bookingServiceDef(); if (!def) return;
  const rows = [bkRow(BK_ICONS[def.key] || "fa-file", bookingMode === "request" ? "Request" : "Service", def.label)];
  const notesCol = document.getElementById("bkNotesCol"), conf = document.getElementById("bkConfirm");
  if (def.schedule) {
    rows.push(bkRow("fa-calendar-days", "Date", appointmentDateLabel(selectedDate)), bkRow("fa-clock", "Time", selectedSlot));
    if (notesCol) notesCol.style.display = "";
    if (conf) conf.classList.remove("single");
  } else {
    if (appointmentService === "ID") {
      const f = document.getElementById("bidAffidavit");
      rows.push(bkRow("fa-id-badge", "Application type", document.getElementById("bidType").value), bkRow("fa-align-left", "Reason", document.getElementById("bidReason").value.trim()));
      if (f && f.files.length && document.getElementById("bidType").value === "ID Replacement — Lost") rows.push(bkRow("fa-paperclip", "Affidavit of Loss", f.files[0].name));
    } else {
      const v = bookReqValues(appointmentService);
      rows.push(bkRow(appointmentService === "AUTH" ? "fa-file-lines" : "fa-circle-question", appointmentService === "AUTH" ? "Document" : "Reason for absence", v.subject), bkRow("fa-align-left", "Details", v.details), bkRow("fa-copy", "Copies", String(v.copies)));
    }
    if (notesCol) notesCol.style.display = "none";
    if (conf) conf.classList.add("single");
  }
  document.getElementById("bkReview").innerHTML = rows.join("");
  bookShowStep("confirm");
}
function bookNext() {
  if (bookStep === "confirm") return bookSubmit();
  const def = bookingServiceDef();
  if (!def) { setBkErr("Choose a service to continue."); return; }
  if (def.schedule) {
    if (!selectedDate || !selectedSlot) { setBkErr("Pick a date and a time to continue."); return; }
  } else {
    const err = bookValidateRequest();
    if (err) { setBkErr(err); return; }
  }
  setBkErr("");
  bookShowConfirm();
  window.scrollTo({ top: 0 });
}
function bookCancel() {
  if (bookStep === "confirm") { bookShowStep("main"); return; }
  goTo(session && session.role !== "student" ? "page-admin" : "page-student");
}
async function bookSubmit() {
  const btn = document.getElementById("bkNext");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const def = bookingServiceDef();
    if (!def) return;
    if (def.schedule) await bookAppointment();
    else if (appointmentService === "ID") await bookIdSubmit();
    else await bookReqSubmit(appointmentService);
  } finally { if (bookStep === "confirm") btn.disabled = false; }
}
async function bookAppointment() {
  if (!selectedDate || !selectedSlot) return;
  if (APPT_REQUEST_ONLY[appointmentService]) { showToast("⚠️ This service is filed as a request — it can't be booked here.", "rgba(180,130,0,.85)"); renderBookingServiceUI(); return; }
  const dateLabel = appointmentDateLabel(selectedDate);
  const notes = (document.getElementById("apptNotes")?.value || "").trim();
  const { ok, data, error } = await api("/api/queue", { method: "POST", body: { service: appointmentService, dateLabel, time: selectedSlot, notes } });
  if (!ok) { showToast(`❌ ${error || "Could not book that slot."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`✅ Booking request sent! ${data.q} · ${apptServiceLabel(data.service)} on ${dateLabel} at ${selectedSlot} — awaiting SSO approval.`);
  selectedDate = null; selectedSlot = null;
  setTimeout(() => goTo("page-appointment"), 1200);
}

function buildRescheduleCalendar() {
  const container = document.getElementById("rescheduleCalendar");
  if (!container) return;
  const year = rescheduleCalYear, month = rescheduleCalMonth;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const first = new Date(year, month, 1).getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let html = `<div class="bk-cal-head"><span style="width:30px;"></span><div class="bk-cal-month">${new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div><span style="width:30px;"></span></div>
  <div class="bk-cal-grid">${days.map((d) => `<div class="bk-wd">${d}</div>`).join("")}`;
  for (let i = 0; i < first; i++) html += "<div></div>";
  for (let d = 1; d <= total; d++) {
    const date = new Date(year, month, d), ok = date >= today && date.getDay() !== 0 && date.getDay() !== 6;
    if (!ok) html += `<div class="bk-day off">${d}</div>`;
    else html += `<button type="button" class="bk-day${rescheduleSelectedDate === d ? " sel" : ""}" onclick="selectRescheduleDate(${d})" aria-pressed="${rescheduleSelectedDate === d}" aria-label="${esc(rescheduleDateLabel(d))}">${d}</button>`;
  }
  container.innerHTML = html + "</div>";
}
async function selectRescheduleDate(d) {
  rescheduleSelectedDate = d; rescheduleSelectedSlot = null;
  const label = document.getElementById("rescheduleDateLabel");
  buildRescheduleCalendar();
  if (label) label.textContent = `${rescheduleDateLabel(d)} — loading availability…`;
  const { ok, data } = await api(`/api/queue?date=${encodeURIComponent(rescheduleDateLabel(d))}&service=${encodeURIComponent(rescheduleService || "GENERAL")}`);
  rescheduleAvailability = ok ? data : { bookedTimes: [], myAppointment: null, slots: [] };
  if (label) label.textContent = `${rescheduleDateLabel(d)} — pick a time.`;
  buildRescheduleSlots();
}
function buildRescheduleSlots() {
  const container = document.getElementById("rescheduleTimeSlots");
  if (!container) return;
  const fallbackTimes = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];
  const slots = (rescheduleAvailability.slots && rescheduleAvailability.slots.length)
    ? rescheduleAvailability.slots
    : fallbackTimes.map((t) => ({ time: t, remaining: ((rescheduleAvailability.bookedTimes || []).includes(t) ? 0 : 1), blocked: false }));
  const isOwnDate = rescheduleAvailability.myAppointment?.code === rescheduleCode;
  container.innerHTML = slots.map((s) => {
    const isOwnSlot = isOwnDate && rescheduleAvailability.myAppointment?.time === s.time;
    const isTaken = (s.remaining <= 0 || s.blocked) && !isOwnSlot;
    const isSel = rescheduleSelectedSlot === s.time;
    const tip = isOwnSlot ? "Your current time" : s.blocked ? (s.blockedReason || "Closed") : s.remaining <= 0 ? "Full" : s.remaining > 1 ? `${s.remaining} slots left` : "1 slot left";
    return `<button type="button" class="bk-slot${isSel ? " sel" : ""}" ${isTaken ? "disabled" : `onclick="selectRescheduleSlot('${s.time}')"`} title="${esc(tip)}" aria-pressed="${isSel}">${esc(s.time)}</button>`;
  }).join("");
}
function selectRescheduleSlot(t) {
  rescheduleSelectedSlot = t;
  buildRescheduleSlots();
}


function togglePass(id, btn) { const el = document.getElementById(id); el.type = el.type === "password" ? "text" : "password"; btn.querySelector("i").className = el.type === "password" ? "fa-solid fa-eye" : "fa-solid fa-eye-slash"; }
function validateStudNum(el) { const valid = /^\d{4}-\d{5}-SP-\d$/.test(el.value); const h = document.getElementById("studNumHelper"); if (el.value.length > 3) { el.style.borderColor = valid ? "rgba(34,197,94,.5)" : "rgba(239,68,68,.5)"; h.innerHTML = valid ? '<i class="fa-solid fa-circle-check" style="color:#4ade80;margin-right:3px;"></i><span style="color:#4ade80;">Valid format</span>' : '<i class="fa-solid fa-triangle-exclamation" style="color:#f87171;margin-right:3px;"></i><span style="color:#f87171;">Format: 2024-00000-SP-0</span>'; } }
function checkStrength(val) {
  const v = String(val || "");
  const bars = [1, 2, 3, 4].map((i) => document.getElementById("s" + i));
  const label = document.getElementById("strengthLabel");
  const hasLen = v.length >= 9;
  const hasUp = /[A-Z]/.test(v);
  const hasLow = /[a-z]/.test(v);
  const hasNum = /[0-9]/.test(v);
  const hasSpec = /[^A-Za-z0-9]/.test(v);
  const setChk = (id, ok, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.color = ok ? "#15803d" : "rgba(30,5,5,.6)";
    el.style.fontWeight = ok ? "700" : "400";
    el.innerHTML = `<i class="${ok ? "fa-solid fa-circle-check" : "fa-regular fa-circle"}" style="margin-right:4px;"></i>${text}`;
  };
  setChk("chkLen", hasLen, "9+ chars");
  setChk("chkUp", hasUp, "A-Z");
  setChk("chkLow", hasLow, "a-z");
  setChk("chkNum", hasNum, "0-9");
  setChk("chkSpec", hasSpec, "Symbol");
  let score = 0;
  if (hasLen) score++;
  if (hasUp && hasLow) score++;
  if (hasNum) score++;
  if (hasSpec) score++;
  const colors = ["rgba(239,68,68,.8)", "rgba(249,115,22,.8)", "rgba(245,197,24,.8)", "rgba(34,197,94,.8)"];
  const labels = ["Weak", "Fair", "Good", "Strong"];
  bars.forEach((b, i) => { if (b) b.style.background = i < score ? colors[score - 1] : "rgba(139,26,26,.1)"; });
  if (label) {
    label.textContent = v.length ? (score === 4 ? "Strong password ✓" : (labels[score - 1] || "Weak")) : "Password strength";
    label.style.color = v.length ? colors[Math.max(0, score - 1)] : "rgba(30,5,5,.55)";
  }
}
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") {}
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => (c || "").trim() !== ""));
}

function showToast(msg, bg) {
  if (typeof window !== "undefined" && typeof window.__starsToast === "function") {
    window.__starsToast(String(msg ?? ""), bg);
    return;
  }
  const host = document.getElementById("toastContainer");
  if (!host) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.style.background = bg || "rgba(122,15,31,.92)";
  t.style.pointerEvents = "auto";
  t.textContent = String(msg ?? "").replace(/<[^>]+>/g, " ").trim();
  host.appendChild(t);
  setTimeout(() => {
    t.style.transition = ".25s ease";
    t.style.opacity = "0";
    t.style.transform = "translateY(-8px)";
    setTimeout(() => t.remove(), 260);
  }, 3200);
}


const APP_VERSION = "3.2.1-nextjs";

function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const APP_TIMEZONE = "Asia/Manila";
function fnow(d) {
  const dt = d ? new Date(d) : new Date();
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleString("en-PH", { timeZone: APP_TIMEZONE, dateStyle: "medium", timeStyle: "short" });
}
function todayManilaLabel() {
  return new Date().toLocaleDateString("en-US", { timeZone: APP_TIMEZONE, month: "long", day: "numeric", year: "numeric" });
}
function isAdmin() { return session && (session.role === "admin" || session.role === "super_admin"); }
function isSuperAdmin() { return session && session.role === "super_admin"; }
function pill(status) { return stChip(status); }
function fileLink(name, data, label) {
  if (!data) return '<span style="color:rgba(30,5,5,.4);font-size:11px;">No file</span>';
  return `<a href="${data}" download="${esc(name)}" style="font-size:11px;font-weight:700;color:#8B1A1A;"><i class="fa-solid fa-paperclip" style="margin-right:4px;"></i>${esc(label || name)}</a>`;
}

// ── Dedicated request workflows: visual stepper + one-click step actions ──
// Replaces the generic status <select> dropdowns. Each module declares its
// forward steps; revision returns, rejections and completions are branches
// rendered as banners. Admins advance one step at a time (or send back /
// close with one click); students see the same stepper read-only on cards.
function wfStepsFor(kind, item) {
  if (kind === "request") {
    const pickup = typeof reqIsPickup === "function" ? reqIsPickup((item || {}).service) : true;
    return pickup
      ? ["Pending Review", "Approved", "Ready for Pickup", "Pickup Scheduled", "Completed"]
      : ["Pending Review", "Approved", "Completed"];
  }
  if (kind === "idapp") return ["Pending", "OR Verified", "Approved", "Processing", "Ready for Claiming", "Claimed"];
  if (kind === "referral") return ["Pending", "Under Review", "Approved", "Confirmed", "Checked In", "In Progress", "Completed"];
  if (kind === "complaint") return ["Submitted", "Under Investigation", "Resolved"];
  return [];
}
function wfMeta(kind) {
  if (kind === "request") return { revise: "Needs Revision", bad: ["Rejected", "Cancelled"], done: ["Completed"], label: "request" };
  if (kind === "idapp") return { revise: "Needs Revision", bad: ["Rejected", "Cancelled"], done: ["Claimed", "Completed"], label: "application" };
  if (kind === "referral") return { revise: "Needs Revision", bad: ["Rejected", "Cancelled", "No Show"], done: ["Completed"], label: "referral" };
  if (kind === "complaint") return { revise: null, bad: ["Dismissed"], done: ["Resolved"], label: "complaint" };
  return { revise: null, bad: [], done: [], label: "record" };
}
function wfIsTerminal(kind, status) {
  const m = wfMeta(kind);
  return m.bad.includes(status) || m.done.includes(status);
}
/** Next forward step for an item, or null when at the end / on a branch. */
function wfNext(kind, item) {
  const steps = wfStepsFor(kind, item);
  const i = steps.indexOf((item || {}).status);
  if (i >= 0 && i < steps.length - 1) return steps[i + 1];
  return null;
}
/** Read-only progress stepper + branch banner. Safe to embed in any card/modal. */
function wfStepperHtml(kind, item) {
  const steps = wfStepsFor(kind, item);
  const m = wfMeta(kind);
  const cur = (item || {}).status || "";
  const idx = steps.indexOf(cur);
  const dots = steps.map((s, i) => {
    const done = idx >= 0 && i < idx;
    const isCur = i === idx;
    const bg = done ? "#15803d" : isCur ? "#8B1A1A" : "rgba(30,5,5,.15)";
    const fg = (done || isCur) ? "#fff" : "rgba(30,5,5,.55)";
    const dot = `<span title="${esc(s)}" style="min-width:20px;height:20px;border-radius:99px;background:${bg};color:${fg};font-size:10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;">${done ? "✓" : (i + 1)}</span>`;
    const lbl = `<span style="font-size:9px;font-weight:${isCur ? "800" : "400"};color:${isCur ? "#1a0505" : "rgba(30,5,5,.55)"};white-space:nowrap;">${esc(s)}</span>`;
    const cell = `<span style="display:inline-flex;flex-direction:column;align-items:center;gap:2px;">${dot}${lbl}</span>`;
    const link = i < steps.length - 1 ? `<span style="flex:1;height:2px;min-width:8px;margin:0 2px 14px;background:${done ? "#15803d" : "rgba(30,5,5,.12)"};border-radius:2px;"></span>` : "";
    return cell + link;
  }).join("");
  let banner = "";
  if (cur === m.revise) {
    banner = `<div style="font-size:11px;color:#c2410c;background:rgba(234,88,12,.1);border:1px solid rgba(234,88,12,.3);border-radius:10px;padding:7px 10px;margin-top:8px;"><i class="fa-solid fa-rotate-left" style="margin-right:5px;"></i>Sent back — waiting for the student to revise and resubmit.</div>`;
  } else if (m.done.includes(cur)) {
    banner = `<div style="font-size:11px;color:#15803d;background:rgba(22,163,74,.1);border:1px solid rgba(22,163,74,.3);border-radius:10px;padding:7px 10px;margin-top:8px;"><i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>Finished — ${esc(cur)}.</div>`;
  } else if (m.bad.includes(cur)) {
    banner = `<div style="font-size:11px;color:#4b5563;background:rgba(107,114,128,.1);border:1px solid rgba(107,114,128,.3);border-radius:10px;padding:7px 10px;margin-top:8px;"><i class="fa-solid fa-ban" style="margin-right:5px;"></i>Closed — ${esc(cur)}. Read-only.</div>`;
  } else if (idx < 0) {
    banner = `<div style="font-size:11px;color:rgba(30,5,5,.6);margin-top:8px;">Current stage: <b>${esc(cur)}</b> (legacy status outside the standard flow).</div>`;
  }
  return `<div style="margin:4px 0 2px;"><div style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:rgba(30,5,5,.5);margin-bottom:6px;">Progress</div><div style="display:flex;align-items:flex-start;overflow-x:auto;padding-bottom:2px;">${dots}</div>${banner}</div>`;
}
/** Admin footer for a workflow modal: one primary step, everything else tucked under "More". */
function wfFooterHtml(kind, id, item, ex) {
  ex = ex || {};
  const m = wfMeta(kind);
  const cur = (item || {}).status || "";
  const safeId = esc(id);
  const more = [];
  let primary = "";
  if (wfIsTerminal(kind, cur)) {
    if (kind === "complaint") primary = maPrimary("Reopen investigation", "fa-rotate-left", `wfAdvance('${kind}','${safeId}','Under Investigation')`);
    return maFooter(primary, []);
  }
  const next = wfNext(kind, item);
  if (ex.primary) {
    primary = maPrimary(ex.primary.label, ex.primary.icon, ex.primary.on);
    if (next && !ex.skipNext) more.push({ label: `Advance to ${next}`, icon: "fa-arrow-right", on: `wfAdvance('${kind}','${safeId}','${esc(next)}')` });
  } else if (next) {
    primary = maPrimary(`Advance to ${next}`, "fa-arrow-right", `wfAdvance('${kind}','${safeId}','${esc(next)}')`);
  }
  if (ex.more) more.unshift(...ex.more);
  if (m.revise && cur !== m.revise) more.push({ label: "Request revision", icon: "fa-rotate-left", on: `wfAdvance('${kind}','${safeId}','${esc(m.revise)}')` });
  const bad = m.bad.filter((t) => t !== cur);
  if (bad.length && more.length) more.push("-");
  bad.forEach((t) => more.push({ label: t === "No Show" ? "Mark no-show" : t === "Dismissed" ? "Dismiss complaint" : t === "Rejected" ? `Reject ${m.label}` : t === "Cancelled" ? `Cancel ${m.label}` : t, icon: t === "No Show" ? "fa-user-clock" : "fa-ban", danger: true, on: `wfAsk('${kind}','${safeId}','${esc(t)}')` }));
  return maFooter(primary, more);
}
/** Inline confirmation for closing transitions (replaces confirm()). */
function wfAsk(kind, id, target) {
  const m = wfMeta(kind);
  const title = target === "No Show" ? "Mark as no-show?" : target === "Dismissed" ? "Dismiss this complaint?" : target === "Rejected" ? `Reject this ${m.label}?` : target === "Cancelled" ? `Cancel this ${m.label}?` : `Set to "${target}"?`;
  maAsk({ title, text: kind === "complaint" ? "The complainant will be notified." : "The student will be notified. Any remark you typed above is sent along with it.", confirm: target === "No Show" ? "Mark no-show" : target === "Dismissed" ? "Dismiss" : target === "Rejected" ? "Reject" : "Cancel it", on: `wfAdvance('${kind}','${esc(id)}','${esc(target)}',true)` });
}
/** Dispatcher behind every workflow button (confirms destructive closes). */
async function wfAdvance(kind, id, target, skipConfirm) {
  const m = wfMeta(kind);
  if (!skipConfirm && m.bad.includes(target) && !confirm(`Set this ${m.label} to "${target}"? The student will be notified.`)) return;
  if (kind === "referral") return refUpdate(id, target);
  if (kind === "idapp") return idUpdate(id, target);
  if (kind === "request") return reqUpdate(id, target);
  if (kind === "complaint") return cmpUpdate(id, target);
}

// Categorized student sidebar navigation — same categories + items pattern as
// ADMIN_NAV_SECTIONS (desktop sidebar groups + mobile menu sections).
// Request flows (auth / excuse / visits / ID / event / referral) live inside
// the Book Appointment page, so they are not listed here separately.
// Complaints has no booking lane and stays under Support.
const STUDENT_NAV_SECTIONS = [
  { title: "Requests", items: [
    { label: "New Request", icon: "fa-file-circle-plus", page: "page-appointment-book", mode: "request", action: "openNewRequest" },
    { label: "My Requests", icon: "fa-file-lines", page: "page-myrequests" },
  ]},
  { title: "Appointments", items: [
    { label: "Schedule a Visit", icon: "fa-calendar-plus", page: "page-appointment-book", mode: "visit", action: "openScheduleVisit" },
    { label: "My Appointments", icon: "fa-calendar-check", page: "page-appointment" },
  ]},
  { title: "Support", items: [
    { label: "Help Desk", icon: "fa-headset", page: "page-helpdesk" },
    { label: "Complaints", icon: "fa-shield-heart", page: "page-complaint", alt: "page-complaint-new" },
  ]},
  { title: "Resources", items: [
    { label: "Student Bulletin", icon: "fa-bullhorn", page: "page-bulletin" },
    { label: "FAQs", icon: "fa-circle-question", page: "page-faq" },
    { label: "Forms", icon: "fa-file-arrow-down", page: "page-forms" },
  ]},
];
// Categorized admin sidebar navigation — single source of truth for the
// desktop sidebar, the mobile menu, and the page-manage directory.
const ADMIN_NAV_SECTIONS = [
  { title: "Requests", items: [
    { label: "All Requests", icon: "fa-file-lines", page: "page-requests" },
    { label: "Referrals", icon: "fa-hand-holding-heart", page: "page-referral" },
  ]},
  { title: "Appointments", items: [
    { label: "All Appointments", icon: "fa-calendar-check", page: "page-appointments" },
  ]},
  { title: "Support", items: [
    { label: "Help Desk", icon: "fa-headset", page: "page-helpdesk" },
    { label: "Complaints", icon: "fa-shield-heart", page: "page-complaint" },
  ]},
  { title: "Resources", items: [
    { label: "Student Bulletin", icon: "fa-bullhorn", page: "page-bulletin" },
    { label: "FAQs", icon: "fa-circle-question", page: "page-faq" },
    { label: "Forms", icon: "fa-file-arrow-down", page: "page-forms" },
  ]},
  { title: "Insights", items: [
    { label: "Analytics", icon: "fa-chart-column", page: "page-system", superOnly: true },
    { label: "Audit Logs", icon: "fa-clipboard-list", page: "page-audit", superOnly: true },
  ]},
  { title: "Administration", items: [
    { label: "Accounts", icon: "fa-users-gear", page: "page-accounts", superOnly: true },
    { label: "Masterlist", icon: "fa-users-rectangle", page: "page-masterlist", superOnly: true },
    { label: "Email Blast", icon: "fa-envelopes-bulk", page: "page-memo", superOnly: true },
    { label: "System Settings", icon: "fa-sliders", page: "page-settings", superOnly: true },
  ]},
];
function adminNavSections() {
  return ADMIN_NAV_SECTIONS
    .map((s) => ({ title: s.title, items: s.items.filter((it) => !it.superOnly || isSuperAdmin()) }))
    .filter((s) => s.items.length);
}
function navItemAction(it) { return it.action ? `${it.action}()` : `goTo('${it.page}')`; }
function navGroupsHtml(sections, pageId, forMobile) {
  return sections.map((s) => {
    const buttons = s.items.map((it) => {
      const active = it.page && (it.page === pageId || it.alt === pageId) && (!it.mode || it.mode === bookingMode) ? " active" : "";
      const close = forMobile ? ";closeMobileMenu()" : "";
      const cls = forMobile ? "nav-link" : "nav-link sub";
      const style = forMobile ? ' style="justify-content:flex-start;"' : "";
      const iconStyle = forMobile ? ' style="font-size:11px;color:#F5C518;"' : "";
      return `<button onclick="${navItemAction(it)}${close}" class="${cls}${active}"${style}><i class="fa-solid ${it.icon}"${iconStyle}></i><span>${esc(it.label)}</span></button>`;
    }).join("");
    if (forMobile) return `<div class="mobile-section-label">${esc(s.title)}</div>${buttons}`;
    return `<div class="sidebar-group"><div class="sidebar-section-label"><span>${esc(s.title)}</span></div><div class="sidebar-subitems">${buttons}</div></div>`;
  }).join("");
}
function adminNavGroupsHtml(pageId, forMobile) {
  return navGroupsHtml(adminNavSections(), pageId, forMobile);
}
function studentNavSections() {
  return STUDENT_NAV_SECTIONS;
}
function studentNavGroupsHtml(pageId, forMobile) {
  return navGroupsHtml(studentNavSections(), pageId, forMobile);
}
function renderManageHub() {
  const box = document.getElementById("manageGrid");
  if (!box) return;
  box.innerHTML = adminNavSections().map((s) => `
    <section style="margin-bottom:20px;">
      <div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:rgba(139,26,26,.6);margin:0 0 8px;">${esc(s.title)}</div>
      <div class="glass-card" style="padding:6px 8px;">
        ${s.items.map((it) => `<button onclick="${navItemAction(it)}" class="quick-link" style="width:100%;"><i class="fa-solid ${it.icon}" style="color:#C8890F;width:16px;text-align:center;"></i>${esc(it.label)}<i class="fa-solid fa-chevron-right" style="margin-left:auto;opacity:.3;font-size:11px;"></i></button>`).join("")}
      </div>
    </section>`).join("");
}

// ── Tooltip primitive: any element with a title gets a styled tooltip (300ms hover / keyboard focus, Esc closes) ──
(function initTooltips() {
  if (window.__stTipInit) return; window.__stTipInit = true;
  let tip, timer, cur;
  const ensure = () => { if (!tip) { tip = document.createElement("div"); tip.id = "stTooltip"; tip.setAttribute("role", "tooltip"); document.body.appendChild(tip); } return tip; };
  const hide = () => { clearTimeout(timer); if (tip) tip.classList.remove("show"); cur = null; };
  const show = (el) => {
    const text = el.getAttribute("data-tip"); if (!text) return;
    const t = ensure(); t.textContent = text; t.classList.add("show");
    const r = el.getBoundingClientRect(), tr = t.getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, r.left + r.width / 2 - tr.width / 2)) + "px";
    t.style.top = (r.bottom + 8 + tr.height > window.innerHeight ? r.top - tr.height - 8 : r.bottom + 8) + "px";
  };
  const adopt = (el) => {
    const title = el.getAttribute("title");
    if (title) {
      el.setAttribute("data-tip", title); el.removeAttribute("title");
      if (!el.getAttribute("aria-label") && !(el.textContent || "").trim()) el.setAttribute("aria-label", title);
    }
  };
  const enter = (e) => {
    const el = e.target.closest ? e.target.closest("[title],[data-tip]") : null;
    if (!el || el === cur) return;
    adopt(el); cur = el; clearTimeout(timer);
    timer = setTimeout(() => show(el), e.type === "focusin" ? 0 : 300);
  };
  document.addEventListener("mouseover", enter);
  document.addEventListener("focusin", enter);
  document.addEventListener("mouseout", hide);
  document.addEventListener("focusout", hide);
  document.addEventListener("click", hide);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
})();

// ── Strict whole-number inputs (no negatives, decimals, exponents or letters) ──
function intOnlyKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (e.key.length > 1) return true; // Backspace, arrows, Tab, etc.
  return /^[0-9]$/.test(e.key);
}
function intOnlyClean(el, min, max) {
  let v = String(el.value || "").replace(/\D+/g, "");
  if (v !== "" && Number(v) > max) v = String(max);
  el.value = v;
}
function readIntInput(id, min, max, label) {
  const raw = String(document.getElementById(id)?.value ?? "").trim();
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    showToast(`\u26a0\ufe0f ${label} must be a whole number from ${min} to ${max}.`, "rgba(139,26,26,.9)");
    return null;
  }
  return Number(raw);
}

function downloadBackup() {
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Backup is restricted to Super Admin.", "rgba(139,26,26,.9)"); return; }
  if (!confirm("Download a database backup file? Keep it in a secure location.")) return;
  window.open("/api/backup", "_blank");
}

function closeAppModal() { document.getElementById("appModal")?.remove(); document.getElementById("stTooltip")?.classList.remove("show"); }
function openAppModal({ title, subtitle = "", icon = "fa-circle-info", content = "", wide = false }) {
  closeAppModal();
  const modal = document.createElement("div");
  modal.id = "appModal"; modal.className = "modal-overlay open app-modal";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  modal.innerHTML = `<div class="modal-box" style="max-width:${wide ? "880px" : "680px"};"><div class="app-modal-head"><div><div class="app-modal-title"><i class="fa-solid ${icon}"></i><span>${esc(title)}</span></div>${subtitle ? `<p class="app-modal-subtitle">${esc(subtitle)}</p>` : ""}</div><button class="app-modal-close" onclick="closeAppModal()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="app-modal-body">${content}</div></div>`;
  modal.addEventListener("click", (event) => { if (event.target === modal) closeAppModal(); });
  document.body.appendChild(modal);
  ddInitAll(modal); fileInitAll(modal);
  if (title === "Organizations & Representatives" && isSuperAdmin()) {
    const assignments = [...(window.__qrsOrganizationRepresentatives || [])];
    modal.querySelectorAll("button").forEach((button) => {
      if (!/^(Revoke|Reactivate)$/.test(button.textContent.trim())) return;
      const rep = assignments.shift(); if (!rep) return;
      const label = button.previousElementSibling;
      if (label?.tagName === "SPAN" && rep.studentName) {
        const bold = label.querySelector("b");
        if (bold) {
          bold.textContent = rep.studentName;
          const studentId = document.createElement("span");
          studentId.textContent = ` · ${rep.studentId}`;
          studentId.style.cssText = "color:rgba(30,5,5,.58);font-weight:400;";
          bold.insertAdjacentElement("afterend", studentId);
        }
      }
      const remove = document.createElement("button");
      remove.className = "btn-soft"; remove.textContent = "Remove";
      remove.style.cssText = "padding:3px 8px;font-size:10px;color:#a11;margin-left:5px;";
      remove.onclick = () => confirmRemoveOrganizationRep(rep.id, rep.studentId);
      button.insertAdjacentElement("afterend", remove);
    });
  }
  return modal;
}
function modalField(label, id, value = "", extra = "") { return `<div class="app-field ${extra}"><label for="${id}">${esc(label)}</label><input id="${id}" class="glass-input" value="${esc(value)}"></div>`; }
function schoolYearField(id, value = "", extra = "") { return `<div class="app-field ${extra}"><label for="${id}">School year</label><input id="${id}" class="glass-input" value="${esc(value)}" placeholder="2026-2027" inputmode="numeric" maxlength="9" pattern="\\d{4}-\\d{4}" oninput="formatSchoolYearInput(this)"><div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Use consecutive years, e.g. 2026-2027.</div></div>`; }
function formatSchoolYearInput(input) {
  const digits = input.value.replace(/\D/g, "").slice(0, 8);
  input.value = digits.length > 4 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : digits;
}
function validSchoolYear(value) {
  const match = /^(\d{4})-(\d{4})$/.exec(value || "");
  return !!match && Number(match[1]) >= 2000 && Number(match[2]) === Number(match[1]) + 1;
}

async function legacyCreateOrganization() {
  const name = prompt("Organization name:")?.trim(); if (!name) return;
  const adviserName = prompt("Faculty adviser name:")?.trim(); if (!adviserName) return;
  const schoolYear = prompt("Academic year (optional, e.g. 2026–2027):")?.trim() || "";
  const result = await api("/api/organizations", { method: "POST", body: { name, adviserName, schoolYear } });
  if (!result.ok) return showToast(result.error || "Could not register organization.", "rgba(155,22,22,.85)");
  showToast("Organization registered."); closeAppModal(); reloadAccountsPage();
}
async function legacyAssignOrganizationRep(organizationId, name) {
  const studentId = prompt(`Student number of the verified officer for ${name}:`)?.trim(); if (!studentId) return;
  const expiresAt = prompt("Access expiry date (YYYY-MM-DD; leave blank for no expiry):")?.trim() || "";
  const result = await api("/api/organizations/representatives", { method: "POST", body: { organizationId, studentId, expiresAt } });
  if (!result.ok) return showToast(result.error || "Could not assign representative.", "rgba(155,22,22,.85)");
  showToast("Organization representative assigned."); closeAppModal(); reloadAccountsPage();
}
async function createOrganization() {
  openAppModal({ title: "Register Organization", subtitle: "Create the organization before assigning verified student officers.", icon: "fa-people-group", content: `<div class="app-modal-grid">${modalField("Organization name", "orgName")}${modalField("Faculty adviser", "orgAdviser")}${modalField("Academic year", "orgSchoolYear", "2026-2027")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Back</button><button class="btn-maroon" onclick="saveOrganization()"><i class="fa-solid fa-floppy-disk"></i> Register organization</button></div>` });
}
async function saveOrganization() {
  const name = document.getElementById("orgName")?.value.trim(), adviserName = document.getElementById("orgAdviser")?.value.trim(), schoolYear = document.getElementById("orgSchoolYear")?.value.trim() || "";
  if (!name || !adviserName) return showToast("Organization name and faculty adviser are required.", "rgba(180,130,0,.85)");
  const result = await api("/api/organizations", { method: "POST", body: { name, adviserName, schoolYear } });
  if (!result.ok) return showToast(result.error || "Could not register organization.", "rgba(155,22,22,.85)");
  showToast("Organization registered."); closeAppModal(); reloadAccountsPage();
}
async function assignOrganizationRep(organizationId, name) {
  const studentsResult = await api("/api/users/students");
  if (!studentsResult.ok) return showToast(studentsResult.error || "Could not load students.", "rgba(155,22,22,.85)");
  const options = (studentsResult.data || []).filter((student) => student.active && student.approved).map((student) => `<option value="${esc(student.studentId)}">${esc(student.name)} — ${esc(student.studentId)}${student.course ? ` · ${esc(student.course)}` : ""}</option>`).join("");
  openAppModal({ title: "Assign Organization Representative", subtitle: `Select the verified student officer for ${name}. Their Student account remains unchanged.`, icon: "fa-user-check", content: `<div class="app-modal-grid"><div class="app-field" style="grid-column:1/-1;"><label for="orgRepresentativeStudent">Student officer</label><select id="orgRepresentativeStudent" class="glass-input"><option value="">Select approved student account</option>${options}</select></div><div class="app-field"><label for="orgRepresentativeExpiry">Access expires on (optional)</label><input id="orgRepresentativeExpiry" type="date" class="glass-input"></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Back</button><button class="btn-maroon" onclick="saveOrganizationRepresentative('${organizationId}')"><i class="fa-solid fa-user-plus"></i> Assign representative</button></div>` });
}
async function saveOrganizationRepresentative(organizationId) {
  const studentId = document.getElementById("orgRepresentativeStudent")?.value || "";
  const expiresAt = document.getElementById("orgRepresentativeExpiry")?.value || "";
  if (!studentId) return showToast("Select the student officer to assign.", "rgba(180,130,0,.85)");
  const result = await api("/api/organizations/representatives", { method: "POST", body: { organizationId, studentId, expiresAt } });
  if (!result.ok) return showToast(result.error || "Could not assign representative.", "rgba(155,22,22,.85)");
  showToast("Organization representative assigned."); closeAppModal(); reloadAccountsPage();
}
async function setOrganizationRep(id, active) {
  const result = await api("/api/organizations/representatives", { method: "PATCH", body: { id, active } });
  if (!result.ok) return showToast(result.error || "Could not update representative.", "rgba(155,22,22,.85)");
  showToast(active ? "Representative reactivated." : "Representative access revoked."); reloadAccountsPage();
}
function confirmRemoveOrganizationRep(id, studentId) {
  openAppModal({ title: "Remove Representative", subtitle: "This permanently removes the representative assignment. The student's account and request history are not deleted.", icon: "fa-user-minus", content: `<div class="glass-card" style="padding:14px;margin-bottom:16px;"><div style="font-size:13px;font-weight:800;color:#1a0505;">${esc(studentId)}</div><div style="font-size:11px;color:rgba(30,5,5,.65);margin-top:4px;">They will immediately lose Organization Representative access.</div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="removeOrganizationRep('${id}')"><i class="fa-solid fa-trash"></i> Remove permanently</button></div>` });
}
async function removeOrganizationRep(id) {
  const result = await api(`/api/organizations/representatives?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!result.ok) return showToast(result.error || "Could not remove representative.", "rgba(155,22,22,.85)");
  showToast("Representative assignment removed."); closeAppModal(); reloadAccountsPage();
}
async function setOrganizationActive(id, active) {
  if (!confirm(`${active ? "Activate" : "Deactivate"} this organization?`)) return;
  const result = await api("/api/organizations", { method: "PATCH", body: { id, active } });
  if (!result.ok) return showToast(result.error || "Could not update organization.", "rgba(155,22,22,.85)");
  showToast(active ? "Organization activated." : "Organization deactivated."); reloadAccountsPage();
}

async function saveProfileEdit() {
  const name = document.getElementById("profileName")?.value.trim(), email = document.getElementById("profileEmail")?.value.trim(), course = document.getElementById("profileCourse")?.value.trim(), year = document.getElementById("profileYear")?.value.trim();
  if (!name || !email) return showToast("Name and email are required.", "rgba(180,130,0,.85)");
  const result = await api("/api/profile", { method: "POST", body: { name, email, course, year } });
  showToast(result.ok ? "Profile update submitted for staff verification." : (result.error || "Could not submit profile update."), result.ok ? undefined : "rgba(155,22,22,.85)");
  if (result.ok) renderAccountPage();
}

function printAnalyticsReport(data) {
  const rows = (items) => (items || []).map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.count)}</td></tr>`).join("") || "<tr><td colspan='2'>No data</td></tr>";
  const section = (title, items) => `<h2>${esc(title)}</h2><table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${rows(items)}</tbody></table>`;
  const rangeLabel = data?.range && (data.range.from || data.range.to)
    ? `${data.range.from || "Beginning"} to ${data.range.to || "Present"}`
    : "All Time";
  const ops = data?.operations;
  const csat = data?.csat;
  const opsHtml = ops ? `<h2>Operational Performance</h2><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>
    <tr><td>Total Appointments</td><td>${esc(ops.totalAppointments)}</td></tr>
    <tr><td>Completion Rate</td><td>${esc(ops.completionRate)}% (${esc(ops.servedCount)} served)</td></tr>
    <tr><td>No-Show Rate</td><td>${esc(ops.noShowRate)}% (${esc(ops.noShowCount)} no-shows)</td></tr>
    <tr><td>Cancellation Rate</td><td>${esc(ops.cancellationRate)}% (${esc(ops.cancelledCount)} cancelled)</td></tr>
    <tr><td>Average Turnaround Time</td><td>${ops.avgTurnaroundHours != null ? `${esc(ops.avgTurnaroundHours)} hours (${esc(ops.completedRequestsCount)} completed)` : "N/A"}</td></tr>
  </tbody></table>` : "";
  const csatHtml = csat ? `<h2>Client Satisfaction (CSAT)</h2><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>
    <tr><td>Average Rating</td><td>${csat.total ? `${esc(csat.average)} / 5.0 (${esc(csat.total)} responses)` : "No ratings yet"}</td></tr>
    ${(csat.byService || []).map((s) => `<tr><td>${esc(s.label)}</td><td>${esc(s.average)} / 5.0 (${esc(s.count)})</td></tr>`).join("")}
  </tbody></table>` : "";
  const html = `<!doctype html><html><head><title>STARS Analytics Report</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#1a0505}h1{color:#8B1A1A;margin-bottom:4px}h2{margin-top:24px;font-size:16px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:8px;text-align:left}th{background:#8B1A1A;color:#fff}.foot{font-size:10px;color:#666;margin-top:24px}@media print{body{padding:0}.noprint{display:none}}</style></head><body><h1>STARS Analytics Report</h1><p>PUP San Pedro Student Services Office · Date Range: <b>${esc(rangeLabel)}</b></p>${opsHtml}${csatHtml}${section("Students by Course",data.byCourse)}${section("Students by Year Level",data.byYear)}${section("Appointments by Service",data.services)}${section("Peak Appointment Times",data.peakTimes)}<div class="foot">Generated ${esc(fnow())} · STARS</div><div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div><script>setTimeout(()=>window.print(),300);<\/script></body></html>`;
  const w = window.open("", "_blank"); if (!w) return showToast("Please allow pop-ups to save the PDF.", "rgba(180,130,0,.85)"); w.document.write(html); w.document.close();
}

function matchQ(q, fields) {
  if (q == null) return true;
  const needle = String(q).trim().toLowerCase();
  if (!needle) return true;
  return (fields || []).some((f) => f != null && String(f).toLowerCase().includes(needle));
}

var refAdminQ = "";
var idaAdminQ = "";
var hdAdminQ = "";
var cmpAdminQ = "";
var cmpCats = [];
var cmpFilters = { conf: "", cat: "", status: "" };
var cmpTab = "active";
async function loadComplaintData() {
  const cr = await api("/api/modules/complaint-categories");
  cmpCats = cr.ok ? cr.data : [];
  const r = await api("/api/modules/complaints" + (!isAdmin() && cmpTab === "archived" ? "?archived=1" : isAdmin() && cmpTab === "archived" ? "?archived=1" : ""));
  MOD.complaints = r.ok ? r.data : [];
}
function setCmpTab(t) { cmpTab = t || "active"; loadComplaintData().then(renderComplaint); }
function setCmpFilter(key, val) { cmpFilters[key] = val; renderComplaint(); }

function adminSearchBox(id, varName, renderFn, placeholder, currentVal) {
  return `<label class="ml-search"><i class="fa-solid fa-magnifying-glass"></i><input id="${id}" type="search" placeholder="${placeholder}" value="${esc(currentVal)}" aria-label="${placeholder}"
      oninput="${varName}=this.value;${renderFn}();(function(){var e=document.getElementById('${id}');if(e){e.focus();e.setSelectionRange(e.value.length,e.value.length);}})();"></label>`;
}
function emptyState(msg) { return `<div class="ml-empty dt-empty"><i class="fa-solid fa-inbox"></i><div>${esc(msg)}</div></div>`; }

// ── Shared admin table container + manage-modal pattern ──
// Every admin request list renders inside adminTableShell: titled card,
// count badge, filters, table, pagination. Row actions live in a Manage modal.
function adminTableShell({ icon, title, count, filtersHtml, theadHtml, rowsHtml, emptyHtml, paginationHtml }) {
  return `${filtersHtml ? `<div class="ml-fbar">${filtersHtml}<span class="ml-count">${count}</span></div>` : `<div class="ml-fbar"><span class="ml-count">${count}</span></div>`}
    ${rowsHtml
      ? `<div class="ml-card dt-wrap"><table class="glass-table dt-table ml-table ml-admin"><thead><tr>${theadHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>${paginationHtml || ""}`
      : emptyHtml}`;
}
function manageBtn(id, fnName) {
  return `<div class="ml-acts">${mlAct("fa-sliders", "Manage", `${fnName}('${esc(id)}')`)}</div>`;
}
function historyHtml(history) {
  if (!history || !history.length) return "";
  return `<div style="margin-top:8px;font-size:10px;color:rgba(30,5,5,.5);font-family:monospace;">${history.map((h) => `${esc(h.ts)} — ${esc(h.status)} by ${esc(h.by)}${h.note ? ": " + esc(h.note) : ""}`).join("<br>")}</div>`;
}
function modalActionsHtml(inner) {
  return `<div class="app-modal-actions" style="justify-content:flex-start;flex-wrap:wrap;">${inner}<button class="btn-soft" onclick="closeAppModal()">Close</button></div>`;
}

/** Decluttered admin modal footer: Close (left) · "More" menu · ONE primary action.
 *  `more` items: {label, icon, on, danger} or "-" for a divider. Destructive items should call maAsk(). */
function maFooter(primary, more) {
  const items = (more || []).filter(Boolean);
  const menu = items.length ? `<details class="ma-more"><summary class="bk-btn bk-btn-out bk-btn-sm" aria-label="More actions"><i class="fa-solid fa-ellipsis"></i>More</summary><div class="ma-menu">${items.map((i) => i === "-" ? "<hr>" : `<button type="button" class="ma-item${i.danger ? " bad" : ""}" onclick="${i.on}"><i class="fa-solid ${i.icon || "fa-circle"}"></i>${esc(i.label)}</button>`).join("")}</div></details>` : "";
  return `<div id="maFoot" class="ma-foot"><button type="button" class="bk-btn bk-btn-text bk-btn-sm" onclick="closeAppModal()">Close</button><span class="ma-sp"></span>${menu}${primary || ""}</div><div id="maAsk" class="ma-ask" hidden></div>`;
}
function maPrimary(label, icon, on) { return `<button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="${on}"><i class="fa-solid ${icon || "fa-arrow-right"}"></i>${esc(label)}</button>`; }
/** Inline confirmation that replaces the footer (instead of a browser confirm()). Optional reason box. */
function maAsk(o) {
  const box = document.getElementById("maAsk"), foot = document.getElementById("maFoot"); if (!box || !foot) return;
  box.innerHTML = `<div class="ma-ask-t"><i class="fa-solid ${o.icon || "fa-triangle-exclamation"}"></i>${esc(o.title)}</div>
    ${o.text ? `<div class="ma-ask-s">${esc(o.text)}</div>` : ""}
    ${o.reasonId ? `<div class="bk-input"><input id="${esc(o.reasonId)}" type="text" maxlength="200" placeholder="${esc(o.placeholder || "Reason (optional) — sent to the student")}"></div>` : ""}
    <div class="ma-ask-a"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="maAskBack()">Back</button><button type="button" class="bk-btn ${o.danger === false ? "bk-btn-fill" : "bk-btn-danger"} bk-btn-sm" onclick="${o.on}">${esc(o.confirm || "Confirm")}</button></div>`;
  box.hidden = false; foot.hidden = true;
  box.querySelector("input")?.focus();
}
function maAskBack() { const box = document.getElementById("maAsk"), foot = document.getElementById("maFoot"); if (box) box.hidden = true; if (foot) foot.hidden = false; }
document.addEventListener("click", (e) => { document.querySelectorAll("details.ma-more[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; }); });

const MODULE_REQUESTS_PER_PAGE = 5;
const moduleRequestPages = {};
function getModulePage(key, rows) {
  const totalPages = Math.max(1, Math.ceil(rows.length / MODULE_REQUESTS_PER_PAGE));
  const page = Math.min(Math.max(1, moduleRequestPages[key] || 1), totalPages);
  moduleRequestPages[key] = page;
  const start = (page - 1) * MODULE_REQUESTS_PER_PAGE;
  return { page, totalPages, start, items: rows.slice(start, start + MODULE_REQUESTS_PER_PAGE) };
}
function mlPager(info, prevOn, nextOn, page, totalPages, prevFn, nextFn) {
  return `<div class="ml-pager"><span>${info}</span><div class="ml-pager-nav"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" ${prevOn ? "" : "disabled"} onclick="${prevFn}"><i class="fa-solid fa-chevron-left"></i>Previous</button><b>${page} / ${totalPages}</b><button type="button" class="bk-btn bk-btn-out bk-btn-sm" ${nextOn ? "" : "disabled"} onclick="${nextFn}">Next<i class="fa-solid fa-chevron-right"></i></button></div></div>`;
}
function modulePagination(key, rowCount, renderFn) {
  if (!rowCount) return "";
  const { page, totalPages, start } = getModulePage(key, Array.from({ length: rowCount }));
  return mlPager(`Showing ${start + 1}-${Math.min(start + MODULE_REQUESTS_PER_PAGE, rowCount)} of ${rowCount}`, page > 1, page < totalPages, page, totalPages, `changeModulePage('${key}',${page - 1},'${renderFn}')`, `changeModulePage('${key}',${page + 1},'${renderFn}')`);
}
function changeModulePage(key, page, renderFn) {
  moduleRequestPages[key] = page;
  window[renderFn]();
}
function requestDropdown(summary, content, open = false) {
  return `<details class="glass-card" ${open ? "open" : ""} style="padding:0;margin-bottom:10px;overflow:hidden;"><summary style="cursor:pointer;list-style:none;padding:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;">${summary}<i class="fa-solid fa-chevron-down" style="color:#8B1A1A;font-size:12px;"></i></summary><div style="padding:0 14px 14px;border-top:1px solid rgba(139,26,26,.10);">${content}</div></details>`;
}
function enableRequestDropdowns(container) {
  container?.querySelectorAll("[data-module-request]").forEach((card) => {
    const header = card.firstElementChild;
    const sections = Array.from(card.children).slice(1);
    if (!header || !sections.length || header.dataset.dropdownReady) return;
    header.dataset.dropdownReady = "true";
    header.style.cursor = "pointer";
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    const arrow = document.createElement("i");
    arrow.className = "fa-solid fa-chevron-down";
    arrow.style.cssText = "color:#8B1A1A;font-size:12px;margin-left:auto;transition:transform .18s ease;";
    header.appendChild(arrow);
    const setOpen = (open) => {
      sections.forEach((section) => { section.style.display = open ? "" : "none"; });
      arrow.style.transform = open ? "rotate(180deg)" : "";
      header.setAttribute("aria-expanded", String(open));
    };
    setOpen(false);
    const toggle = (event) => {
      if (event.target.closest("button,input,select,textarea,a,label")) return;
      setOpen(header.getAttribute("aria-expanded") !== "true");
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(event); } });
  });
}


const REF_STATUSES = ["Pending", "Under Review", "Needs Revision", "Approved", "Confirmed", "Checked In", "In Progress", "Completed", "Rejected", "Cancelled", "No Show"];
let refEditingId = null;
function renderReferral() {
  const el = document.getElementById("referralBody");
  if (isAdmin()) {
    const list = [...MOD.referrals].reverse().filter((r) => matchQ(refAdminQ, [r.name, r.sn, r.id, r.category, r.status]));
    const rows = getModulePage("ref-admin", list).items.map((r) => `<tr>
        <td><div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(r.name)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(r.sn)} · ${esc(r.id)}</div></td>
        <td style="font-size:12px;">${esc(r.category)}</td>
        <td>${pill(r.status)}</td>
        <td style="font-size:11px;white-space:nowrap;">${r.appointmentCode ? esc(r.appointmentCode) : "—"}</td>
        <td style="font-size:11px;white-space:nowrap;">${esc(r.ts)}</td>
        <td style="text-align:right;">${manageBtn(r.id, "openReferralModal")}</td>
      </tr>`).join("");
    el.innerHTML = adminTableShell({
      icon: "fa-solid fa-hand-holding-heart",
      title: "Referrals",
      count: `${list.length} total`,
      filtersHtml: adminSearchBox("refAdminQBox", "refAdminQ", "renderReferral", "Search by name or student ID…", refAdminQ),
      theadHtml: "<th>Student</th><th>Category</th><th>Status</th><th>Session</th><th>Filed</th><th style=\"text-align:right;\">Action</th>",
      rowsHtml: rows,
      emptyHtml: emptyState(refAdminQ ? "No referrals match your search." : "No referrals submitted yet."),
      paginationHtml: modulePagination("ref-admin", list.length, "renderReferral"),
    });
  } else {
    const mine = MOD.referrals.filter((r) => r.sn === session.id).reverse();
    const minePage = getModulePage("ref-student", mine);
    const editing = refEditingId ? MOD.referrals.find((r) => r.id === refEditingId) : null;
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>${editing ? "Revise Referral" : "New Referral / Intervention Request"}</div>
        <div style="display:grid;gap:10px;">
          <div><span class="input-label">Category</span>
            <select id="refCat" class="glass-input">${["Academic Concern", "Personal / Emotional", "Behavioral", "Financial Assistance", "Health & Wellness", "Psychological Intervention", "Others"].map((c) => `<option${editing && editing.category === c ? " selected" : ""}>${c}</option>`).join("")}</select></div>
          <div><span class="input-label">Details</span>
            <textarea id="refDetails" class="glass-input" rows="4" placeholder="Describe the concern or the support you need…">${editing ? esc(editing.details) : ""}</textarea></div>
          ${!editing ? `<div style="border:1px dashed rgba(139,26,26,.3);border-radius:12px;padding:12px;">
            <div style="font-size:12px;font-weight:800;color:#1a0505;margin-bottom:8px;"><i class="fa-solid fa-calendar-day" style="color:#8B1A1A;margin-right:5px;"></i>Session schedule <span style="font-weight:400;color:rgba(30,5,5,.5);">(optional — or book later)</span></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div><span class="input-label">Session date</span><input id="refVisitDate" type="date" class="glass-input" onchange="loadRefVisitSlots()"></div>
              <div><span class="input-label">Time slot</span><select id="refVisitTime" class="glass-input"><option value="">Select a date first</option></select></div>
            </div>
            <div id="refVisitHint" style="font-size:11px;color:rgba(30,5,5,.6);margin-top:6px;">Only you and authorized SSO staff can see these details.</div>
          </div>` : ""}
          <div style="display:flex;gap:8px;">
            <button onclick="refSubmit()" class="btn-gold" style="padding:11px;">${editing ? "Resubmit for Review" : "Submit Request"}</button>
            ${editing ? '<button onclick="refEditingId=null;renderReferral()" class="btn-ghost" style="padding:11px 14px;">Cancel</button>' : ""}
          </div>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Referrals</div>
      ${mine.length ? minePage.items.map((r) => `
        <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(r.category)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(r.ts)}</span></div>
            ${pill(r.status)}
          </div>
          ${wfStepperHtml("referral", r)}
          <div style="font-size:12px;color:rgba(30,5,5,.75);margin-top:6px;white-space:pre-wrap;">${esc(r.details)}</div>
          ${r.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>OSS remarks:</b> ${esc(r.remarks)}</div>` : ""}
          ${r.appointmentCode ? `<div style="font-size:11px;color:rgba(30,5,5,.65);margin-top:6px;"><i class="fa-solid fa-calendar-check" style="color:#8B1A1A;margin-right:4px;"></i>Session: <b>${esc(r.appointmentCode)}</b> · ${esc(r.appointmentDate)} ${esc(r.appointmentTime)}</div>` : ""}
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${apptBookBtn("PSYCH", r.status)}${r.status === "Needs Revision" ? `<button onclick="refEditingId='${esc(r.id)}';renderReferral();window.scrollTo(0,0);" class="btn-maroon" style="padding:6px 10px;font-size:11px;">Revise</button>` : ""}</div>
        </div>`).join("") : emptyState("You have not submitted any referrals yet.")}
      ${modulePagination("ref-student", mine.length, "renderReferral")}
    `;
    enableRequestDropdowns(el);
  }
}
async function loadRefVisitSlots() {
  const dateEl = document.getElementById("refVisitDate");
  const timeEl = document.getElementById("refVisitTime");
  const hint = document.getElementById("refVisitHint");
  if (!dateEl || !timeEl) return;
  const label = toDateLabel(dateEl.value);
  if (!label) { timeEl.innerHTML = '<option value="">Select a date first</option>'; return; }
  timeEl.innerHTML = '<option value="">Loading…</option>';
  const { slots, holiday } = await fetchSlots("PSYCH", label);
  if (holiday) {
    timeEl.innerHTML = '<option value="">SSO closed on this date</option>';
    if (hint) hint.textContent = `SSO closed — ${holiday.name || holiday.date}.`;
    return;
  }
  const open = slots.filter((s) => !s.blocked && s.remaining > 0);
  timeEl.innerHTML = open.length
    ? '<option value="">Choose a time…</option>' + open.map((s) => `<option value="${esc(s.time)}">${esc(s.time)} (${s.remaining} left)</option>`).join("")
    : '<option value="">No slots left on this date</option>';
}
async function refSubmit() {
  const cat = document.getElementById("refCat").value;
  const det = document.getElementById("refDetails").value.trim();
  if (!det) { showToast("⚠️ Please describe your concern.", "rgba(180,130,0,.85)"); return; }
  if (refEditingId) {
    const res = await api(`/api/modules/referrals/${encodeURIComponent(refEditingId)}/resubmit`, { method: "POST", body: { category: cat, details: det } });
    if (!res.ok) { showToast(`❌ ${res.error || "Could not resubmit."}`, "rgba(155,22,22,.85)"); return; }
    refEditingId = null;
    showToast("✅ Referral resubmitted for review.");
    await loadModule("referrals"); renderReferral();
    return;
  }
  const body = { category: cat, details: det };
  const iso = document.getElementById("refVisitDate")?.value || "";
  const time = document.getElementById("refVisitTime")?.value || "";
  if (iso || time) {
    if (!iso || !time) { showToast("⚠️ Please choose both a session date and time, or neither.", "rgba(180,130,0,.85)"); return; }
    body.appointmentDate = toDateLabel(iso); body.appointmentTime = time;
  }
  const { ok, data, error } = await api("/api/modules/referrals", { method: "POST", body });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast(data && data.appointmentCode ? `✅ Referral submitted! Session ${data.appointmentCode}.` : "✅ Referral submitted.");
  await loadModule("referrals"); renderReferral();
}
async function refUpdate(id, next) {
  const sel = document.getElementById("refst-" + id);
  const st = next || (sel ? sel.value : "");
  if (!st) { showToast("⚠️ No status selected.", "rgba(180,130,0,.85)"); return; }
  const rm = document.getElementById("refrm-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/referrals/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, remarks: rm } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and student notified.");
  closeAppModal();
  await loadModule("referrals"); renderReferral();
}
function openReferralModal(id) {
  const r = (MOD.referrals || []).find((x) => x.id === id);
  if (!r) { showToast("❌ Referral not found.", "rgba(155,22,22,.85)"); return; }
  openAppModal({ title: `${r.category} — ${r.id}`, subtitle: `${r.name} · ${r.sn} · filed ${r.ts}`, icon: "fa-hand-holding-heart", wide: true, content: `
    <div style="display:grid;gap:12px;">
      <div class="glass-card" style="padding:14px;">
        <div style="font-size:12px;color:rgba(30,5,5,.8);white-space:pre-wrap;">${esc(r.details)}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:center;">${pill(r.status)}
          ${r.appointmentCode ? `<span style="font-size:11px;">Session: <b>${esc(r.appointmentCode)}</b> · ${esc(r.appointmentDate)} ${esc(r.appointmentTime)}</span>` : ""}
        </div>
        ${r.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>Remarks:</b> ${esc(r.remarks)}</div>` : ""}
      </div>
      ${wfStepperHtml("referral", r)}
      <div class="app-modal-grid">
        <div class="app-field full"><label>Remarks (optional — sent to the student)</label><input id="refrm-${r.id}" class="glass-input" value="${esc(r.remarks || "")}"></div>
      </div>
      ${historyHtml(r.history)}
      ${wfFooterHtml("referral", r.id, r)}
    </div>` });
}


const ID_STATUSES = ["Pending", "OR Verified", "Needs Revision", "Approved", "Processing", "Ready for Claiming", "Claimed", "Completed", "Rejected", "Cancelled"];
let idaEditingId = null;
function renderIdApp() {
  const el = document.getElementById("idappBody");
  if (isAdmin()) {
    const list = [...MOD.idapps].reverse().filter((a) => matchQ(idaAdminQ, [a.name, a.sn, a.id, a.type, a.status]));
    const eligible = list.filter((a) => ["Approved", "Processing", "Ready for Claiming"].includes(a.status));
    const eligibleIds = new Set(eligible.map((a) => a.id));
    for (const id of [...BATCH_SEL.idapps]) { if (!eligibleIds.has(id)) BATCH_SEL.idapps.delete(id); }
    const selCount = BATCH_SEL.idapps.size;
    const rows = getModulePage("idapp-admin", list).items.map((a) => {
      const canBatch = eligibleIds.has(a.id);
      return `<tr>
        <td style="width:34px;">${canBatch ? `<input type="checkbox" class="batch-chk" data-batch="idapps" value="${esc(a.id)}" ${BATCH_SEL.idapps.has(a.id) ? "checked" : ""} onchange="toggleBatchItem('idapps','${esc(a.id)}',this.checked)" aria-label="Select ${esc(a.id)}">` : ""}</td>
        <td><div style="font-weight:700;font-size:12px;color:#1a0505;">${esc(a.type)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(a.id)}</div></td>
        <td><div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(a.name)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(a.sn)}</div></td>
        <td>${pill(a.status)}</td>
        <td style="font-size:11px;white-space:nowrap;">${a.pickupDate ? `${esc(a.pickupDate)} ${esc(a.pickupTime)}` : "—"}</td>
        <td style="font-size:11px;white-space:nowrap;">${esc(a.ts)}</td>
        <td style="text-align:right;">${manageBtn(a.id, "openIdAppModal")}</td>
      </tr>`;
    }).join("");
    const batchBar = eligible.length ? `<div class="batch-bar" style="border-radius:12px;margin-bottom:12px;border:1px solid rgba(212,160,23,.35);">
      <span><i class="fa-solid fa-boxes-packing" style="margin-right:6px;color:#8B1A1A;"></i>${selCount ? `${selCount} ID application${selCount === 1 ? "" : "s"} selected` : `Select approved/ready ID applications to schedule pickups in batch (${eligible.length} eligible)`}</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" class="btn-gold" style="padding:6px 12px;font-size:11px;" ${selCount ? "" : "disabled"} onclick="openBatchPickupModal('idapps')"><i class="fa-solid fa-calendar-check" style="margin-right:5px;"></i>Batch Schedule Pickup (${selCount})</button>
      </div>
    </div>` : "";
    el.innerHTML = adminTableShell({
      icon: "fa-solid fa-id-card",
      title: "ID Applications",
      count: `${list.length} total`,
      filtersHtml: adminSearchBox("idaAdminQBox", "idaAdminQ", "renderIdApp", "Search by name or student ID…", idaAdminQ) + batchBar,
      theadHtml: `<th style="width:34px;"><input type="checkbox" class="batch-chk" ${eligible.length && selCount === eligible.length ? "checked" : ""} onchange="toggleBatchSelectAll('idapps', this.checked)" aria-label="Select all eligible ID applications"></th><th>Application</th><th>Student</th><th>Status</th><th>Pickup</th><th>Filed</th><th style="text-align:right;">Action</th>`,
      rowsHtml: rows,
      emptyHtml: emptyState(idaAdminQ ? "No applications match your search." : "No ID applications yet."),
      paginationHtml: modulePagination("idapp-admin", list.length, "renderIdApp"),
    });
  } else {
    void ensureMyFeedbackLoaded();
    const mine = MOD.idapps.filter((a) => a.sn === session.id).reverse();
    const minePage = getModulePage("idapp-student", mine);
    const editing = idaEditingId ? MOD.idapps.find((a) => a.id === idaEditingId) : null;
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>${editing ? "Revise ID Application" : "New ID Application"}</div>
        <div style="display:grid;gap:10px;">
          <div><span class="input-label">Application Type</span>
            <select id="idType" class="glass-input" onchange="toggleAffidavitField()" ${editing ? "disabled" : ""}><option${editing && editing.type === "New ID" ? " selected" : ""}>New ID</option><option${editing && editing.type === "ID Replacement — Lost" ? " selected" : ""}>ID Replacement — Lost</option><option${editing && editing.type === "ID Replacement — Damaged" ? " selected" : ""}>ID Replacement — Damaged</option></select></div>
          <div><span class="input-label">Reason / Details</span>
            <textarea id="idReason" class="glass-input" rows="3" placeholder="e.g., Lost my ID on campus last week…">${editing ? esc(editing.reason) : ""}</textarea></div>
          <div id="affidavitField" style="display:none;"><span class="input-label">Affidavit of Loss${editing && editing.affidavitName ? " — current: " + esc(editing.affidavitName) : " — required for a lost ID"}</span>
            <input id="idAffidavit" type="file" data-fu="1" accept=".jpg,.jpeg,.png,.pdf">
            <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Upload the signed Affidavit of Loss (JPG, PNG, or PDF, max 1.5 MB).</div></div>
          <div class="info-box" style="font-size:11px;padding:10px 12px;"><i class="fa-solid fa-circle-info" style="color:#D4A017;margin-right:5px;"></i>No need to book a visit — the SSO will schedule your ID pickup and notify you once it is ready.</div>
          <div style="display:flex;gap:8px;">
            <button onclick="idSubmit()" class="btn-gold" style="padding:11px;">${editing ? "Resubmit for Review" : "Submit Application"}</button>
            ${editing ? '<button onclick="idaEditingId=null;renderIdApp()" class="btn-ghost" style="padding:11px 14px;">Cancel</button>' : ""}
          </div>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Applications</div>
      ${mine.length ? minePage.items.map((a) => `
        <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(a.type)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(a.ts)}</span></div>
            ${pill(a.status)}
          </div>
          ${wfStepperHtml("idapp", a)}
          <div style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;">${a.orUrl ? fileLink(a.orName, a.orUrl, "My uploaded OR") : ""}${a.affidavitUrl ? fileLink(a.affidavitName, a.affidavitUrl, "My Affidavit of Loss") : ""}</div>
          ${a.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>OSS remarks:</b> ${esc(a.remarks)}</div>` : ""}
          ${a.pickupDate ? `<div style="font-size:11px;color:#15803d;margin-top:6px;"><i class="fa-solid fa-box-open" style="margin-right:4px;"></i>Pickup: <b>${esc(a.pickupDate)} ${esc(a.pickupTime)}</b>${a.pickupNote ? ` — ${esc(a.pickupNote)}` : ""}</div>` : ""}
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            ${a.status === "Needs Revision" ? `<button onclick="idaEditingId='${esc(a.id)}';renderIdApp();window.scrollTo(0,0);" class="btn-maroon" style="padding:6px 10px;font-size:11px;">Revise</button>` : ""}
            ${/^(claimed|completed)$/i.test(a.status || "") ? csatActionHtml(a.id, a.type || "ID Application") : ""}
          </div>
        </div>`).join("") : emptyState("No applications yet.")}
      ${modulePagination("idapp-student", mine.length, "renderIdApp")}
    `;
    enableRequestDropdowns(el);
    fileInitAll(el); toggleAffidavitField();
  }
}
async function idSubmit() {
  const editing = idaEditingId ? MOD.idapps.find((a) => a.id === idaEditingId) : null;
  const type = editing ? editing.type : document.getElementById("idType").value;
  const reason = document.getElementById("idReason").value.trim();
  const affidavitInput = document.getElementById("idAffidavit");
  if (!reason) { showToast("⚠️ Please provide the reason/details.", "rgba(180,130,0,.85)"); return; }
  let affidavit = { fileName: editing ? (editing.affidavitName || "") : "", url: editing ? (editing.affidavitUrl || "") : "" };
  if (type === "ID Replacement — Lost") {
    if (affidavitInput.files.length) {
      affidavit = await uploadFile(affidavitInput);
      if (affidavit === false || !affidavit.url) return;
    }
    if (!affidavit.url) { showToast("⚠️ An Affidavit of Loss is required for a lost ID.", "rgba(180,130,0,.85)"); return; }
  }
  if (editing) {
    const { ok, error } = await api(`/api/modules/idapps/${encodeURIComponent(editing.id)}/resubmit`, { method: "POST", body: { reason, affidavitName: affidavit.fileName, affidavitUrl: affidavit.url } });
    if (!ok) { showToast(`❌ ${error || "Could not resubmit."}`, "rgba(155,22,22,.85)"); return; }
    idaEditingId = null;
    showToast("✅ Application resubmitted for review.");
    await loadModule("idapps"); renderIdApp();
    return;
  }
  const { ok, error } = await api("/api/modules/idapps", { method: "POST", body: { type, reason, affidavitName: affidavit.fileName, affidavitUrl: affidavit.url } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Application submitted.");
  await loadModule("idapps"); renderIdApp();
}
function toggleAffidavitField() {
  const typeEl = document.getElementById("idType");
  if (!typeEl) return;
  const field = document.getElementById("affidavitField");
  const isLost = typeEl.value === "ID Replacement — Lost";
  if (field) field.style.display = isLost ? "block" : "none";
}
async function idUpdate(id, next) {
  const sel = document.getElementById("idst-" + id);
  const st = next || (sel ? sel.value : "");
  if (!st) { showToast("⚠️ No status selected.", "rgba(180,130,0,.85)"); return; }
  const rm = document.getElementById("idrm-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/idapps/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, remarks: rm } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and student notified.");
  closeAppModal();
  await refreshAfterModuleChange("idapps");
}
function openIdAppModal(id) {
  const a = (MOD.idapps || []).find((x) => x.id === id);
  if (!a) { showToast("❌ Application not found.", "rgba(155,22,22,.85)"); return; }
  const canSchedule = ["Approved", "Processing", "Ready for Claiming"].includes(a.status);
  const canComplete = a.status === "Ready for Claiming";
  openAppModal({ title: `${a.type} — ${a.id}`, subtitle: `${a.name} · ${a.sn} · filed ${a.ts}`, icon: "fa-id-card", wide: true, content: `
    <div style="display:grid;gap:12px;">
      <div class="glass-card" style="padding:14px;">
        <div style="font-size:12px;color:rgba(30,5,5,.8);white-space:pre-wrap;">${esc(a.reason)}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:center;">${pill(a.status)}
          ${a.orUrl ? fileLink(a.orName, a.orUrl, "View Official Receipt") : ""}
          ${a.affidavitUrl ? fileLink(a.affidavitName, a.affidavitUrl, "View Affidavit of Loss") : ""}
          ${a.pickupDate ? `<span style="font-size:11px;color:#15803d;">Pickup: <b>${esc(a.pickupDate)} ${esc(a.pickupTime)}</b>${a.pickupNote ? ` — ${esc(a.pickupNote)}` : ""}</span>` : ""}
        </div>
        ${a.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>Remarks:</b> ${esc(a.remarks)}</div>` : ""}
      </div>
      ${wfStepperHtml("idapp", a)}
      <div class="app-modal-grid">
        <div class="app-field full"><label>Remarks (optional — sent to the student)</label><input id="idrm-${a.id}" class="glass-input" value="${esc(a.remarks || "")}"></div>
      </div>
      ${historyHtml(a.history)}
      ${wfFooterHtml("idapp", a.id, a, canComplete ? { primary: { label: "Mark claimed", icon: "fa-circle-check", on: `maAsk({title:'Mark claimed?',text:'This closes it out and the student is notified.',confirm:'Yes, mark claimed',danger:false,icon:'fa-circle-check',on:&quot;completePickup(\'idapps\',\'${esc(a.id)}\',true)&quot;})` }, skipNext: true, more: canSchedule ? [{ label: "Reschedule pickup", icon: "fa-calendar-check", on: `closeAppModal();openPickupModal('idapps','${esc(a.id)}')` }] : [] } : canSchedule ? { primary: { label: "Schedule pickup", icon: "fa-calendar-check", on: `closeAppModal();openPickupModal('idapps','${esc(a.id)}')` } } : null)}
    </div>` });
}


// ── Service Requests: Authentication / Excuse Slip / General Visit (flow spec §§2,5,7) ──
const REQ_SERVICES = [
  { key: "AUTHENTICATION", label: "Authentication", pickup: true },
  { key: "EXCUSE_SLIP", label: "Excuse Slip", pickup: true },
  { key: "GENERAL_VISIT", label: "General Visit", pickup: false },
];
const REQ_STATUSES = ["Pending Review", "Needs Revision", "Approved", "Ready for Pickup", "Pickup Scheduled", "Completed", "Rejected", "Cancelled"];
let presetRequestService = null;
let reqEditingId = null;
var reqAdminQ = "";
function openRequests(service) { presetRequestService = service || null; reqEditingId = null; goTo("page-requests"); }
function reqServiceLabel(key) { const s = REQ_SERVICES.find((x) => x.key === key); return s ? s.label : key; }
function reqIsPickup(service) { const s = REQ_SERVICES.find((x) => x.key === service); return !s || s.pickup; }
/** YYYY-MM-DD → "Month D, YYYY" (backend date label). */
function toDateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return "";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
/** "HH:MM" (24h, from <input type="time">) → "h:mm AM/PM" backend label. */
function toTimeLabel(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  if (h > 23) return "";
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${min} ${ap}`;
}
async function fetchSlots(service, dateLabel) {
  const r = await api(`/api/queue?date=${encodeURIComponent(dateLabel)}&service=${encodeURIComponent(service)}`);
  if (!r.ok) return { slots: [], holiday: null };
  return { slots: r.data.slots || [], holiday: r.data.holiday || null };
}
function renderServiceRequests() {
  const el = document.getElementById("requestsBody");
  if (!el) return;
  const reqTitle = document.getElementById("requestsTitle");
  const reqSub = document.getElementById("requestsSub");
  if (reqTitle) reqTitle.textContent = isAdmin() ? "All Requests" : "Requests";
  if (reqSub) reqSub.textContent = isAdmin() ? "Service requests and ID applications — review, schedule pickups, and notify students." : "File a request. Pickups are scheduled by the SSO when your documents are ready.";
  if (presetRequestService && REQ_SERVICES.some((s) => s.key === presetRequestService)) {
    reqEditingId = null;
  }
  if (isAdmin()) {
    const q = reqAdminQ;
    const svcF = document.getElementById("reqAdminSvc")?.value || "";
    // Unified type filter: a plain REQ_SERVICES key filters service requests,
    // an "ida:<type>" value filters ID applications; empty shows both merged.
    const isIdaSvc = svcF.startsWith("ida:");
    const idaType = isIdaSvc ? svcF.slice(4) : "";
    const reqList = [...(MOD.requests || [])].reverse().filter((r) => (!svcF || (!isIdaSvc && r.service === svcF)) && matchQ(q, [r.name, r.sn, r.id, r.subject, r.details, r.status]));
    const idaList = [...(MOD.idapps || [])].reverse().filter((a) => (!svcF || (isIdaSvc && a.type === idaType)) && matchQ(q, [a.name, a.sn, a.id, a.type, a.status]));
    const combined = [
      ...reqList.map((r) => ({ kind: "req", item: r })),
      ...idaList.map((a) => ({ kind: "ida", item: a })),
    ];
    const eligReqIds = new Set(reqList.filter((r) => r.service !== "GENERAL_VISIT" && ["Approved", "Ready for Pickup", "Pickup Scheduled"].includes(r.status)).map((r) => r.id));
    const eligIdaIds = new Set(idaList.filter((a) => ["Approved", "Processing", "Ready for Claiming"].includes(a.status)).map((a) => a.id));
    for (const id of [...BATCH_SEL.requests]) { if (!eligReqIds.has(id)) BATCH_SEL.requests.delete(id); }
    for (const id of [...BATCH_SEL.idapps]) { if (!eligIdaIds.has(id)) BATCH_SEL.idapps.delete(id); }
    const reqSelCount = BATCH_SEL.requests.size;
    const idaSelCount = BATCH_SEL.idapps.size;
    const pageItems = getModulePage("req-admin", combined).items;
    const reqRow = ({ title, sub, name, sn, status, d, t, chk, open }) => `<tr class="ml-tr" tabindex="0" onclick="${open}" onkeydown="if(event.key==='Enter'&&event.target===this){${open}}">
      <td class="ml-chk" onclick="event.stopPropagation()">${chk || ""}</td>
      <td><div class="ml-svc">${esc(title)}</div><div class="ml-code">${esc(sub)}</div></td>
      <td><div class="ml-svc" style="font-weight:600;">${esc(name)}</div><div class="ml-code">${esc(sn)}</div></td>
      <td>${pill(status)}</td>
      <td><div class="ml-d">${esc(d)}</div><div class="ml-t">${esc(t)}</div></td>
      <td onclick="event.stopPropagation()" style="text-align:right;"><div class="ml-acts">${mlAct("fa-sliders", "Manage", open)}</div></td>
    </tr>`;
    const when = (x, filed) => x.pickupDate ? [x.pickupDate, `Pickup \u00b7 ${x.pickupTime || ""}`.replace(/ \u00b7 $/, "")] : (([dd, tt]) => [dd, `Filed${tt ? ` \u00b7 ${tt}` : ""}`])(splitWhen(filed));
    const rows = pageItems.map((it) => {
      if (it.kind === "ida") {
        const a = it.item, [d, t] = when(a, a.ts);
        const chk = eligIdaIds.has(a.id) ? `<input type="checkbox" class="batch-chk" data-batch="idapps" value="${esc(a.id)}" ${BATCH_SEL.idapps.has(a.id) ? "checked" : ""} onchange="toggleBatchItem('idapps','${esc(a.id)}',this.checked)" aria-label="Select ${esc(a.id)}">` : "";
        return reqRow({ title: a.type, sub: `ID Application \u00b7 ${a.id}`, name: a.name, sn: a.sn, status: a.status, d, t, chk, open: `openIdAppModal('${esc(a.id)}')` });
      }
      const r = it.item, [d, t] = when(r, r.ts);
      const chk = eligReqIds.has(r.id) ? `<input type="checkbox" class="batch-chk" data-batch="requests" value="${esc(r.id)}" ${BATCH_SEL.requests.has(r.id) ? "checked" : ""} onchange="toggleBatchItem('requests','${esc(r.id)}',this.checked)" aria-label="Select ${esc(r.id)}">` : "";
      return reqRow({ title: r.subject || reqServiceLabel(r.service), sub: `${reqServiceLabel(r.service)} \u00b7 ${r.id}`, name: r.name, sn: r.sn, status: r.status, d, t, chk, open: `openRequestModal('${esc(r.id)}')` });
    }).join("");
    const idaTypeOpts = [...new Set(["New ID", "ID Replacement — Lost", "ID Replacement — Damaged", ...((MOD.idapps || []).map((a) => a.type).filter(Boolean))])];
    const selTotal = reqSelCount + idaSelCount;
    const batchBar = selTotal ? `<div class="batch-bar"><span><i class="fa-solid fa-boxes-packing" style="margin-right:8px;color:#8B1A1A;"></i>${selTotal} selected for pickup scheduling</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${reqSelCount ? `<button type="button" class="btn-maroon" onclick="openBatchPickupModal('requests')"><i class="fa-solid fa-calendar-check"></i>Schedule ${reqSelCount} request${reqSelCount === 1 ? "" : "s"}</button>` : ""}
        ${idaSelCount ? `<button type="button" class="btn-maroon" onclick="openBatchPickupModal('idapps')"><i class="fa-solid fa-id-card"></i>Schedule ${idaSelCount} ID${idaSelCount === 1 ? "" : "s"}</button>` : ""}
        <button type="button" class="btn-ghost" onclick="toggleBatchSelectAll('requests', false);toggleBatchSelectAll('idapps', false)">Clear</button>
      </div></div>` : "";
    el.innerHTML = adminTableShell({
      icon: "fa-solid fa-inbox",
      title: "All Requests",
      count: `${combined.length} total`,
      filtersHtml: adminSearchBox("reqAdminQBox", "reqAdminQ", "renderServiceRequests", "Search by name, student ID, or request ID…", q)
        + `<div class="bk-input ml-dd" style="width:240px;"><select id="reqAdminSvc" data-dd="1" aria-label="Type" onchange="renderServiceRequests()"><option value="">All types</option><optgroup label="Service Requests">${REQ_SERVICES.map((s) => `<option value="${s.key}"${svcF === s.key ? " selected" : ""}>${s.label}</option>`).join("")}</optgroup><optgroup label="ID Applications">${idaTypeOpts.map((t) => `<option value="ida:${esc(t)}"${svcF === "ida:" + t ? " selected" : ""}>${esc(t)}</option>`).join("")}</optgroup></select></div>`
        + batchBar,
      theadHtml: `<th style="width:34px;"></th><th>Request</th><th>Student</th><th>Status</th><th>Date</th><th style="text-align:right;"></th>`,
      rowsHtml: rows,
      emptyHtml: emptyState(q || svcF ? "No requests match your filters." : "No requests yet."),
      paginationHtml: modulePagination("req-admin", combined.length, "renderServiceRequests"),
    });
  } else {
    void ensureMyFeedbackLoaded();
    const mine = MOD.requests.filter((r) => r.sn === session.id).reverse();
    const minePage = getModulePage("req-student", mine);
    const editing = reqEditingId ? MOD.requests.find((r) => r.id === reqEditingId) : null;
    const svc = editing ? editing.service : (presetRequestService && REQ_SERVICES.some((s) => s.key === presetRequestService) ? presetRequestService : "AUTHENTICATION");
    presetRequestService = null;
    const isVisit = svc === "GENERAL_VISIT";
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>${editing ? "Revise Request" : "New Service Request"}</div>
        <div style="display:grid;gap:10px;">
          <div><span class="input-label">Service <span style="color:#f87171;">*</span></span>
            <select id="reqService" class="glass-input" onchange="renderServiceRequests()" ${editing ? "disabled" : ""}>
              ${REQ_SERVICES.map((s) => `<option value="${s.key}"${svc === s.key ? " selected" : ""}>${s.label}</option>`).join("")}
            </select></div>
          ${reqIsPickup(svc)
            ? `<div><span class="input-label">Subject / Document <span style="color:#f87171;">*</span></span>
              <input id="reqSubject" class="glass-input" placeholder="e.g. TOR authentication, 2 copies" value="${editing ? esc(editing.subject) : ""}"></div>`
            : `<div><span class="input-label">Subject / Purpose <span style="color:#f87171;">*</span></span>
              <input id="reqSubject" class="glass-input" placeholder="e.g. Follow-up on my concern…" value="${editing ? esc(editing.subject) : ""}"></div>`}
          <div><span class="input-label">Reason / Details <span style="color:#f87171;">*</span></span>
            <textarea id="reqDetails" class="glass-input" rows="3" placeholder="Provide the details of your request…">${editing ? esc(editing.details) : ""}</textarea></div>
          ${reqIsPickup(svc) ? `<div><span class="input-label">Copies needed</span>
            <input id="reqCopies" class="glass-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" title="Whole number from 1 to 10" onkeydown="return intOnlyKey(event)" oninput="intOnlyClean(this,1,10)" onpaste="setTimeout(()=>intOnlyClean(this,1,10),0)" value="${editing ? editing.copies : 1}"></div>` : ""}
          ${!editing && isVisit ? `<div style="border:1px dashed rgba(139,26,26,.3);border-radius:12px;padding:12px;">
            <div style="font-size:12px;font-weight:800;color:#1a0505;margin-bottom:8px;"><i class="fa-solid fa-calendar-day" style="color:#8B1A1A;margin-right:5px;"></i>Pick your visit schedule <span style="color:#f87171;">*</span></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div><span class="input-label">Visit date</span><input id="reqVisitDate" type="date" class="glass-input" onchange="loadReqVisitSlots()"></div>
              <div><span class="input-label">Time slot</span><select id="reqVisitTime" class="glass-input"><option value="">Select a date first</option></select></div>
            </div>
            <div id="reqVisitHint" style="font-size:11px;color:rgba(30,5,5,.6);margin-top:6px;">Weekdays only, within this or next month.</div>
          </div>` : ""}
          ${editing && editing.appointmentCode ? `<div style="font-size:11px;color:rgba(30,5,5,.65);"><i class="fa-solid fa-calendar-check" style="color:#8B1A1A;margin-right:4px;"></i>Scheduled visit: <b>${esc(editing.appointmentCode)}</b> · ${esc(editing.dateLabel)} ${esc(editing.time)}</div>` : ""}
          ${reqIsPickup(svc) && !editing ? `<div class="info-box" style="font-size:11px;padding:10px 12px;"><i class="fa-solid fa-circle-info" style="color:#D4A017;margin-right:5px;"></i>No need to book a visit — the SSO will schedule your pickup and notify you once your documents are ready.</div>` : ""}
          <div style="display:flex;gap:8px;">
            <button onclick="reqSubmit()" class="btn-gold" style="padding:11px 18px;">${editing ? "Resubmit for Review" : "Submit Request"}</button>
            ${editing ? '<button onclick="reqEditingId=null;renderServiceRequests()" class="btn-ghost" style="padding:11px 14px;">Cancel</button>' : ""}
          </div>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Requests</div>
      ${mine.length ? minePage.items.map((r) => `
        <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(reqServiceLabel(r.service))} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(r.id)} · ${esc(r.ts)}</span></div>
            ${pill(r.status)}
          </div>
          ${wfStepperHtml("request", r)}
          ${r.subject ? `<div style="font-size:12px;font-weight:700;color:rgba(30,5,5,.85);margin-top:6px;">${esc(r.subject)}${r.copies > 1 ? ` ×${r.copies}` : ""}</div>` : ""}
          <div style="font-size:12px;color:rgba(30,5,5,.75);margin-top:4px;white-space:pre-wrap;">${esc(r.details)}</div>
          ${r.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>OSS remarks:</b> ${esc(r.remarks)}</div>` : ""}
          ${(r.pickupDate) ? `<div style="font-size:11px;color:#15803d;margin-top:6px;"><i class="fa-solid fa-box-open" style="margin-right:4px;"></i>Pickup: <b>${esc(r.pickupDate)} ${esc(r.pickupTime)}</b>${r.pickupNote ? ` — ${esc(r.pickupNote)}` : ""}</div>` : ""}
          ${r.appointmentCode ? `<div style="font-size:11px;color:rgba(30,5,5,.65);margin-top:6px;"><i class="fa-solid fa-calendar-check" style="color:#8B1A1A;margin-right:4px;"></i>Visit: <b>${esc(r.appointmentCode)}</b> · ${esc(r.dateLabel)} ${esc(r.time)}</div>` : ""}
          ${r.history && r.history.length ? `<div style="margin-top:6px;font-size:10px;color:rgba(30,5,5,.55);font-family:monospace;">${r.history.map((h) => `${esc(h.ts)} — ${esc(h.status)}${h.note ? ": " + esc(h.note) : ""}`).join("<br>")}</div>` : ""}
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            ${r.status === "Needs Revision" ? `<button onclick="reqEditingId='${esc(r.id)}';renderServiceRequests();window.scrollTo(0,0);" class="btn-maroon" style="padding:6px 10px;font-size:11px;">Revise</button>` : ""}
            ${/^(completed|claimed)$/i.test(r.status || "") ? csatActionHtml(r.id, reqServiceLabel(r.service)) : ""}
          </div>
        </div>`).join("") : emptyState("No requests yet.")}
      ${modulePagination("req-student", mine.length, "renderServiceRequests")}
    `;
    enableRequestDropdowns(el);
  }
}
async function loadReqVisitSlots() {
  const dateEl = document.getElementById("reqVisitDate");
  const timeEl = document.getElementById("reqVisitTime");
  const hint = document.getElementById("reqVisitHint");
  if (!dateEl || !timeEl) return;
  const label = toDateLabel(dateEl.value);
  if (!label) { timeEl.innerHTML = '<option value="">Select a date first</option>'; return; }
  timeEl.innerHTML = '<option value="">Loading…</option>';
  const { slots, holiday } = await fetchSlots("GENERAL", label);
  if (holiday) {
    timeEl.innerHTML = '<option value="">SSO closed on this date</option>';
    if (hint) hint.textContent = `SSO closed — ${holiday.name || holiday.date}.`;
    return;
  }
  const open = slots.filter((s) => !s.blocked && s.remaining > 0);
  timeEl.innerHTML = open.length
    ? '<option value="">Choose a time…</option>' + open.map((s) => `<option value="${esc(s.time)}">${esc(s.time)} (${s.remaining} left)</option>`).join("")
    : '<option value="">No slots left on this date</option>';
  if (hint) hint.textContent = "Weekdays only, within this or next month.";
}
async function reqSubmit() {
  const svc = document.getElementById("reqService")?.value || "AUTHENTICATION";
  const subject = document.getElementById("reqSubject").value.trim();
  const details = document.getElementById("reqDetails").value.trim();
  const copies = document.getElementById("reqCopies") ? readIntInput("reqCopies", 1, 10, "Copies") : 1;
  if (copies === null) return;
  if (!details) { showToast("⚠️ Please provide the reason/details.", "rgba(180,130,0,.85)"); return; }
  if (!reqIsPickup(svc) && !subject) { showToast("⚠️ Please provide a subject/purpose.", "rgba(180,130,0,.85)"); return; }
  if (reqEditingId) {
    const body = { subject, details, copies };
    const res = await api(`/api/modules/requests/${encodeURIComponent(reqEditingId)}/resubmit`, { method: "POST", body });
    if (!res.ok) { showToast(`❌ ${res.error || "Could not resubmit."}`, "rgba(155,22,22,.85)"); return; }
    reqEditingId = null;
    showToast("✅ Request resubmitted for review.");
    await loadModule("requests"); renderServiceRequests();
    return;
  }
  const body = { service: svc, subject, details, copies };
  if (svc === "GENERAL_VISIT") {
    const iso = document.getElementById("reqVisitDate")?.value || "";
    const time = document.getElementById("reqVisitTime")?.value || "";
    if (!iso || !time) { showToast("⚠️ Please choose your visit date and time.", "rgba(180,130,0,.85)"); return; }
    body.dateLabel = toDateLabel(iso); body.time = time;
  }
  const res = await api("/api/modules/requests", { method: "POST", body });
  if (!res.ok) { showToast(`❌ ${res.error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast(svc === "GENERAL_VISIT" ? `✅ Visit requested! Appointment ${res.data.appointmentCode} — awaiting SSO approval.` : "✅ Request submitted.");
  await loadModule("requests"); renderServiceRequests();
}
async function reqUpdate(id, next) {
  const sel = document.getElementById("reqst-" + id);
  const st = next || (sel ? sel.value : "");
  if (!st) { showToast("⚠️ No status selected.", "rgba(180,130,0,.85)"); return; }
  const rm = document.getElementById("reqrm-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/requests/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, remarks: rm } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and student notified.");
  closeAppModal();
  await refreshAfterModuleChange("requests");
}
function openRequestModal(id) {
  const r = (MOD.requests || []).find((x) => x.id === id);
  if (!r) { showToast("❌ Request not found.", "rgba(155,22,22,.85)"); return; }
  const pickup = reqIsPickup(r.service);
  const canSchedule = pickup && ["Approved", "Ready for Pickup", "Pickup Scheduled"].includes(r.status);
  const canComplete = pickup && r.status === "Pickup Scheduled";
  openAppModal({ title: `${reqServiceLabel(r.service)} — ${r.id}`, subtitle: `${r.name} · ${r.sn} · filed ${r.ts}`, icon: "fa-file-circle-check", wide: true, content: `
    <div style="display:grid;gap:12px;">
      <div class="glass-card" style="padding:14px;">
        ${r.subject ? `<div style="font-size:13px;font-weight:800;color:#1a0505;">${esc(r.subject)}${r.copies > 1 ? ` ×${r.copies}` : ""}</div>` : ""}
        <div style="font-size:12px;color:rgba(30,5,5,.8);margin-top:6px;white-space:pre-wrap;">${esc(r.details)}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:center;">${pill(r.status)}
          ${r.docUrl ? fileLink(r.docName, r.docUrl, "Supporting document") : ""}
          ${r.appointmentCode ? `<span style="font-size:11px;">Visit: <b>${esc(r.appointmentCode)}</b> · ${esc(r.dateLabel)} ${esc(r.time)}</span>` : ""}
          ${r.pickupDate ? `<span style="font-size:11px;color:#15803d;">Pickup: <b>${esc(r.pickupDate)} ${esc(r.pickupTime)}</b>${r.pickupNote ? ` — ${esc(r.pickupNote)}` : ""}</span>` : ""}
        </div>
        ${r.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>Remarks:</b> ${esc(r.remarks)}</div>` : ""}
      </div>
      ${wfStepperHtml("request", r)}
      <div class="app-modal-grid">
        <div class="app-field full"><label>Remarks (optional — sent to the student)</label><input id="reqrm-${r.id}" class="glass-input" value="${esc(r.remarks || "")}"></div>
      </div>
      ${r.history && r.history.length ? `<div style="font-size:10px;color:rgba(30,5,5,.55);font-family:monospace;">${r.history.map((h) => `${esc(h.ts)} — ${esc(h.status)} by ${esc(h.by)}${h.note ? ": " + esc(h.note) : ""}`).join("<br>")}</div>` : ""}
      ${wfFooterHtml("request", r.id, r, canComplete ? { primary: { label: "Mark picked up", icon: "fa-circle-check", on: `maAsk({title:'Mark picked up?',text:'This closes it out and the student is notified.',confirm:'Yes, mark picked up',danger:false,icon:'fa-circle-check',on:&quot;completePickup(\'requests\',\'${esc(r.id)}\',true)&quot;})` }, skipNext: true, more: canSchedule ? [{ label: "Reschedule pickup", icon: "fa-calendar-check", on: `closeAppModal();openPickupModal('requests','${esc(r.id)}')` }] : [] } : canSchedule ? { primary: { label: "Schedule pickup", icon: "fa-calendar-check", on: `closeAppModal();openPickupModal('requests','${esc(r.id)}')` } } : null)}
    </div>` });
}
// ── Pickup scheduling (flow spec §2): admin sets pickup, student is notified ──
function openPickupModal(kind, id) {
  openAppModal({ title: "Schedule Pickup", subtitle: "Set when the student can claim the documents. The student is notified automatically.", icon: "fa-calendar-check", content: `
    <div class="app-modal-grid">
      <div class="app-field"><label>Pickup date</label><input id="pickupDate" type="date" class="glass-input"></div>
      <div class="app-field"><label>Pickup time</label><input id="pickupTime" type="time" class="glass-input"></div>
      <div class="app-field full"><label>Note (optional)</label><input id="pickupNote" class="glass-input" placeholder="Bring one valid ID…"></div>
    </div>
    <div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="submitPickup('${kind}','${esc(id)}')">Notify student</button></div>` });
}
function pickupApi(kind, id) {
  return kind === "idapps" ? `/api/modules/idapps/${encodeURIComponent(id)}/pickup` : `/api/modules/requests/${encodeURIComponent(id)}/pickup`;
}
async function submitPickup(kind, id) {
  const pickupDate = toDateLabel(document.getElementById("pickupDate").value);
  const pickupTime = toTimeLabel(document.getElementById("pickupTime").value);
  const pickupNote = document.getElementById("pickupNote").value.trim();
  if (!pickupDate || !pickupTime) { showToast("⚠️ Please pick a pickup date and time.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api(pickupApi(kind, id), { method: "POST", body: { pickupDate, pickupTime, pickupNote } });
  if (!ok) { showToast(`❌ ${error || "Could not schedule pickup."}`, "rgba(155,22,22,.85)"); return; }
  closeAppModal();
  showToast("✅ Pickup scheduled — student notified.");
  await refreshAfterModuleChange(kind);
}
async function completePickup(kind, id, skipConfirm) {
  if (!skipConfirm && !confirm("Mark this as picked up / completed?")) return;
  const { ok, error } = await api(pickupApi(kind, id), { method: "POST", body: { action: "complete" } });
  if (!ok) { showToast(`❌ ${error || "Could not complete."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Marked as picked up.");
  closeAppModal();
  await refreshAfterModuleChange(kind);
}


/* ===== Monthly Student Bulletin: student feed + admin manage list (same shell as the other lists) ===== */
let bulletinEditingId = null;
let BL = { cat: "all", month: "", q: "", tab: "all" };
const BUL_CATS = ["Announcement", "Advisory", "Org Event", "Reminder"];
const bulWhen = (b) => +new Date(b.publishAt || b.createdAt) || 0;
function bulKind(c) { return /event|org/i.test(c || "") ? ["fa-calendar-days", "sa-ev"] : /urgent|advis|notice/i.test(c || "") ? ["fa-triangle-exclamation", "sa-ur"] : ["fa-bullhorn", "sa-an"]; }
function bulMonthKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function bulMonthLabel(key) { const [y, m] = key.split("-"); return new Date(+y, +m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }); }
function bulExcerpt(b, n) { const t = String(b.body || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n).trimEnd() + "…" : t; }
function renderBulletin() {
  const el = document.getElementById("bulletinBody"); if (!el) return;
  const nb = document.getElementById("bulNewBtn"); if (nb) nb.style.display = isAdmin() ? "" : "none";
  if (isAdmin()) renderBulletinAdmin(el); else renderBulletinStudent(el);
}
// Student feed ----------------------------------------------------------
function bulVisible() { const now = Date.now(); return MOD.bulletins.filter((b) => b.status === "Published" && (!b.publishAt || b.publishAt <= now)); }
function renderBulletinStudent(el) {
  const vis = bulVisible();
  const present = [...new Set(vis.map((b) => b.category).filter(Boolean))].sort((a, b) => (BUL_CATS.indexOf(a) + 1 || 99) - (BUL_CATS.indexOf(b) + 1 || 99));
  if (BL.cat !== "all" && !present.includes(BL.cat)) BL.cat = "all";
  const tabs = [{ key: "all", label: "View all", tip: "Every post", count: vis.length }, ...present.map((c) => ({ key: c, label: c, tip: c, count: vis.filter((b) => b.category === c).length }))];
  const months = [...new Set(vis.map((b) => bulMonthKey(bulWhen(b))))].sort().reverse();
  if (BL.month && !months.includes(BL.month)) BL.month = "";
  el.innerHTML = `<div class="ml-toolbar">${dtTabs(tabs, BL.cat, "setBulCat", true)}
      <div class="ml-tools"><div class="bk-input ml-dd"><select id="blMonth" data-dd="1" aria-label="Filter by month" onchange="setBulMonth(this.value)"><option value="">All months</option>${months.map((m) => `<option value="${m}"${BL.month === m ? " selected" : ""}>${esc(bulMonthLabel(m))}</option>`).join("")}</select></div>
      <label class="ml-search"><i class="fa-solid fa-magnifying-glass"></i><input id="blSearch" type="search" autocomplete="off" value="${esc(BL.q)}" placeholder="Search announcements" aria-label="Search announcements" oninput="bulSearch(this.value)"></label></div></div><div id="blFeed"></div>`;
  ddInitAll(el);
  drawBulletinFeed();
}
function setBulCat(k) { BL.cat = k || "all"; renderBulletinStudent(document.getElementById("bulletinBody")); }
function setBulMonth(m) { BL.month = m || ""; drawBulletinFeed(); }
function bulSearch(v) { BL.q = String(v || ""); drawBulletinFeed(); }
function bulItem(b) {
  const [ic, cls] = bulKind(b.category), ts = bulWhen(b);
  return `<button type="button" class="bl-item" onclick="viewBulletin('${esc(b.id)}')"><span class="sa-thumb ${cls}" aria-hidden="true"><i class="fa-solid ${ic}"></i></span>
    <span class="bl-body"><span class="bl-top"><b>${esc(b.title)}</b>${b.featured ? '<span class="sa-tag sa-pin"><i class="fa-solid fa-thumbtack"></i>Pinned</span>' : ""}</span>
    <span class="bl-ex">${esc(bulExcerpt(b, 170))}</span>
    <span class="bl-meta"><span class="bl-cat">${esc(b.category || "Announcement")}</span><span>${esc(bulletinAge(ts))}</span></span></span><i class="fa-solid fa-chevron-right bl-go" aria-hidden="true"></i></button>`;
}
function drawBulletinFeed() {
  const host = document.getElementById("blFeed"); if (!host) return;
  const q = esc2q(BL.q);
  let list = bulVisible().filter((b) => (BL.cat === "all" || b.category === BL.cat) && (!BL.month || bulMonthKey(bulWhen(b)) === BL.month)
    && (!q || `${b.title} ${b.body} ${b.category}`.toLowerCase().includes(q)));
  list.sort((a, b) => bulWhen(b) - bulWhen(a));
  if (!list.length) { host.innerHTML = `<div class="dt-empty ml-empty"><i class="fa-solid fa-bullhorn"></i><div>${q || BL.month || BL.cat !== "all" ? "No announcements match your filters." : "No announcements right now. Check back soon!"}</div></div>`; return; }
  const pinned = list.filter((b) => b.featured), rest = list.filter((b) => !b.featured);
  const groups = [];
  rest.forEach((b) => { const k = bulMonthKey(bulWhen(b)); const g = groups[groups.length - 1]; if (g && g.k === k) g.items.push(b); else groups.push({ k, items: [b] }); });
  host.innerHTML = (pinned.length ? `<section class="bl-sec"><h2 class="bl-h"><i class="fa-solid fa-thumbtack"></i>Pinned</h2><div class="bl-list">${pinned.map(bulItem).join("")}</div></section>` : "")
    + groups.map((g) => `<section class="bl-sec"><h2 class="bl-h">${esc(bulMonthLabel(g.k))}<span>${g.items.length}</span></h2><div class="bl-list">${g.items.map(bulItem).join("")}</div></section>`).join("");
}
function viewBulletin(id) {
  const b = MOD.bulletins.find((x) => x.id === id); if (!b) return;
  const [ic] = bulKind(b.category), ts = bulWhen(b);
  openAppModal({ title: b.title, subtitle: `${b.category || "Announcement"} · ${new Date(ts).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}${b.updatedTs ? ` · edited ${b.updatedTs}` : ""}`, icon: ic, content: `
    <div class="dm-status">${b.featured ? '<span class="sa-tag sa-pin"><i class="fa-solid fa-thumbtack"></i>Pinned</span>' : ""}<span class="bl-cat">${esc(b.category || "Announcement")}</span></div>
    <div class="bl-full">${esc(b.body || "")}</div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Close</button></div>` });
}
// Admin manage list -----------------------------------------------------
function bulState(b) { const now = Date.now(); return b.status === "Archived" ? "Archived" : (b.publishAt && b.publishAt > now) ? "Scheduled" : "Published"; }
function renderBulletinAdmin(el) {
  const all = [...MOD.bulletins].reverse();
  const tabs = [["all", "View all"], ["Published", "Published"], ["Scheduled", "Scheduled"], ["Archived", "Archived"]].map(([k, l]) => ({ key: k, label: l, tip: l, count: k === "all" ? all.length : all.filter((b) => bulState(b) === k).length }));
  el.innerHTML = `<div class="ml-toolbar">${dtTabs(tabs, BL.tab, "setBulTab", true)}<div class="ml-tools"><label class="ml-search"><i class="fa-solid fa-magnifying-glass"></i><input id="blSearchA" type="search" autocomplete="off" value="${esc(BL.q)}" placeholder="Search posts" aria-label="Search posts" oninput="bulSearchAdmin(this.value)"></label></div></div><div id="blAdminTable"></div>`;
  drawBulletinAdmin();
}
function setBulTab(k) { BL.tab = k || "all"; renderBulletinAdmin(document.getElementById("bulletinBody")); }
function bulSearchAdmin(v) { BL.q = String(v || ""); drawBulletinAdmin(); }
function drawBulletinAdmin() {
  const host = document.getElementById("blAdminTable"); if (!host) return;
  const q = esc2q(BL.q);
  const list = [...MOD.bulletins].reverse().filter((b) => (BL.tab === "all" || bulState(b) === BL.tab) && (!q || `${b.title} ${b.body} ${b.category}`.toLowerCase().includes(q)));
  const rows = list.map((b) => {
    const st = bulState(b), id = esc(b.id), when = b.publishAt && b.publishAt > Date.now() ? fnow(b.publishAt) : b.ts;
    const [d, t] = splitWhen(when);
    return `<tr class="ml-tr" tabindex="0" onclick="viewBulletin('${id}')">
      <td class="c-svc"><div class="ml-svc">${b.featured ? '<i class="fa-solid fa-thumbtack" style="color:#C9A227;margin-right:7px;font-size:12px;"></i>' : ""}${esc(b.title)}</div><div class="ml-sub2">${esc(bulExcerpt(b, 90))}</div></td>
      <td class="c-code"><span class="bl-cat">${esc(b.category || "")}</span></td>
      <td class="c-when"><div class="ml-d">${esc(d)}</div>${t ? `<div class="ml-t">${esc(t)}</div>` : ""}</td>
      <td class="c-status">${stChip(st)}</td>
      <td class="c-act" onclick="event.stopPropagation()"><div class="ml-acts">${mlAct("fa-pen", "Edit post", `openBulletinForm('${id}')`)}${mlAct(st === "Archived" ? "fa-box-open" : "fa-box-archive", st === "Archived" ? "Unarchive" : "Archive", `bulToggleArchive('${id}')`)}${mlAct("fa-trash", "Delete post", `bulDelete('${id}')`, "ml-act-bad")}</div></td></tr>`;
  });
  const cta = !q && BL.tab === "all" ? mlEmptyCta("New Post", "fa-pen-nib", "openBulletinForm") : "";
  host.innerHTML = mlTable(["Post", "Category", "Published", "Status", "Actions"], rows, q ? "No posts match your search." : "No posts here yet." + cta, "fa-bullhorn");
}
function openBulletinForm(id) {
  const p = typeof id === "string" ? MOD.bulletins.find((x) => x.id === id) : null;
  bulletinEditingId = p ? p.id : null;
  const sched = p && p.publishAt ? new Date(p.publishAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
  openAppModal({ title: p ? "Edit post" : "New post", subtitle: p ? "Changes go live as soon as you save." : "Publish now, or schedule it for later.", icon: "fa-pen-nib", wide: true, content: `
    <div class="bk-form">
      <div class="dm-two">
        ${bkField("Title", `<div class="bk-input"><input id="bulTitle" type="text" maxlength="140" placeholder="Post title" value="${esc(p ? p.title : "")}"></div>`, { req: true })}
        ${bkField("Category", `<div class="bk-input"><select id="bulCat" data-dd="1">${BUL_CATS.map((c) => `<option${p && p.category === c ? " selected" : ""}>${c}</option>`).join("")}</select></div>`, { req: true })}
      </div>
      ${bkField("Content", `<textarea id="bulBody" class="bk-ta" rows="6" placeholder="Write the announcement…">${esc(p ? p.body : "")}</textarea>`, { for: "bulBody", req: true })}
      <div class="dm-two">
        ${bkField("Schedule <span class=\"bk-opt\">(optional)</span>", `<div class="bk-input"><input id="bulSched" type="datetime-local" value="${sched}"></div>`, { help: "Leave empty to publish immediately." })}
        <div class="bk-field"><label class="bk-label">Pin to top</label><label class="bl-switch"><input id="bulFeat" type="checkbox"${p && p.featured ? " checked" : ""}><span></span>Pinned announcement</label></div>
      </div>
    </div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Cancel</button><button type="button" id="bulSaveBtn" class="bk-btn bk-btn-fill bk-btn-sm" onclick="bulSave()">${p ? "Save changes" : "Publish"}</button></div>` });
}
async function bulSave() {
  const t = document.getElementById("bulTitle").value.trim();
  const c = document.getElementById("bulCat").value;
  const b = document.getElementById("bulBody").value.trim();
  const f = document.getElementById("bulFeat").checked;
  const s = document.getElementById("bulSched").value;
  if (!t || !b) { showToast("⚠️ Title and content are required.", "rgba(180,130,0,.85)"); return; }
  const btn = document.getElementById("bulSaveBtn"); if (btn) btn.disabled = true;
  const publishAt = s ? new Date(s).toISOString() : null;
  const res = bulletinEditingId
    ? await api(`/api/modules/bulletins/${encodeURIComponent(bulletinEditingId)}`, { method: "PATCH", body: { title: t, category: c, body: b, featured: f, publishAt } })
    : await api("/api/modules/bulletins", { method: "POST", body: { title: t, category: c, body: b, featured: f, publishAt } });
  if (!res.ok) { if (btn) btn.disabled = false; showToast(`❌ ${res.error || "Could not save."}`, "rgba(155,22,22,.85)"); return; }
  bulletinEditingId = null;
  closeAppModal();
  showToast("✅ Saved.");
  await loadModule("bulletins"); renderBulletin();
}
async function bulToggleArchive(id) {
  const { ok, error } = await api(`/api/modules/bulletins/${encodeURIComponent(id)}/archive`, { method: "POST" });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("bulletins"); renderBulletin();
}
function bulDelete(id) {
  const p = MOD.bulletins.find((x) => x.id === id); if (!p) return;
  openAppModal({ title: "Delete this post?", subtitle: "This can’t be undone. Archive it instead to keep a record.", icon: "fa-trash", content: `
    <div class="dm-kvs dm-kvs-box">${dmKv("Title", p.title)}${dmKv("Category", p.category || "")}${dmKv("Published", p.ts || "")}</div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Keep post</button><button type="button" id="bulDelBtn" class="bk-btn bk-btn-danger bk-btn-sm" onclick="bulDeleteConfirm('${esc(id)}')">Delete post</button></div>` });
}
async function bulDeleteConfirm(id) {
  const btn = document.getElementById("bulDelBtn"); if (btn) btn.disabled = true;
  const { ok, error } = await api(`/api/modules/bulletins/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { if (btn) btn.disabled = false; showToast(`❌ ${error || "Could not delete."}`, "rgba(155,22,22,.85)"); return; }
  closeAppModal(); await loadModule("bulletins"); renderBulletin();
}


let chatbotMessages = [];
let chatbotEscalationQuestion = "";
let chatbotSessionId = "";
let chatbotTicketDraft = null;
let chatbotTyping = false;
// F-6 tap analytics: label of the last tapped ask-pill, sent once with the
// next chat POST (typed messages omit it).
let pendingViaPill = "";
// F-7 past chats: session list state (student helpdesk only).
let chatbotSessions = [];
let chatbotSessionsOpen = false;
let chatbotSessionQ = "";
function fmtChatTs(ts) { try { const d = new Date(ts); return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
// Enterprise 3-stage lifecycle stepper derived from status + msgs: Opened → Answered → Closed.
function ticketTimeline(t) {
  const msgs = t.msgs || [];
  const adminMsgs = msgs.filter((m) => m.from === "admin");
  const lastAdmin = adminMsgs[adminMsgs.length - 1];
  const last = msgs[msgs.length - 1];
  const closed = t.status === "Closed";
  const answered = t.status === "Answered" || adminMsgs.length > 0;
  const openState = (answered || closed) ? "is-done" : "is-current";
  const ansState = closed ? "is-done" : (answered ? "is-current" : "is-pending");
  const closeState = closed ? "is-done" : "is-pending";
  const stepHtml = (cls, icon, label, sub) => `
    <div class="tkt-step ${cls}">
      <span class="tkt-step-node"><i class="fa-solid ${cls === "is-done" ? "fa-check" : icon}"></i></span>
      <div style="min-width:0;">
        <div class="tkt-step-label">${label}</div>
        ${sub ? `<div class="tkt-step-time">${esc(sub)}</div>` : ""}
      </div>
    </div>`;
  return `
    <div class="tkt-stepper" aria-label="Ticket progress">
      ${stepHtml(openState, "fa-circle-dot", "Opened", (msgs[0] && msgs[0].ts) || t.ts || "")}
      <span class="tkt-step-line${answered || closed ? " is-done" : ""}" aria-hidden="true"></span>
      ${stepHtml(ansState, "fa-reply", "Answered", answered ? (lastAdmin ? `${lastAdmin.by || "OSS Staff"}` : "Replied") : "Awaiting staff")}
      <span class="tkt-step-line${closed ? " is-done" : ""}" aria-hidden="true"></span>
      ${stepHtml(closeState, "fa-flag-checkered", "Resolved", closed ? ((last && last.ts) || "Closed") : "Pending")}
    </div>`;
}
const chatbotStopWords = new Set(["about", "also", "and", "ang", "are", "ba", "can", "could", "does", "for", "from", "get", "how", "i", "is", "it", "ko", "mga", "need", "ng", "of", "on", "or", "please", "pwede", "sa", "the", "to", "what", "where", "when", "with", "you", "your"]);
const chatbotGenericKeywords = new Set(["request", "service", "student"]);
function chatbotKeywords(value) {
  return [...new Set((String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []).map((word) => {
    if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
    if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
    return word;
  }).filter((word) => !chatbotStopWords.has(word)))];
}
function chatbotFaqScore(faq, keywords) {
  const questionText = String(faq.q || "").toLowerCase();
  const answerText = String(faq.a || "").toLowerCase();
  const categoryText = String(faq.cat || "").toLowerCase();
  return keywords.reduce((score, word) => score
    + (questionText.includes(word) ? 3 : 0)
    + (categoryText.includes(word) ? 2 : 0)
    + (answerText.includes(word) ? 1 : 0), 0);
}
let hdMascotSvgCache = "";
let hdMascotSvgPromise = null;
let hdMascotHeadSvgCache = "";
let hdMascotHeadSvgPromise = null;
let hdMascotState = "idle";
let hdMascotResetTimer = null;
let hdMascotTypeTimer = null;

const HD_MASCOT_STATUS = {
  idle: { badge: "Ready to assist", header: "Online · Ready to help", busy: false },
  greeting: { badge: "Welcome!", header: "Online · Welcome to STARS Help Desk", busy: false },
  listening: { badge: "Listening…", header: "Listening to your question…", busy: false },
  thinking: { badge: "Looking that up…", header: "Checking records & knowledge base…", busy: true },
  typing: { badge: "Drafting reply…", header: "Preparing your answer…", busy: true },
  talking: { badge: "Here to help", header: "Online · Reply ready", busy: false },
  happy: { badge: "Glad that helped!", header: "Online · Happy to help", busy: false },
};

async function loadHelpdeskMascotSvg() {
  if (!hdMascotSvgPromise) {
    hdMascotSvgPromise = fetch("/chatbot-mascot.svg")
      .then((res) => (res.ok ? res.text() : ""))
      .then((svg) => {
        if (svg && svg.includes("<svg")) hdMascotSvgCache = svg;
        syncHelpdeskMascot();
        return hdMascotSvgCache;
      })
      .catch(() => "");
  }
  if (!hdMascotHeadSvgPromise) {
    hdMascotHeadSvgPromise = fetch("/chatbot-mascot-head.svg")
      .then((res) => (res.ok ? res.text() : ""))
      .then((svg) => {
        if (svg && svg.includes("<svg")) hdMascotHeadSvgCache = svg;
        syncHelpdeskMascot();
        return hdMascotHeadSvgCache;
      })
      .catch(() => "");
  }
  return Promise.all([hdMascotSvgPromise, hdMascotHeadSvgPromise]);
}

function setHelpdeskMascotState(state) {
  hdMascotState = HD_MASCOT_STATUS[state] ? state : "idle";
  ["hdMascotHost", "fcIntroMascotHost"].forEach((id) => {
    const host = document.getElementById(id);
    const svg = host && host.querySelector("svg.stars-mascot");
    if (svg) svg.dataset.state = hdMascotState;
  });
  const meta = HD_MASCOT_STATUS[hdMascotState] || HD_MASCOT_STATUS.idle;
  const headerEl = document.getElementById("hdLiveStatusText");
  if (headerEl) headerEl.textContent = meta.header;
  document.querySelectorAll(".hd-status-pulse").forEach((dot) => dot.classList.toggle("is-busy", !!meta.busy));
}

function triggerHelpdeskMascotState(state, durationMs) {
  if (hdMascotResetTimer) {
    clearTimeout(hdMascotResetTimer);
    hdMascotResetTimer = null;
  }
  setHelpdeskMascotState(state);
  if (durationMs && state !== "idle") {
    hdMascotResetTimer = setTimeout(() => {
      hdMascotResetTimer = null;
      if (!chatbotTyping && !fcIntroActive) setHelpdeskMascotState("idle");
    }, durationMs);
  }
}

function syncHelpdeskMascot() {
  const headHost = document.getElementById("hdMascotHost");
  if (headHost && hdMascotHeadSvgCache && !headHost.querySelector("svg.stars-mascot-head")) {
    headHost.innerHTML = hdMascotHeadSvgCache;
  }
  const introHost = document.getElementById("fcIntroMascotHost");
  if (introHost && hdMascotSvgCache && !introHost.querySelector("svg.stars-mascot")) {
    introHost.innerHTML = hdMascotSvgCache;
  }
  setHelpdeskMascotState(chatbotTyping ? "thinking" : hdMascotState);
}

function handleChatbotInputTyping(inputEl) {
  if (chatbotTyping) return;
  if (hdMascotTypeTimer) clearTimeout(hdMascotTypeTimer);
  const hasText = !!(inputEl && inputEl.value.trim());
  if (hasText) {
    setHelpdeskMascotState("listening");
    hdMascotTypeTimer = setTimeout(() => {
      hdMascotTypeTimer = null;
      if (!chatbotTyping && hdMascotState === "listening") setHelpdeskMascotState("idle");
    }, 1700);
  } else if (hdMascotState === "listening") {
    setHelpdeskMascotState("idle");
  }
}

function hdQuickTopic(prompt) {
  if (chatbotTyping || !prompt) return;
  chatbotSendToServer(prompt);
}

function tktInitials(name) {
  const parts = String(name || "U").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "U";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function tktStatusBadge(status) {
  const s = String(status || "Open");
  const cls = s === "Answered" ? "is-answered" : (s === "Closed" ? "is-closed" : "is-open");
  return `<span class="tkt-status-inline ${cls}"><span class="tkt-dot ${cls}"></span>${esc(s)}</span>`;
}

function tktCopyId(id) {
  if (!id) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id);
    }
  } catch {}
  showToast(`Copied ${id}`, "rgba(122,15,31,.92)");
}

const TKT_CANNED_REPLIES = [
  { label: "Request details", text: "Hello! Thank you for reaching out to the Office of Student Services. Could you please share any additional details or reference codes (e.g., APT-, EXC-, or IDA-) so we can verify your record right away?" },
  { label: "Ready for pickup", text: "Good day! Your request has been processed and is ready for pickup at the Office of Student Services (Mon–Fri, 8:00 AM–5:00 PM). Please bring your school ID and QR pass." },
  { label: "Resolved", text: "This concern has been addressed by the Office of Student Services. Please let us know if you need any further assistance; otherwise, we will mark this ticket as resolved." },
];

function tktInsertCanned(ticketId, idx) {
  const item = TKT_CANNED_REPLIES[idx];
  const box = document.getElementById("hdrep-" + ticketId);
  if (!item || !box) return;
  box.value = item.text;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

function hdThread(t) {
  return (t.msgs || []).map((m) => {
    const isStaff = m.from === "admin";
    const sender = m.by || (isStaff ? "OSS Personnel" : (t.name || "Student"));
    return `
      <article class="tkt-entry${isStaff ? " is-staff" : ""}">
        <header class="tkt-entry-head">
          <div class="tkt-entry-who">
            <span class="tkt-avatar" aria-hidden="true">${esc(tktInitials(sender))}</span>
            <span class="tkt-entry-name">${esc(sender)}</span>
            ${isStaff ? `<span class="tkt-entry-role">· OSS Staff</span>` : ""}
          </div>
          <span class="tkt-entry-ts">${esc(m.ts || "")}</span>
        </header>
        <div class="tkt-entry-body">${esc(m.text || "")}</div>
      </article>`;
  }).join("");
}

function hdTicketFeedback(t) {
  if (!t || !t.id) return null;
  return (typeof MY_FEEDBACK !== "undefined" && MY_FEEDBACK[t.id]) || t.feedback || null;
}

function hdStarsHtml(rating, max = 5) {
  const r = Math.min(max, Math.max(0, Math.round(Number(rating) || 0)));
  let out = `<span class="tkt-stars" aria-label="${r} out of ${max} stars">`;
  for (let i = 1; i <= max; i++) {
    out += `<i class="fa-solid fa-star${i <= r ? " is-on" : ""}" aria-hidden="true"></i>`;
  }
  return `${out}</span>`;
}

const TKT_RATE_LABELS = {
  1: "Poor",
  2: "Fair",
  3: "Good",
  4: "Very Good",
  5: "Excellent",
};

function tktGetRatingDraft(ticketId) {
  window.__tktRatingDraft = window.__tktRatingDraft || {};
  return window.__tktRatingDraft[ticketId] || { rating: 0, comment: "" };
}

function tktPickRating(ticketId, stars) {
  window.__tktRatingDraft = window.__tktRatingDraft || {};
  const existing = document.getElementById(`tktRateNote-${ticketId}`);
  const prev = window.__tktRatingDraft[ticketId] || { rating: 0, comment: "" };
  window.__tktRatingDraft[ticketId] = {
    rating: Math.min(5, Math.max(1, Number(stars) || 5)),
    comment: existing ? existing.value : prev.comment || "",
  };
  renderHelpdesk();
  requestAnimationFrame(() => {
    const noteEl = document.getElementById(`tktRateNote-${ticketId}`);
    if (noteEl && !noteEl.value) noteEl.focus();
  });
}

function tktCancelRating(ticketId) {
  if (window.__tktRatingDraft) delete window.__tktRatingDraft[ticketId];
  renderHelpdesk();
}

async function tktSubmitRating(ticketId, btn) {
  const draft = tktGetRatingDraft(ticketId);
  const rating = draft.rating;
  if (!rating || rating < 1 || rating > 5) {
    showToast("⚠️ Please select a star rating first.", "warning");
    return;
  }
  const noteEl = document.getElementById(`tktRateNote-${ticketId}`);
  const comment = (noteEl ? noteEl.value : draft.comment || "").trim().slice(0, 500);
  if (btn) btn.disabled = true;
  const res = await api("/api/feedback", {
    method: "POST",
    body: { requestId: ticketId, rating, comment },
  });
  if (btn) btn.disabled = false;
  if (!res.ok) {
    showToast(`❌ ${res.error || "Could not submit ticket rating."}`, "error");
    return;
  }
  const fb = res.data?.feedback || { requestId: ticketId, rating, comment, ts: fnow() };
  if (typeof MY_FEEDBACK !== "undefined") MY_FEEDBACK[ticketId] = fb;
  const ticketObj = (MOD.tickets || []).find((x) => x.id === ticketId);
  if (ticketObj) ticketObj.feedback = fb;
  if (window.__tktRatingDraft) delete window.__tktRatingDraft[ticketId];
  showToast("✅ Thank you for rating our support!");
  renderHelpdesk();
}

function hdReplyBox(t, who) {
  if (t.status === "Closed") {
    const fb = hdTicketFeedback(t);
    if (who === "admin") {
      return `
        <div class="tkt-closed-banner">
          <div class="tkt-closed-top">
            <span class="tkt-closed-status"><i class="fa-solid fa-circle-check"></i>Ticket closed · Student notified.</span>
            ${fb ? `
              <div class="tkt-rated-chip" title="${esc(fb.comment || `Rated ${fb.rating}/5`)}">
                ${hdStarsHtml(fb.rating)}
                <span>${fb.rating}/5</span>
                ${fb.comment ? `<span class="tkt-rated-note">“${esc(fb.comment)}”</span>` : ""}
              </div>` : `<span class="tkt-closed-muted">Awaiting student rating</span>`}
          </div>
        </div>`;
    }
    if (fb) {
      return `
        <div class="tkt-closed-banner">
          <div class="tkt-closed-top">
            <div class="tkt-closed-left">
              <span class="tkt-closed-status"><i class="fa-solid fa-circle-check"></i>Ticket closed</span>
              <span class="tkt-closed-sep" aria-hidden="true">·</span>
              <div class="tkt-rated-chip" title="${esc(fb.comment || `Rated ${fb.rating}/5`)}">
                ${hdStarsHtml(fb.rating)}
                <span>${fb.rating}/5</span>
                ${fb.comment ? `<span class="tkt-rated-note">“${esc(fb.comment)}”</span>` : `<span class="tkt-rated-thanks">Thanks for your feedback</span>`}
              </div>
            </div>
            <button type="button" class="btn-maroon tkt-bar-btn" onclick="hdNewTicket()"><i class="fa-solid fa-plus"></i><span>New Ticket</span></button>
          </div>
        </div>`;
    }
    const draft = tktGetRatingDraft(t.id);
    const activeRating = draft.rating || 0;
    return `
      <div class="tkt-closed-banner">
        <div class="tkt-closed-top">
          <div class="tkt-closed-left">
            <span class="tkt-closed-status"><i class="fa-solid fa-circle-check"></i>Ticket closed</span>
            <span class="tkt-closed-sep" aria-hidden="true">·</span>
            <div class="tkt-rate-inline" role="group" aria-label="Rate this support ticket">
              <span class="tkt-rate-prompt">Rate support</span>
              <div class="tkt-rate-stars">
                ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="tkt-rate-star${n <= activeRating ? " is-on" : ""}" onclick="tktPickRating('${esc(t.id)}',${n})" title="${n} star${n === 1 ? "" : "s"} — ${TKT_RATE_LABELS[n]}" aria-label="Rate ${n} out of 5 stars"><i class="fa-solid fa-star"></i></button>`).join("")}
              </div>
              ${activeRating ? `<span class="tkt-rate-lbl">${activeRating}/5 · ${TKT_RATE_LABELS[activeRating]}</span>` : ""}
            </div>
          </div>
          <button type="button" class="btn-ghost tkt-bar-btn" onclick="hdNewTicket()"><i class="fa-solid fa-plus"></i><span>New Ticket</span></button>
        </div>
        ${activeRating ? `
          <div class="tkt-rate-form">
            <input
              id="tktRateNote-${esc(t.id)}"
              type="text"
              class="tkt-rate-input"
              maxlength="500"
              value="${esc(draft.comment || "")}"
              placeholder="Optional feedback on how we handled this ticket…"
              oninput="window.__tktRatingDraft=window.__tktRatingDraft||{};window.__tktRatingDraft['${esc(t.id)}']={rating:${activeRating},comment:this.value};"
              onkeydown="if(event.key==='Enter'){event.preventDefault();tktSubmitRating('${esc(t.id)}', this.parentElement.querySelector('.tkt-rate-submit'));}"
            />
            <button type="button" class="btn-maroon tkt-bar-btn tkt-rate-submit" onclick="tktSubmitRating('${esc(t.id)}', this)"><i class="fa-solid fa-paper-plane"></i><span>Submit</span></button>
            <button type="button" class="tkt-rate-cancel" onclick="tktCancelRating('${esc(t.id)}')" aria-label="Cancel rating" title="Cancel"><i class="fa-solid fa-xmark"></i></button>
          </div>` : ""}
      </div>`;
  }
  const templateSel = who === "admin"
    ? `<select class="tkt-template-sel" aria-label="Insert quick reply" onchange="if(this.value!==''){tktInsertCanned('${esc(t.id)}',Number(this.value));this.value='';}"><option value="">Templates…</option>${TKT_CANNED_REPLIES.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join("")}</select>`
    : "";
  const note = who === "admin" ? "Marks Answered &amp; emails student · Ctrl+Enter" : "Ctrl+Enter to send";
  return `
    <div class="tkt-composer">
      <textarea
        id="hdrep-${esc(t.id)}"
        class="tkt-textarea"
        rows="2"
        placeholder="${who === "admin" ? "Write a reply to the student…" : "Write a reply…"}"
        onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();hdReply('${esc(t.id)}', this.parentElement.querySelector('.tkt-send-reply-btn'))}"
      ></textarea>
      <div class="tkt-composer-bar">
        <div class="tkt-composer-left">
          ${templateSel}
          <span class="tkt-composer-note">${note}</span>
        </div>
        <button type="button" onclick="hdReply('${esc(t.id)}', this)" class="btn-maroon tkt-bar-btn tkt-send-reply-btn"><i class="fa-solid fa-paper-plane"></i><span>Send</span></button>
      </div>
    </div>`;
}

function tktGetPanelsState() {
  if (!window.__tktPanels) {
    const narrow = typeof window !== "undefined" && window.innerWidth <= 1280;
    window.__tktPanels = { queue: true, inspector: !narrow };
  }
  return window.__tktPanels;
}

function tktTogglePanel(which) {
  const p = tktGetPanelsState();
  p[which] = !p[which];
  const shell = document.getElementById("tktWorkspaceShell");
  if (shell) {
    shell.classList.toggle("is-queue-collapsed", !p.queue);
    shell.classList.toggle("is-inspector-collapsed", !p.inspector);
  }
  const qBtn = document.getElementById("tktBtnToggleQueue");
  if (qBtn) {
    qBtn.classList.toggle("is-on", !!p.queue);
    qBtn.setAttribute("aria-pressed", String(!!p.queue));
  }
  const iBtn = document.getElementById("tktBtnToggleInspector");
  if (iBtn) {
    iBtn.classList.toggle("is-on", !!p.inspector);
    iBtn.setAttribute("aria-pressed", String(!!p.inspector));
  }
}

// Cleanly moves the live global notification bell & profile dropdown into the
// Help Desk's custom 48px appbar, and restores them to #appTopbar on other pages.
function tktAdoptTopbarControls(adopt) {
  const bell = document.getElementById("topBell");
  const pm = document.getElementById("profileMenu");
  if (!bell && !pm) return;
  const target = adopt
    ? document.getElementById("tktTopRightSlot")
    : document.querySelector("#appTopbar .tb-right");
  if (!target) return;
  if (bell && bell.parentElement !== target) target.appendChild(bell);
  if (pm && pm.parentElement !== target) target.appendChild(pm);
}

function tktAppbarHtml({ role, all, activeStatus, showPanelToggles }) {
  const isStaff = role === "admin";
  const countFor = (s) => all.filter((t) => t.status === s).length;
  const p = tktGetPanelsState();
  const tab = (val, label, count) => `
    <button type="button" class="tkt-tab${activeStatus === val ? " is-active" : ""}" onclick="tktSetFilter('${role}','status','${val}')">
      <span>${label}</span><span class="tkt-tab-count">${count}</span>
    </button>`;
  return `
    <header class="tkt-appbar" aria-label="Help Desk Toolbar">
      <div class="tkt-appbar-left">
        ${showPanelToggles ? `
          <button type="button" id="tktBtnToggleQueue" class="tkt-panel-toggle${p.queue ? " is-on" : ""}" onclick="tktTogglePanel('queue')" title="Toggle ticket list" aria-label="Toggle ticket list" aria-pressed="${!!p.queue}">
            <i class="fa-solid fa-table-columns"></i>
          </button>` : ""}
        <span class="tkt-appbar-title">Help Desk</span>
        <span class="tkt-appbar-div" aria-hidden="true"></span>
        <div class="tkt-tabs" role="tablist" aria-label="Filter tickets by status">
          ${tab("all", "All", all.length)}
          ${tab("Open", "Open", countFor("Open"))}
          ${tab("Answered", "Answered", countFor("Answered"))}
          ${tab("Closed", "Closed", countFor("Closed"))}
        </div>
      </div>

      <div class="tkt-appbar-right">
        ${!isStaff ? `
          <button type="button" class="btn-maroon tkt-bar-btn" onclick="hdNewTicket()" title="Create a new support ticket">
            <i class="fa-solid fa-plus"></i><span>New Ticket</span>
          </button>` : ""}
        ${showPanelToggles ? `
          <button type="button" id="tktBtnToggleInspector" class="tkt-panel-toggle${p.inspector ? " is-on" : ""}" onclick="tktTogglePanel('inspector')" title="Toggle details panel" aria-label="Toggle details panel" aria-pressed="${!!p.inspector}">
            <i class="fa-solid fa-circle-info"></i>
          </button>` : ""}
        <span class="tkt-appbar-div" aria-hidden="true"></span>
        <div id="tktTopRightSlot" class="tkt-adopted-slot"></div>
      </div>
    </header>`;
}

function renderEnterpriseTicketWorkspace(el, opts) {
  const { role, all, state, onSelectFn, searchInputId } = opts;
  const isStaff = role === "admin";
  const panels = tktGetPanelsState();
  const cats = [...new Set(all.map((t) => (t.category || "").trim()).filter(Boolean))];
  const fq = (state.q || "").toLowerCase();
  const fs = state.status || "all";
  const fc = state.category || "all";

  const visible = all.filter((t) =>
    (fs === "all" || t.status === fs) &&
    (fc === "all" || (t.category || "") === fc) &&
    (!fq || [t.name, t.sn, t.id, t.subject, t.category].some((x) => (x || "").toLowerCase().includes(fq)))
  );

  const selectedId = isStaff ? window.__hdAdminTicket : window.__hdStudentTicket;
  const open = visible.find((t) => t.id === selectedId) || visible[0] || null;
  if (open) {
    if (isStaff) window.__hdAdminTicket = open.id;
    else window.__hdStudentTicket = open.id;
  }

  const queueHtml = visible.map((t) => {
    const msgs = t.msgs || [];
    const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
    const lastTs = (lastMsg && lastMsg.ts) || t.ts || "";
    const preview = lastMsg ? (lastMsg.text || "") : "";
    const active = open && t.id === open.id;
    const dotCls = t.status === "Answered" ? "is-answered" : (t.status === "Closed" ? "is-closed" : "is-open");
    return `
      <button type="button" onclick="${onSelectFn}('${esc(t.id)}')" class="tkt-row${active ? " is-active" : ""}">
        <div class="tkt-row-top">
          <span class="tkt-row-subj">${esc(t.subject)}</span>
          <span class="tkt-row-ts"><span class="tkt-dot ${dotCls}"></span>${esc(lastTs)}</span>
        </div>
        ${preview ? `<div class="tkt-row-preview">${esc(preview)}</div>` : ""}
        <div class="tkt-row-meta"><span class="tkt-id-code">${esc(t.id)}</span> · ${esc(t.category || "General")}${isStaff && t.name ? ` · ${esc(t.name)}` : ""}</div>
      </button>`;
  }).join("");

  const mainHtml = open ? (() => {
    const t = open;
    const msgs = t.msgs || [];
    const firstTs = (msgs[0] && msgs[0].ts) || t.ts || "—";
    const lastTs = (msgs.length && msgs[msgs.length - 1].ts) || t.ts || "—";
    return `
      <section class="tkt-main" aria-label="Ticket Conversation">
        <header class="tkt-main-head">
          <div style="min-width:0;flex:1;">
            <div class="tkt-main-title">${esc(t.subject)}</div>
            <div class="tkt-main-sub">
              <button type="button" class="tkt-copy-text" onclick="tktCopyId('${esc(t.id)}')" title="Click to copy ID">${esc(t.id)}</button>
              <span>·</span>
              <span>${esc(t.category || "General")}</span>
              <span>·</span>
              ${tktStatusBadge(t.status)}
            </div>
          </div>
          ${isStaff && t.status !== "Closed" ? `<button type="button" class="btn-ghost tkt-bar-btn" onclick="hdClose('${esc(t.id)}')"><i class="fa-solid fa-check"></i><span>Close</span></button>` : ""}
        </header>

        <div class="tkt-feed">
          ${isStaff && t.chatSessionId ? `<div id="tktChatQuote" class="tkt-chat-origin"><i class="fa-solid fa-circle-notch fa-spin"></i><span>Loading linked STARS Assistant context…</span></div>` : ""}
          ${hdThread(t)}
        </div>

        ${hdReplyBox(t, role)}
      </section>

      <aside class="tkt-inspector" aria-label="Ticket Details">
        <div class="tkt-insp-head">
          <span>Details</span>
          <button type="button" class="tkt-insp-close" onclick="tktTogglePanel('inspector')" title="Hide details" aria-label="Hide details"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <dl class="tkt-props">
          <div class="tkt-prop">
            <dt>Ticket ID</dt>
            <dd><button type="button" class="tkt-copy-text" onclick="tktCopyId('${esc(t.id)}')" title="Click to copy ID">${esc(t.id)}</button></dd>
          </div>
          <div class="tkt-prop">
            <dt>Status</dt>
            <dd>${tktStatusBadge(t.status)}</dd>
          </div>
          <div class="tkt-prop">
            <dt>Category</dt>
            <dd>${esc(t.category || "General Inquiry")}</dd>
          </div>
          <div class="tkt-prop">
            <dt>Requester</dt>
            <dd>${esc(t.name || "Student")}<div style="font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-muted);font-weight:500;">${esc(t.sn || "")}</div></dd>
          </div>
          <div class="tkt-prop">
            <dt>Channel</dt>
            <dd style="font-weight:500;color:var(--text-muted);">${t.chatSessionId ? "STARS Assistant" : "Help Desk Portal"}</dd>
          </div>
          <div class="tkt-prop">
            <dt>Opened</dt>
            <dd style="font-weight:500;color:var(--text-muted);">${esc(firstTs)}</dd>
          </div>
          <div class="tkt-prop">
            <dt>Last Activity</dt>
            <dd style="font-weight:500;color:var(--text-muted);">${esc(lastTs)}</dd>
          </div>
          <div class="tkt-prop">
            <dt>Replies</dt>
            <dd style="font-weight:500;color:var(--text-muted);">${msgs.length}</dd>
          </div>
          ${t.status === "Closed" ? (() => {
            const fb = hdTicketFeedback(t);
            return `
          <div class="tkt-prop">
            <dt>Rating</dt>
            <dd>${fb ? `<div class="tkt-insp-rating">${hdStarsHtml(fb.rating)}<span>${fb.rating}/5</span></div>${fb.comment ? `<div class="tkt-insp-comment">“${esc(fb.comment)}”</div>` : ""}` : `<span style="font-weight:500;color:var(--text-muted);">Not rated yet</span>`}</dd>
          </div>`;
          })() : ""}
        </dl>
      </aside>`;
  })() : `
    <section class="tkt-main" style="justify-content:center;align-items:center;padding:36px;">
      ${emptyState(all.length ? "No tickets match your filters." : "No support tickets yet.")}
    </section>
    <aside class="tkt-inspector" aria-label="Ticket Details">
      <div class="tkt-insp-head">
        <span>Details</span>
        <button type="button" class="tkt-insp-close" onclick="tktTogglePanel('inspector')" aria-label="Hide details"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div style="padding:16px 14px;font-size:12px;color:var(--text-muted);">Select a ticket to view details.</div>
    </aside>`;

  // Rescue global bell & profile controls before replacing innerHTML
  tktAdoptTopbarControls(false);
  el.innerHTML = `
    <div class="tkt-app">
      ${tktAppbarHtml({ role, all, activeStatus: fs, showPanelToggles: true })}
      <div id="tktWorkspaceShell" class="tkt-shell${!panels.queue ? " is-queue-collapsed" : ""}${!panels.inspector ? " is-inspector-collapsed" : ""}">
        <aside class="tkt-queue" aria-label="Ticket Queue">
          <div class="tkt-queue-head">
            <div class="tkt-search-wrap">
              <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
              <input
                id="${searchInputId}"
                type="text"
                placeholder="${isStaff ? "Search tickets or student…" : "Search tickets…"}"
                value="${esc(state.q || "")}"
                oninput="tktSetSearch('${role}',this.value,'${searchInputId}')"
              />
            </div>
            ${cats.length > 1 ? `
              <select class="tkt-select" aria-label="Filter by category" onchange="tktSetFilter('${role}','category',this.value)">
                <option value="all"${fc === "all" ? " selected" : ""}>All categories</option>
                ${cats.map((c) => `<option value="${esc(c)}"${fc === c ? " selected" : ""}>${esc(c)}</option>`).join("")}
              </select>` : ""}
          </div>
          <div class="tkt-queue-list">
            ${queueHtml || `<div style="padding:24px 14px;text-align:center;font-size:12px;color:var(--text-muted);">${all.length ? "No matching tickets." : "No tickets yet."}</div>`}
          </div>
        </aside>
        ${mainHtml}
      </div>
    </div>`;
  tktAdoptTopbarControls(true);

  requestAnimationFrame(() => {
    el.querySelectorAll(".tkt-feed").forEach((b) => { b.scrollTop = b.scrollHeight; });
    if (isStaff && open && open.chatSessionId) loadTicketChatQuote(open.chatSessionId);
  });
}

function tktGetFilterState(role) {
  if (role === "admin") {
    window.__hdAdminFilter = window.__hdAdminFilter || { q: hdAdminQ || "", status: window.__hdAdminStatus || "all", category: "all", sort: "newest" };
    return window.__hdAdminFilter;
  }
  window.__hdTicketFilter = window.__hdTicketFilter || { q: "", status: "all", category: "all", sort: "newest" };
  return window.__hdTicketFilter;
}

function tktSetFilter(role, key, val) {
  const st = tktGetFilterState(role);
  st[key] = val;
  if (role === "admin" && key === "status") window.__hdAdminStatus = val;
  renderHelpdesk();
}

function tktToggleSort(role) {
  const st = tktGetFilterState(role);
  st.sort = st.sort === "oldest" ? "newest" : "oldest";
  renderHelpdesk();
}

function tktSetSearch(role, val, inputId) {
  const st = tktGetFilterState(role);
  st.q = val;
  if (role === "admin") hdAdminQ = val;
  renderHelpdesk();
  const i = document.getElementById(inputId);
  if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

function renderHelpdesk() {
  const el = document.getElementById("helpdeskBody");
  if (!el) return;
  if (isAdmin()) {
    const all = [...(MOD.tickets || [])].reverse();
    const state = tktGetFilterState("admin");
    renderEnterpriseTicketWorkspace(el, {
      role: "admin",
      all,
      state,
      onSelectFn: "hdAdminTicketDetail",
      searchInputId: "hdAdminQBox",
    });
  } else {
    renderStudentTicketsInto(el);
  }
}

/* ============================================================
   GLOBAL FLOATING MASCOT CHATBOT
   - Visible on Login page (Guest / limited mode) + all Student pages
   - Single continuous conversation; clear locally anytime
   - Tickets created only when escalated or requested
   ============================================================ */
let fcOpen = false;
let fcContextKey = "";
let fcIntroActive = false;
let fcIntroBeat = 0;
let fcIntroTimer = null;

function fcIntroStorageKey() {
  return `starsMascotIntroSeen:${isGuestChatbotMode() ? "guest" : (session && session.id) || "student"}`;
}

function fcHasSeenIntro() {
  try { return sessionStorage.getItem(fcIntroStorageKey()) === "1"; } catch { return false; }
}

function fcMarkIntroSeen() {
  try { sessionStorage.setItem(fcIntroStorageKey(), "1"); } catch {}
}

function fcClearIntroTimer() {
  if (fcIntroTimer) {
    clearTimeout(fcIntroTimer);
    fcIntroTimer = null;
  }
}

function fcIntroBeats() {
  const guest = isGuestChatbotMode();
  const firstName = !guest ? ((session && session.name) || "").trim().split(/\s+/)[0] : "";
  return [
    {
      state: "greeting",
      icon: "fa-wand-magic-sparkles",
      tag: "PUP San Pedro · STARS",
      title: firstName ? `Hi ${firstName}! I'm your STARS Assistant` : "Hi there! I'm your STARS Assistant",
      desc: "Headphones on, laptop ready — your friendly Student Services companion.",
    },
    {
      state: "listening",
      icon: "fa-headphones",
      tag: "Always Listening",
      title: "Ask in English or Tagalog",
      desc: "Type naturally and I'll walk you through every step — no waiting in line.",
    },
    {
      state: "typing",
      icon: "fa-laptop-code",
      tag: guest ? "Instant Sign-In Help" : "Fast Live Lookup",
      title: guest ? "Sign-In, OTP & QR Pass Guide" : "Live Status & Offline QR Passes",
      desc: guest
        ? "Get instant help registering with Gmail OTP, resetting passwords, or checking QR passes."
        : "Paste APT-, EXC-, IDA-, or TKT- codes to check progress or open a ticket when you need OSS staff.",
    },
    {
      state: "happy",
      icon: "fa-star",
      tag: "Ready When You Are",
      title: "What shall we start with?",
      desc: "Pick a suggested option below or jump straight into the conversation.",
    },
  ];
}

function fcStartIntro() {
  fcClearIntroTimer();
  const prefersReduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  fcIntroActive = true;
  fcIntroBeat = prefersReduced ? 3 : 0;
  loadHelpdeskMascotSvg();
  renderFloatingChatbot();
  fcApplyIntroBeat(fcIntroBeat);
  if (!prefersReduced) {
    fcScheduleNextIntroBeat();
  }
}

function fcScheduleNextIntroBeat() {
  fcClearIntroTimer();
  if (!fcIntroActive || !fcOpen || fcIntroBeat >= 3) return;
  fcIntroTimer = setTimeout(() => {
    fcIntroTimer = null;
    if (!fcIntroActive || !fcOpen) return;
    fcIntroBeat = Math.min(3, fcIntroBeat + 1);
    fcUpdateIntroDom();
    if (fcIntroBeat < 3) fcScheduleNextIntroBeat();
  }, 2800);
}

function fcApplyIntroBeat(index) {
  const beats = fcIntroBeats();
  const beat = beats[index] || beats[beats.length - 1];
  setHelpdeskMascotState(beat.state);
}

function fcUpdateIntroDom() {
  const beats = fcIntroBeats();
  const beat = beats[fcIntroBeat] || beats[beats.length - 1];
  fcApplyIntroBeat(fcIntroBeat);

  document.querySelectorAll(".fc-intro-bar").forEach((bar, i) => {
    bar.classList.remove("is-done", "is-active", "is-hold");
    if (i < fcIntroBeat) bar.classList.add("is-done");
    else if (i === fcIntroBeat) bar.classList.add(fcIntroBeat === 3 ? "is-hold" : "is-active");
  });

  const copyEl = document.getElementById("fcIntroCopy");
  if (copyEl) {
    copyEl.style.animation = "none";
    void copyEl.offsetWidth;
    copyEl.style.animation = "";
    copyEl.innerHTML = `
      <span class="fc-intro-tag"><i class="fa-solid ${beat.icon}"></i> ${esc(beat.tag)}</span>
      <h3 class="fc-intro-title">${esc(beat.title)}</h3>
      <p class="fc-intro-desc">${esc(beat.desc)}</p>`;
  }

  const dockEl = document.getElementById("fcIntroDock");
  if (dockEl && fcIntroBeat >= 3 && !dockEl.dataset.ready) {
    dockEl.dataset.ready = "1";
    dockEl.innerHTML = fcIntroDockHtml();
  }
}

function fcAdvanceIntroManual() {
  if (!fcIntroActive) return;
  if (fcIntroBeat < 3) {
    fcIntroBeat += 1;
    fcUpdateIntroDom();
    if (fcIntroBeat < 3) fcScheduleNextIntroBeat();
    else fcClearIntroTimer();
  } else {
    triggerHelpdeskMascotState("happy", 1400);
  }
}

function fcIntroDockHtml() {
  const pills = isGuestChatbotMode() ? GUEST_STARTER_PILLS : CHATBOT_STARTER_PILLS;
  return `
    <div class="fc-intro-pills">
      ${pills.map((p, i) => `<button type="button" class="fc-intro-pill" style="--i:${i}" onclick="fcIntroPickPill(${i})"><i class="${chatbotPillIcon(p.action)}"></i>${esc(p.label)}</button>`).join("")}
    </div>
    <button type="button" class="btn-maroon fc-intro-cta" onclick="fcFinishIntro(false)">
      <span>Start Conversation</span><i class="fa-solid fa-arrow-right"></i>
    </button>`;
}

function fcFinishIntro(immediate) {
  fcClearIntroTimer();
  fcMarkIntroSeen();
  const introEl = document.querySelector(".fc-intro");
  const complete = () => {
    fcIntroActive = false;
    ensureChatbotWelcome();
    triggerHelpdeskMascotState("greeting", 1400);
    renderFloatingChatbot();
    requestAnimationFrame(() => {
      const input = document.getElementById("chatbotInput");
      if (input) input.focus();
    });
  };
  if (!immediate && introEl && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    introEl.classList.add("is-exiting");
    setTimeout(complete, 320);
  } else {
    complete();
  }
}

function fcIntroPickPill(pillIdx) {
  const pills = isGuestChatbotMode() ? GUEST_STARTER_PILLS : CHATBOT_STARTER_PILLS;
  const p = pills[pillIdx];
  fcClearIntroTimer();
  fcMarkIntroSeen();
  const introEl = document.querySelector(".fc-intro");
  const launch = () => {
    fcIntroActive = false;
    ensureChatbotWelcome();
    renderFloatingChatbot();
    if (!p || !p.action) return;
    const a = p.action;
    if (a.type === "navigate") {
      if (!/^page-[a-z0-9-]+$/.test(a.target || "") || !document.getElementById(a.target)) return;
      closeFloatingChatbot();
      goTo(a.target, a.params ? { params: a.params } : undefined);
      return;
    }
    if (a.type === "ask" && (a.prompt || "").trim()) {
      pendingViaPill = p.label || "";
      chatbotSendToServer(a.prompt.trim());
    }
  };
  if (introEl && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    introEl.classList.add("is-exiting");
    setTimeout(launch, 300);
  } else {
    launch();
  }
}

function fcReplayIntro() {
  if (chatbotTyping) return;
  fcStartIntro();
}

const GUEST_STARTER_PILLS = [
  { label: "How to register", action: { type: "ask", prompt: "How do I register for a STARS account?" } },
  { label: "Forgot password", action: { type: "ask", prompt: "I forgot my password, how do I reset it?" } },
  { label: "What is a QR pass?", action: { type: "ask", prompt: "What is the offline QR pass and how do I scan it?" } },
  { label: "Available services", action: { type: "ask", prompt: "What services are available in STARS?" } },
];

const GUEST_LOGIN_REQUIRED_PILLS = [
  { label: "Go to Sign In", action: { type: "guest_login" } },
  { label: "Register Account", action: { type: "guest_register" } },
  { label: "Scan QR Pass", action: { type: "guest_scan_qr" } },
];

function isGuestChatbotMode() {
  return !(session && session.role === "student");
}

function shouldShowFloatingChatbot(pageId) {
  const activeId = pageId || document.querySelector(".page.active")?.id || "page-login";
  if (session && session.role === "student") {
    return !["page-login", "page-register"].includes(activeId);
  }
  return !session && activeId === "page-login";
}

function ensureChatbotWelcome() {
  if (chatbotMessages.length) return;
  if (isGuestChatbotMode()) {
    chatbotMessages = [{
      from: "bot",
      text: "Hi! I'm the **STARS Assistant** *(Guest Mode)*.\n\nI can help with signing in, registering with Gmail OTP, password reset, QR passes, and general PUP San Pedro Student Services info.\n\nFor personal status checks, bookings, or support tickets, please **log in first**.",
      ts: Date.now(),
      pills: GUEST_STARTER_PILLS,
    }];
  } else {
    const firstName = ((session && session.name) || "").trim().split(/\s+/)[0];
    const greetingPrefix = firstName ? `Hello, **${firstName}**! ` : "Hello! ";
    chatbotMessages = [{
      from: "bot",
      text: `${greetingPrefix}I'm your **STARS Assistant**.\n\nAsk about appointments, offline QR passes, Student IDs, excuse slips, or paste a reference code (\`APT-\`, \`EXC-\`, \`IDA-\`, \`TKT-\`) to check live status.`,
      ts: Date.now(),
      pills: CHATBOT_STARTER_PILLS,
    }];
  }
}

function syncFloatingChatbotVisibility(pageId) {
  const root = document.getElementById("starsFloatingChat");
  if (!root) return;
  const visible = shouldShowFloatingChatbot(pageId);
  if (!visible) {
    fcClearIntroTimer();
    fcIntroActive = false;
    fcOpen = false;
    root.style.display = "none";
    return;
  }
  const nextKey = session && session.role === "student" ? `student:${session.id}` : "guest";
  if (fcContextKey && fcContextKey !== nextKey) {
    // Switching between guest and student (or between accounts) starts fresh cleanly
    fcClearIntroTimer();
    fcIntroActive = false;
    chatbotSessionId = "";
    chatbotMessages = [];
    chatbotTyping = false;
    chatbotEscalationQuestion = "";
    chatbotTicketDraft = null;
    fcOpen = false;
  }
  fcContextKey = nextKey;
  root.style.display = "flex";
  loadHelpdeskMascotSvg();
  renderFloatingChatbot();
}

function openFloatingChatbot() {
  if (!shouldShowFloatingChatbot()) return;
  fcOpen = true;
  loadHelpdeskMascotSvg();
  if (!fcHasSeenIntro() && !chatbotMessages.length) {
    fcStartIntro();
    return;
  }
  fcIntroActive = false;
  ensureChatbotWelcome();
  triggerHelpdeskMascotState("greeting", 1800);
  renderFloatingChatbot();
  requestAnimationFrame(() => {
    const input = document.getElementById("chatbotInput");
    if (input) input.focus();
  });
}

function closeFloatingChatbot() {
  fcClearIntroTimer();
  fcIntroActive = false;
  fcOpen = false;
  renderFloatingChatbot();
}

function toggleFloatingChatbot() {
  if (fcOpen) closeFloatingChatbot();
  else openFloatingChatbot();
}

function clearChatbotHistory() {
  if (chatbotTyping) return;
  chatbotSessionId = "";
  chatbotMessages = [];
  chatbotEscalationQuestion = "";
  chatbotTicketDraft = null;
  ensureChatbotWelcome();
  triggerHelpdeskMascotState("greeting", 1800);
  renderFloatingChatbot();
  showToast("Chat history cleared.", "rgba(122,15,31,.92)");
}

function hdOpenTicketFromChat() {
  if (isGuestChatbotMode()) {
    chatbotMessages.push({
      from: "bot",
      text: "Submitting a support ticket requires an account. Please **log in first** to submit and track tickets with Office of Student Services staff.",
      ts: Date.now(),
      pills: GUEST_LOGIN_REQUIRED_PILLS,
    });
    renderFloatingChatbot();
    return;
  }
  closeFloatingChatbot();
  openTicketDraftModal(chatbotTicketDraft || null, chatbotSessionId ? { chatSessionId: chatbotSessionId } : {});
}

function renderFloatingChatbot() {
  const root = document.getElementById("starsFloatingChat");
  if (!root || root.style.display === "none") return;
  const guest = isGuestChatbotMode();
  if (!fcOpen) {
    root.innerHTML = `
      <button type="button" class="fc-launcher" onclick="openFloatingChatbot()" aria-label="Open STARS Support Assistant">
        <span class="fc-launcher-mascot">
          <img src="/chatbot-mascot-head.svg" alt="" />
          <span class="fc-launcher-dot" aria-hidden="true"></span>
        </span>
        <span class="fc-launcher-copy">
          <span class="fc-launcher-title">STARS Assistant</span>
          <span class="fc-launcher-sub">${guest ? "Sign-in & quick help" : "Ask a question"}</span>
        </span>
      </button>`;
    return;
  }

  // First-open cinematic full-body mascot showcase before transitioning to normal chat
  if (fcIntroActive) {
    const beats = fcIntroBeats();
    const beat = beats[fcIntroBeat] || beats[0];
    const fullBodyMarkup = hdMascotSvgCache || `<img src="/chatbot-mascot.svg" alt="STARS Assistant Mascot" />`;
    const barsHtml = beats.map((_, i) => {
      const cls = i < fcIntroBeat ? "is-done" : (i === fcIntroBeat ? (fcIntroBeat === 3 ? "is-hold" : "is-active") : "");
      return `<span class="fc-intro-bar ${cls}"><i></i></span>`;
    }).join("");
    root.innerHTML = `
      <section class="fc-panel" role="dialog" aria-label="Meet STARS Support Assistant">
        <div class="fc-intro">
          <div class="fc-intro-top">
            <div class="fc-intro-bars" aria-hidden="true">${barsHtml}</div>
            <div class="fc-intro-controls">
              <button type="button" class="fc-intro-skip" onclick="fcFinishIntro(false)">Skip</button>
              <button type="button" class="fc-intro-close" onclick="closeFloatingChatbot()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
          </div>

          <div class="fc-intro-stage">
            <div class="fc-intro-halo">
              <div class="fc-intro-glow" aria-hidden="true"></div>
              <div class="fc-intro-ring" aria-hidden="true"></div>
              <div id="fcIntroMascotHost" class="fc-intro-mascot" onclick="fcAdvanceIntroManual()" title="Tap mascot for next expression">${fullBodyMarkup}</div>
              <div class="fc-intro-shadow" aria-hidden="true"></div>
            </div>
            <div id="fcIntroCopy" class="fc-intro-copy">
              <span class="fc-intro-tag"><i class="fa-solid ${beat.icon}"></i> ${esc(beat.tag)}</span>
              <h3 class="fc-intro-title">${esc(beat.title)}</h3>
              <p class="fc-intro-desc">${esc(beat.desc)}</p>
            </div>
          </div>

          <div id="fcIntroDock" class="fc-intro-dock"${fcIntroBeat >= 3 ? ' data-ready="1"' : ""}>
            ${fcIntroBeat >= 3
              ? fcIntroDockHtml()
              : `<button type="button" class="btn-ghost fc-intro-cta" onclick="fcFinishIntro(false)" style="font-size:12px;padding:9px 14px;"><span>Jump straight to chat</span><i class="fa-solid fa-arrow-right"></i></button>`}
          </div>
        </div>
      </section>
      <button type="button" class="fc-launcher" onclick="closeFloatingChatbot()" aria-label="Minimize STARS Support Assistant" style="padding:6px;">
        <span class="fc-launcher-mascot" style="width:42px;height:38px;">
          <img src="/chatbot-mascot-head.svg" alt="" />
        </span>
      </button>`;
    loadHelpdeskMascotSvg();
    syncHelpdeskMascot();
    fcApplyIntroBeat(fcIntroBeat);
    return;
  }

  ensureChatbotWelcome();
  const activeStateKey = chatbotTyping ? "thinking" : hdMascotState;
  const statusMeta = HD_MASCOT_STATUS[activeStateKey] || HD_MASCOT_STATUS.idle;
  const headMarkup = hdMascotHeadSvgCache || `<img src="/chatbot-mascot-head.svg" alt="STARS Assistant" />`;
  const renderMsg = (m, idx) => {
    const isUser = m.from === "user";
    const fbHtml = guest ? "" : chatbotFeedbackHtml(m, idx);
    return `
    <div class="hd-msg-row ${isUser ? "is-user" : "is-bot"}">
      ${isUser ? "" : `<div class="hd-msg-avatar" aria-hidden="true"><img src="/chatbot-mascot-head.svg" alt="" /></div>`}
      <div class="hd-msg-col">
        <div class="hd-bubble">${fmtChatText(m.text)}${chatbotCardsHtml(m)}${chatbotPillsHtml(m, idx)}${chatbotFollowHtml(m, idx)}</div>
        <div class="hd-msg-meta">
          ${m.ts ? `<span class="hd-msg-time">${esc(fmtChatTs(m.ts))}</span>` : "<span></span>"}
          ${fbHtml}
        </div>
      </div>
    </div>`;
  };

  root.innerHTML = `
    <section class="fc-panel" role="dialog" aria-label="STARS Support Assistant">
      <header class="fc-header">
        <div class="fc-header-id">
          <div id="hdMascotHost" class="fc-header-mascot">${headMarkup}</div>
          <div style="min-width:0;">
            <div class="fc-header-name">
              <span>STARS Assistant</span>
              ${guest ? `<span class="fc-guest-pill">Guest</span>` : ""}
            </div>
            <div class="fc-header-status">
              <span class="hd-status-pulse${statusMeta.busy ? " is-busy" : ""}" aria-hidden="true"></span>
              <span id="hdLiveStatusText">${esc(statusMeta.header)}</span>
            </div>
          </div>
        </div>
        <div class="fc-header-actions">
          <button type="button" class="fc-head-btn" onclick="fcReplayIntro()" title="Replay mascot intro" aria-label="Replay mascot intro">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
          </button>
          <button type="button" class="fc-head-btn" onclick="clearChatbotHistory()" title="Clear chat history" aria-label="Clear chat history">
            <i class="fa-solid fa-trash-can"></i>
          </button>
          <button type="button" class="fc-head-btn" onclick="closeFloatingChatbot()" title="Close assistant" aria-label="Close assistant">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </header>

      <div id="chatbotMessages" class="fc-messages" role="log" aria-live="polite">
        ${chatbotMessages.map(renderMsg).join("")}
        ${chatbotTyping ? `
          <div class="hd-msg-row is-bot">
            <div class="hd-msg-avatar" aria-hidden="true"><img src="/chatbot-mascot-head.svg" alt="" /></div>
            <div class="hd-typing-bubble">
              <span class="hd-typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
              <span>Checking…</span>
            </div>
          </div>` : ""}
      </div>

      <footer class="fc-composer">
        <div class="hd-composer-box">
          <input
            id="chatbotInput"
            class="hd-composer-input"
            type="text"
            autocomplete="off"
            placeholder="${guest ? "Ask about login, registration, QR pass…" : "Ask a question or paste APT- / TKT- code…"}"
            oninput="handleChatbotInputTyping(this)"
            onkeydown="if(event.key==='Enter'){event.preventDefault();chatbotAsk();}"
          />
          <button type="button" onclick="chatbotAsk()" class="btn-maroon hd-send-btn"${chatbotTyping ? " disabled" : ""}>
            <i class="fa-solid fa-paper-plane"></i>
          </button>
        </div>
        <div class="fc-composer-foot">
          ${guest
            ? `<span>Guest mode · Limited features</span><button type="button" class="hd-link-btn" onclick="fcFocusLogin()">Log in for full access →</button>`
            : `<span>Need OSS staff?</span><button type="button" class="hd-link-btn" onclick="hdOpenTicketFromChat()">Create a ticket →</button>`}
        </div>
      </footer>
    </section>
    <button type="button" class="fc-launcher" onclick="closeFloatingChatbot()" aria-label="Minimize STARS Support Assistant" style="padding:6px;">
      <span class="fc-launcher-mascot" style="width:42px;height:38px;">
        <img src="/chatbot-mascot-head.svg" alt="" />
      </span>
    </button>`;
  loadHelpdeskMascotSvg();
  syncHelpdeskMascot();
  requestAnimationFrame(() => {
    const box = document.getElementById("chatbotMessages");
    if (box) box.scrollTop = box.scrollHeight;
  });
}

function fcFocusLogin() {
  closeFloatingChatbot();
  const inp = document.getElementById("loginUser");
  if (inp) { inp.scrollIntoView({ behavior: "smooth", block: "center" }); inp.focus(); }
}

function chatbotAnswerGuest(question) {
  const q = (question || "").trim();
  const low = q.toLowerCase();

  // 1. Account-only / unavailable features on login page -> prompt to log in first
  const hasRefCode = /\b(apt|exc|ida|tkt|req|ref|evt|cmp)-\w+/i.test(q);
  const asksProtected =
    hasRefCode ||
    /\b(my\s+(status|appointment|appointments|request|requests|ticket|tickets|id|qr|pass|schedule|record|records|complaint|complaints|excuse|slip)|check\s+(my|status)|track\s+(my|status)|book\s+an?\s+appointment|schedule\s+a?\s*visit|reschedule|cancel\s+(my|an?)\s*(appointment|request|ticket)|submit\s+a?\s*(ticket|request|complaint|excuse)|create\s+a?\s*ticket|open\s+a?\s*ticket|file\s+a?\s*(ticket|complaint|request|excuse)|talk\s+to\s+(staff|admin|agent|human)|need\s+oss\s+staff|paano\s+tingnan\s+ang\s+status|status\s+ng|mag-?book|mag-?file|gumawa\s+ng\s+ticket)\b/i.test(low);

  if (asksProtected) {
    chatbotMessages.push({
      from: "bot",
      text: "That feature isn't available in Guest Mode. Please **log in first** with your student number or email and password to check personal records, book appointments, or submit a support ticket.\n\nIf you just want to check an appointment pass without signing in, you can use **Scan QR Pass** right on the login page.",
      ts: Date.now(),
      pills: GUEST_LOGIN_REQUIRED_PILLS,
    });
    triggerHelpdeskMascotState("talking", 1800);
    renderFloatingChatbot();
    return;
  }

  // 2. Allowed public guest topics
  let reply = "";
  let pills = GUEST_STARTER_PILLS;
  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening)|kumusta|kamusta)\b/i.test(low)) {
    reply = "Hello! I'm the **STARS Assistant** *(Guest Mode)*. I can help you sign in, register an account, reset your password, or explain how QR passes and PUP San Pedro Student Services work.";
  } else if (/\b(thanks|thank\s+you|salamat|ty)\b/i.test(low)) {
    reply = "You're welcome! Let me know if you need help signing in or registering.";
  } else if (/\b(register|sign\s*up|create\s*account|new\s*account|otp|gmail|walang\s*account|paano\s*mag-?register)\b/i.test(low)) {
    reply = "**How to register for STARS:**\n1. Click **Register here** below the Log In button.\n2. Enter your student number, name, and active email, then click **Send OTP**.\n3. Enter the 6-digit code sent to your email (check Spam if needed).\n4. Set your password and press **Create Account** — you can log in right away.";
    pills = [
      { label: "Register Account", action: { type: "guest_register" } },
      { label: "How to log in", action: { type: "ask", prompt: "How do I log in?" } },
    ];
  } else if (/\b(forgot|reset|password|nakalimutan|lock|locked)\b/i.test(low)) {
    reply = "**Password & Login Help:**\n1. Enter your student number or email in the first field on the login card.\n2. Click **Forgot Password?** and follow the reset instructions sent to your email.\n3. If your account is temporarily locked from too many attempts, wait a few minutes and try again, or visit the **Student Services Office** with your school ID.";
    pills = [
      { label: "Go to Sign In", action: { type: "guest_login" } },
      { label: "How to register", action: { type: "ask", prompt: "How do I register for a STARS account?" } },
    ];
  } else if (/\b(log\s*in|sign\s*in|paano\s*mag-?log)\b/i.test(low)) {
    reply = "**How to log in:**\nEnter your **student number or registered email** and your password on the sign-in card, then click **Log In**. You can use the eye icon to verify your password before submitting.";
    pills = [
      { label: "Go to Sign In", action: { type: "guest_login" } },
      { label: "Forgot password", action: { type: "ask", prompt: "I forgot my password, how do I reset it?" } },
    ];
  } else if (/\b(qr|pass|scan|offline)\b/i.test(low)) {
    reply = "**About Offline QR Passes:**\nOnce you schedule a visit or document pickup inside your account, STARS generates a QR pass you can save or screenshot for offline use at the office.\n\nAlready have a QR pass? Click **Scan QR Pass** right on this login page to check its status without logging in.";
    pills = [
      { label: "Scan QR Pass", action: { type: "guest_scan_qr" } },
      { label: "Go to Sign In", action: { type: "guest_login" } },
    ];
  } else if (/\b(service|services|offer|what\s+can|ano\s+ang|hours|office|open|location|where|saan|contact|stars)\b/i.test(low)) {
    reply = "**PUP San Pedro — Office of Student Services (STARS):**\nOnce signed in, students can:\n• **Schedule Visits** and get offline QR passes\n• **File Requests** (Excuse Slips, Document Authentication, Student ID Applications, Referrals, Events)\n• **Submit Support Tickets** to OSS staff and track status in real time\n\nOffice visits follow regular campus hours (**Mon–Fri, 8:00 AM–5:00 PM**). Log in to get started.";
    pills = [
      { label: "Go to Sign In", action: { type: "guest_login" } },
      { label: "Register Account", action: { type: "guest_register" } },
    ];
  } else {
    reply = "In **Guest Mode**, I can only answer general sign-in, registration, QR pass, and portal questions.\n\nPlease **log in first** to use the full STARS Assistant, check personal records, or submit a support ticket to OSS staff.";
    pills = GUEST_LOGIN_REQUIRED_PILLS;
  }

  chatbotMessages.push({ from: "bot", text: reply, ts: Date.now(), pills });
  triggerHelpdeskMascotState("talking", 1800);
  renderFloatingChatbot();
}

function renderActiveChatbotUi() {
  renderFloatingChatbot();
}

async function chatbotAsk() {
  const input = document.getElementById("chatbotInput");
  if (!input || chatbotTyping) return;
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  await chatbotSendToServer(question);
}
// F-2 per-answer feedback: one tap votes, re-tap removes (server toggles).
function chatbotFeedbackHtml(m, idx) {
  if (m.from !== "bot" || !m.feedbackId) return "";
  const btn = (v, icon, title) => `<button type="button" onclick="chatbotFeedback(${idx},${v})" title="${title}" aria-label="${title}" class="hd-fb-btn${m.fb === v ? " is-active" : ""}"><i class="fa-solid ${icon}"></i></button>`;
  return `<div class="hd-feedback">${btn(1, "fa-thumbs-up", "Helpful")}${btn(-1, "fa-thumbs-down", "Not helpful")}</div>`;
}
async function chatbotFeedback(idx, value) {
  const m = chatbotMessages[idx];
  if (!m || !m.feedbackId) return;
  const res = await api("/api/assistant/feedback", { method: "POST", body: { chatMessageId: m.feedbackId, value } });
  if (!res.ok) { showToast(`❌ ${res.error || "Could not save feedback."}`, "rgba(155,22,22,.85)"); return; }
  m.fb = res.data && res.data.value ? res.data.value : 0;
  if (m.fb === 1) triggerHelpdeskMascotState("happy", 2400);
  renderActiveChatbotUi();
}
// F-3 follow-up: one muted next-step line + tappable pill under the cards.
function chatbotFollowHtml(m, idx) {
  const f = m.followUp;
  if (!f || !f.prompt) return "";
  const label = (f.pill && f.pill.label) || f.prompt;
  return `<div class="hd-followup"><span>Suggested next step:</span><button type="button" onclick="chatbotFollowClick(${idx})" class="btn-ghost hd-pill-btn">${esc(label)}</button></div>`;
}
function chatbotFollowClick(idx) {
  const m = chatbotMessages[idx];
  const f = m && m.followUp;
  if (!f || chatbotTyping) return;
  pendingViaPill = (f.pill && f.pill.label) || f.prompt;
  chatbotSendToServer(f.prompt);
}
// Local fallback when the assistant API is unreachable: same keyword
// scoring the server uses (Phase 0), without persistence or ticketing link.
function chatbotAnswerLocal(question) {
  const words = chatbotKeywords(question);
  const specificWords = words.filter((word) => !chatbotGenericKeywords.has(word));
  const scored = MOD.faqs.map((faq) => ({ faq, score: chatbotFaqScore(faq, words), specificScore: chatbotFaqScore(faq, specificWords) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const minimumScore = words.length > 1 ? 2 : 3;
  const isRelevant = best?.score >= minimumScore && (!specificWords.length || best.specificScore > 0);
  api("/api/faq-analytics", { method: "POST", body: { faqId: isRelevant ? best.faq.id : "unmatched" } });
  if (isRelevant) {
    chatbotMessages.push({ from: "bot", text: best.faq.a, ts: Date.now(), links: [], cards: [], pills: [], feedbackId: null, fb: 0, followUp: null });
  } else {
    chatbotEscalationQuestion = question;
    chatbotMessages.push({ from: "bot", text: "I don't have enough information to answer that accurately.\n\nYou can create a support ticket and the appropriate office will be able to assist you.", ts: Date.now(), links: [], cards: [], pills: [{ label: "Create Support Ticket", action: { type: "ticket" } }], feedbackId: null, fb: 0, followUp: null });
  }
  triggerHelpdeskMascotState("talking", 1900);
  renderActiveChatbotUi();
}
// Safe inline formatting for assistant replies: HTML-escaped first, then
// **bold**, *italic*, and `code` spans rendered cleanly.
function fmtChatText(raw) {
  return esc(raw || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:rgba(122,15,31,.09);padding:1px 6px;border-radius:6px;color:#7A0F1F;">$1</code>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
}

function chatbotPillIcon(action) {
  const t = action && action.type;
  if (t === "guest_login") return "fa-solid fa-right-to-bracket";
  if (t === "guest_register") return "fa-solid fa-user-plus";
  if (t === "guest_scan_qr") return "fa-solid fa-qrcode";
  if (t === "view_qr") return "fa-solid fa-qrcode";
  if (t === "reschedule") return "fa-solid fa-calendar-days";
  if (t === "ticket" || t === "tickets") return "fa-solid fa-ticket";
  if (t === "navigate") {
    if (action.target === "page-appointment-book") return "fa-solid fa-calendar-plus";
    if (action.target === "page-forms") return "fa-solid fa-file-arrow-down";
    if (action.target === "page-idapp") return "fa-solid fa-id-card";
    if (action.target === "page-account") return "fa-solid fa-user-shield";
    return "fa-solid fa-arrow-up-right-from-square";
  }
  return "fa-regular fa-comment-dots";
}

// Contextual action pills: rendered ONLY under the latest bot message —
// earlier pills vanish on re-render by construction.
function chatbotPillsHtml(m, idx) {
  const isLatest = idx === chatbotMessages.length - 1 && m.from === "bot" && !chatbotTyping;
  const pills = m.pills || [];
  if (isLatest && pills.length) {
    return `<div class="hd-pills">${pills.map((p, i) => {
      const isPrimary = p.action && (p.action.type === "view_qr" || p.action.type === "ticket" || p.action.type === "guest_login");
      const cls = isPrimary ? "btn-maroon" : "btn-ghost";
      return `<button type="button" onclick="chatbotPillClick(${idx},${i})" class="${cls} hd-pill-btn"><i class="${chatbotPillIcon(p.action)}"></i>${esc(p.label)}</button>`;
    }).join("")}</div>`;
  }
  if (!pills.length && (m.links || []).length) {
    return `<div class="hd-pills">${(m.links || []).map((l) => `<button type="button" onclick="closeFloatingChatbot();goTo('${esc(l.target)}')" class="btn-ghost hd-pill-btn"><i class="fa-solid fa-arrow-up-right-from-square"></i>${esc(l.label)}</button>`).join("")}</div>`;
  }
  return "";
}
function chatbotPillClick(msgIdx, pillIdx) {
  if (chatbotTyping) return;
  const m = chatbotMessages[msgIdx];
  const p = m && m.pills && m.pills[pillIdx];
  if (!p || !p.action) return;
  const a = p.action;
  if (a.type === "guest_login") { fcFocusLogin(); return; }
  if (a.type === "guest_register") { closeFloatingChatbot(); goTo("page-register"); return; }
  if (a.type === "guest_scan_qr") { closeFloatingChatbot(); loginScanQr(); return; }
  if (a.type === "view_qr" && a.code) {
    closeFloatingChatbot();
    viewMyAppointment(a.code);
    return;
  }
  if (a.type === "reschedule" && a.code) {
    closeFloatingChatbot();
    rescheduleAppointment(a.code);
    return;
  }
  if (a.type === "navigate") {
    if (!/^page-[a-z0-9-]+$/.test(a.target || "") || !document.getElementById(a.target)) return;
    closeFloatingChatbot();
    goTo(a.target, a.params ? { params: a.params } : undefined);
    return;
  }
  if (a.type === "jump") {
    const el = document.getElementById(a.anchor || "");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (a.type === "ticket") {
    closeFloatingChatbot();
    openTicketDraftModal(a.prefill || null, chatbotSessionId ? { chatSessionId: chatbotSessionId } : {});
    return;
  }
  if (a.type === "tickets") { closeFloatingChatbot(); hdMyTickets(); return; }
  if (a.type === "ask" && (a.prompt || "").trim()) {
    pendingViaPill = p.label || "";
    chatbotSendToServer(a.prompt.trim());
  }
}
// Starter set mirrors server STARTER_PILLS (client-side initial message only).
const CHATBOT_STARTER_PILLS = [
  { label: "Book / Request", action: { type: "navigate", target: "page-appointment-book" } },
  { label: "Upcoming Visits", action: { type: "navigate", target: "page-appointment", params: { filter: "upcoming" } } },
  { label: "Check my status", action: { type: "ask", prompt: "What's the status of my appointments and requests?" } },
  { label: "Offline QR Pass", action: { type: "ask", prompt: "How do I get my offline appointment QR pass?" } },
];
// Structured answer cards mirroring the text reply (C-3). Server sends
// cards; text stays authoritative, so a missing/empty array renders nothing.
function chatbotCardsHtml(m) {
  if (!m.cards || !m.cards.length) return "";
  return `<div class="hd-cards">${m.cards.map((c) => {
    const isAppt = c.kind === "appointment";
    const isActiveAppt = isAppt && !["CANCELLED", "NO_SHOW", "Cancelled", "No Show"].includes(c.status);
    const canResched = isAppt && ["BOOKED", "RESCHEDULED", "Confirmed", "Rescheduled"].includes(c.status);
    const isReqKind = ["request", "idapp", "event"].includes(c.kind);
    return `
    <div class="hd-card">
      <div class="hd-card-top">
        <span class="hd-card-title">${esc(c.title)}</span>${pill(c.status)}
      </div>
      <div class="hd-card-ref">${esc(c.ref)}</div>
      ${(c.meta || []).map((x) => `<div class="hd-card-meta">${esc(x)}</div>`).join("")}
      <div class="hd-card-actions">
        ${isActiveAppt ? `<button type="button" onclick="closeFloatingChatbot();viewMyAppointment('${esc(c.ref)}')" class="btn-maroon"><i class="fa-solid fa-qrcode" style="margin-right:4px;"></i>Show QR Pass</button>` : ""}
        ${canResched ? `<button type="button" onclick="closeFloatingChatbot();rescheduleAppointment('${esc(c.ref)}')" class="btn-ghost"><i class="fa-solid fa-calendar-days" style="margin-right:4px;"></i>Reschedule</button>` : ""}
        ${isReqKind ? `<button type="button" onclick="closeFloatingChatbot();viewMyRequest('${esc(c.kind)}','${esc(c.ref)}')" class="btn-ghost"><i class="fa-solid fa-eye" style="margin-right:4px;"></i>View Details</button>` : ""}
        ${c.kind === "ticket" ? `<button type="button" onclick="closeFloatingChatbot();jumpToTicket('${esc(c.ref)}')" class="btn-ghost"><i class="fa-solid fa-ticket" style="margin-right:4px;"></i>View Ticket</button>` : ""}
        ${c.link ? `<button type="button" onclick="closeFloatingChatbot();goTo('${esc(c.link.target)}')" class="btn-ghost">${esc(c.link.label)} →</button>` : ""}
      </div>
    </div>`;
  }).join("")}</div>`;
}
async function chatbotSendToServer(question) {
  chatbotEscalationQuestion = "";
  chatbotTicketDraft = null;
  chatbotMessages.push({ from: "user", text: question, ts: Date.now() });
  if (isGuestChatbotMode()) {
    chatbotAnswerGuest(question);
    return;
  }
  chatbotTyping = true;
  triggerHelpdeskMascotState("thinking");
  renderActiveChatbotUi();
  const body = { sessionId: chatbotSessionId, message: question };
  if (pendingViaPill) body.viaPill = pendingViaPill;
  pendingViaPill = "";
  const res = await api("/api/assistant/chat", { method: "POST", body });
  chatbotTyping = false;
  if (!res.ok || !res.data) {
    if (!res.ok && (res.status === 0 || res.status === 429 || res.status >= 500)) {
      const last = chatbotMessages[chatbotMessages.length - 1];
      if (last && last.from === "user" && last.text === question) chatbotMessages.pop();
      triggerHelpdeskMascotState("idle");
      renderActiveChatbotUi();
      const input = document.getElementById("chatbotInput");
      if (input) { input.value = question; input.focus(); }
      showToast("⚠️ Couldn't send — your message is kept below. Press Send to retry.", "rgba(180,130,0,.9)");
      return;
    }
    chatbotAnswerLocal(question);
    return;
  }
  chatbotSessionId = res.data.sessionId || chatbotSessionId;
  chatbotMessages.push({ from: "bot", text: res.data.reply, ts: Date.now(), links: Array.isArray(res.data.links) ? res.data.links : [], cards: Array.isArray(res.data.cards) ? res.data.cards : [], pills: Array.isArray(res.data.pills) ? res.data.pills : [], feedbackId: res.data.feedbackId || null, fb: 0, followUp: res.data.followUp || null });
  if (res.data.ticketDraft) {
    chatbotEscalationQuestion = question;
    chatbotTicketDraft = res.data.ticketDraft;
  }
  triggerHelpdeskMascotState("talking", 2000);
  renderActiveChatbotUi();
}
// Canonical help-desk categories offered in the ticket form. Existing
// ticket categories merge in below (except internal ones); free text is
// still possible via "Other…".
const TICKET_CATEGORIES = ["Document Request", "ID Application", "Appointments", "Event Request", "Account & Access", "Technical Issue", "General Inquiry"];
const TICKET_CATEGORY_EXCLUDED = new Set(["chatbot question"]);
function ticketCategoryOptions(prefill) {
  const existing = [...new Set((MOD.tickets || []).map((t) => (t.category || "").trim()).filter(Boolean))]
    .filter((c) => !TICKET_CATEGORY_EXCLUDED.has(c.toLowerCase()));
  const opts = [...TICKET_CATEGORIES];
  for (const c of existing) {
    if (!opts.some((o) => o.toLowerCase() === c.toLowerCase())) opts.push(c);
  }
  const p = (prefill || "").trim();
  if (p && !opts.some((o) => o.toLowerCase() === p.toLowerCase())) opts.unshift(p);
  return opts;
}
// Shared ticket creation flow: dedicated full-page form (#page-ticket-new),
// supporting both blank manual tickets and prefilled assistant escalations.
let pendingTicketExtra = {};
let pendingTicketDraft = {};
let hdNewTicketReturnPage = "page-helpdesk";
function openTicketDraftModal(prefill, extra) {
  const curPage = document.querySelector(".page.active")?.id;
  if (curPage && curPage !== "page-ticket-new") hdNewTicketReturnPage = curPage;
  pendingTicketDraft = prefill ? { ...prefill } : {};
  pendingTicketExtra = extra ? { ...extra } : {};
  goTo("page-ticket-new");
}
function hdCancelNewTicket() {
  pendingTicketDraft = {};
  pendingTicketExtra = {};
  goTo(hdNewTicketReturnPage || "page-helpdesk");
}
function tktPickCategory(btn, val) {
  const hidden = document.getElementById("tkdCat");
  if (hidden) hidden.value = val;
  document.querySelectorAll(".tkt-cat-pill").forEach((b) => b.classList.toggle("is-active", b === btn));
  const otherWrap = document.getElementById("tkdOtherWrap");
  if (otherWrap) {
    otherWrap.style.display = val === "__other" ? "block" : "none";
    if (val === "__other") document.getElementById("tkdCatOther")?.focus();
  }
}

function renderNewTicketPage() {
  const el = document.getElementById("newTicketBody");
  if (!el || isAdmin()) return;
  const p = pendingTicketDraft || {};
  const cats = ticketCategoryOptions(p.category);
  const selectedCat = p.category && cats.includes(p.category) ? p.category : (cats[0] || "General Inquiry");
  const fromChat = !!(pendingTicketExtra && pendingTicketExtra.chatSessionId);
  const subjVal = p.subject || "";

  el.innerHTML = `
    <div class="tkt-new-grid">
      <div class="hd-form-card">
        <div class="hd-requester-strip">
          <div style="display:flex;align-items:center;gap:9px;">
            <span class="tkt-avatar">${esc(tktInitials((session && session.name) || "Student"))}</span>
            <div>
              <div style="font-weight:800;color:var(--text);font-size:13px;">${esc((session && session.name) || "Student")}</div>
              <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-muted);font-size:11px;">${esc((session && session.id) || "")}</div>
            </div>
          </div>
          ${fromChat
            ? `<span class="hd-agent-badge"><i class="fa-solid fa-link" style="margin-right:4px;"></i>Linked to Assistant Chat</span>`
            : `<span style="font-size:11.5px;color:var(--text-muted);font-weight:600;">Office of Student Services</span>`}
        </div>

        <div class="hd-form-grid">
          <div>
            <span class="input-label">Category <span style="color:var(--maroon);">*</span></span>
            <input type="hidden" id="tkdCat" value="${esc(selectedCat)}" />
            <div class="tkt-cat-pills" role="radiogroup" aria-label="Ticket category">
              ${cats.map((c) => `<button type="button" class="tkt-cat-pill${c === selectedCat ? " is-active" : ""}" onclick="tktPickCategory(this,'${esc(c)}')">${esc(c)}</button>`).join("")}
              <button type="button" class="tkt-cat-pill" onclick="tktPickCategory(this,'__other')">Other…</button>
            </div>
            <div id="tkdOtherWrap" style="display:none;margin-top:8px;">
              <input id="tkdCatOther" class="glass-input" placeholder="Specify a category">
            </div>
          </div>

          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <label for="tkdSubj" class="input-label" style="margin:0;">Subject <span style="color:var(--maroon);">*</span></label>
              <span id="tkdSubjCount" style="font-size:11px;color:var(--text-muted);">${subjVal.length} / 120</span>
            </div>
            <input id="tkdSubj" class="glass-input" maxlength="120" placeholder="Short, clear summary of your inquiry or issue" value="${esc(subjVal)}" oninput="var c=document.getElementById('tkdSubjCount');if(c)c.textContent=this.value.length+' / 120';">
          </div>

          <div>
            <label for="tkdMsg" class="input-label">Description <span style="color:var(--maroon);">*</span></label>
            <textarea id="tkdMsg" class="glass-input" rows="6" placeholder="Explain your concern clearly. Include any reference codes (APT-…, EXC-…, IDA-…, TKT-…) or dates so OSS staff can resolve this faster.">${esc(p.message || "")}</textarea>
          </div>
        </div>

        <div class="hd-form-actions">
          <button type="button" class="btn-ghost" style="padding:10px 18px;font-size:13px;" onclick="hdCancelNewTicket()">Cancel</button>
          <button type="button" class="btn-maroon" style="padding:10px 22px;font-size:13px;" onclick="submitTicketDraft()"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Support Ticket</button>
        </div>
      </div>

      <aside style="display:flex;flex-direction:column;gap:14px;">
        ${!fromChat ? `
        <div class="tkt-info-card">
          <div style="display:flex;align-items:center;gap:11px;">
            <div class="hd-deflect-mascot"><img src="/chatbot-mascot-head.svg" alt="" /></div>
            <div>
              <div style="font-size:13.5px;font-weight:800;color:var(--text);">Ask the assistant first?</div>
              <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">Instant answers &amp; status lookup</div>
            </div>
          </div>
          <p style="font-size:12px;color:var(--text-muted);line-height:1.5;">For QR passes, document requirements, or quick status checks, the STARS Assistant can help right away without waiting for staff review.</p>
          <button type="button" class="btn-ghost" style="width:100%;padding:8px 12px;font-size:12px;" onclick="openFloatingChatbot()">Open STARS Assistant</button>
        </div>` : ""}

        <div class="tkt-info-card">
          <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);">Service Desk Info</div>
          <ul class="tkt-info-list">
            <li><i class="fa-solid fa-clock"></i><span><strong>Office Hours:</strong> Mon–Fri, 8:00 AM – 5:00 PM (PUP San Pedro Campus).</span></li>
            <li><i class="fa-solid fa-envelope-open-text"></i><span><strong>Email Updates:</strong> You'll be notified automatically when OSS staff reply or resolve your ticket.</span></li>
            <li><i class="fa-solid fa-hashtag"></i><span><strong>Faster Resolution:</strong> Include your <code>APT-</code>, <code>EXC-</code>, or <code>IDA-</code> code when referring to an existing request.</span></li>
          </ul>
        </div>
      </aside>
    </div>`;
}
async function submitTicketDraft() {
  let category = (document.getElementById("tkdCat")?.value || "").trim();
  if (category === "__other") category = (document.getElementById("tkdCatOther")?.value || "").trim();
  const body = { category, subject: (document.getElementById("tkdSubj")?.value || "").trim(), message: (document.getElementById("tkdMsg")?.value || "").trim(), ...pendingTicketExtra };
  if (!body.category) { showToast("⚠️ Please choose a category.", "rgba(180,130,0,.85)"); return; }
  if (!body.subject || !body.message) { showToast("⚠️ Subject and details are required.", "rgba(180,130,0,.85)"); return; }
  const res = await api("/api/modules/tickets", { method: "POST", body });
  if (!res.ok) { showToast(`❌ ${res.error || "Could not submit the Help Desk ticket."}`, "rgba(155,22,22,.85)"); return; }
  const ticketId = res.data && res.data.id ? res.data.id : "";
  pendingTicketExtra = {};
  pendingTicketDraft = {};
  closeAppModal();
  chatbotEscalationQuestion = "";
  chatbotTicketDraft = null;
  if (ticketId) chatbotMessages.push({ from: "bot", text: `Ticket **${ticketId}** submitted. An OSS staff member will respond through your Help Desk ticket.`, ts: Date.now() });
  triggerHelpdeskMascotState("happy", 2400);
  await loadModule("tickets");
  showToast("✅ Support ticket submitted.");
  if (ticketId) jumpToTicket(ticketId);
  else goTo("page-helpdesk");
}
function jumpToTicket(id) {
  window.__hdStudentTicket = id;
  goTo("page-helpdesk");
}
function hdNewTicket() {
  openTicketDraftModal(null, {});
}
function hdMyTickets() {
  window.__hdStudentTicket = null;
  goTo("page-helpdesk");
}
function renderStudentTicketsInto(el) {
  if (!el) return;
  const mine = [...(MOD.tickets || [])].filter((t) => t.sn === session.id).reverse();
  if (!mine.length) {
    tktAdoptTopbarControls(false);
    el.innerHTML = `
      <div class="tkt-app">
        ${tktAppbarHtml({ role: "student", all: [], activeStatus: "all", showPanelToggles: false })}
        <div class="tkt-full-empty">
          <img src="/chatbot-mascot.svg" alt="STARS Assistant" />
          <h3>No support tickets yet</h3>
          <p>For quick answers, tap the STARS Assistant in the corner. When you need direct follow-up from Office of Student Services staff, submit a ticket.</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:6px;">
            <button type="button" class="btn-maroon" style="padding:10px 18px;font-size:13px;" onclick="hdNewTicket()"><i class="fa-solid fa-plus" style="margin-right:6px;"></i>Submit a Ticket</button>
            <button type="button" class="btn-ghost" style="padding:10px 18px;font-size:13px;" onclick="openFloatingChatbot()"><i class="fa-solid fa-comments" style="margin-right:6px;"></i>Ask Assistant First</button>
          </div>
        </div>
      </div>`;
    tktAdoptTopbarControls(true);
    return;
  }
  const state = tktGetFilterState("student");
  renderEnterpriseTicketWorkspace(el, {
    role: "student",
    all: mine,
    state,
    onSelectFn: "hdTicketDetail",
    searchInputId: "hdTicketQ",
  });
}
function renderTicketsPage() {
  renderHelpdesk();
}
function hdTicketDetail(id) {
  window.__hdStudentTicket = id;
  if (document.querySelector(".page.active")?.id === "page-helpdesk") renderHelpdesk();
  else goTo("page-helpdesk");
}
function hdAdminTicketDetail(id) {
  window.__hdAdminTicket = id;
  if (document.querySelector(".page.active")?.id === "page-helpdesk") renderHelpdesk();
  else goTo("page-helpdesk");
}
function openTicketModal(id) {
  // Legacy Manage entry point — now opens the ticket inline instead of a modal.
  const t = (MOD.tickets || []).find((x) => x.id === id);
  if (!t) { showToast("❌ Ticket not found.", "rgba(155,22,22,.85)"); return; }
  hdAdminTicketDetail(id);
}
// Chatbot origin for staff: first student question of the linked session,
// fetched through the sessions API (admins may read any session).
async function loadTicketChatQuote(sessionId) {
  const box = document.getElementById("tktChatQuote");
  const res = await api(`/api/assistant/sessions/${encodeURIComponent(sessionId)}`);
  if (!box || !box.isConnected) return;
  const first = res.ok && res.data ? (res.data.messages || []).find((m) => m.role === "student") : null;
  if (first) {
    box.innerHTML = `<img src="/chatbot-mascot-head.svg" alt="" /><div><strong>Escalated from STARS Assistant:</strong> “${esc(first.text)}”</div>`;
  } else {
    box.remove();
  }
}
const helpDeskRepliesInFlight = new Set();
async function hdReply(id, button) {
  if (helpDeskRepliesInFlight.has(id)) return;
  const inp = document.getElementById("hdrep-" + id);
  const txt = inp.value.trim(); if (!txt) return;
  helpDeskRepliesInFlight.add(id);
  if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending'; }
  inp.disabled = true;
  try {
    const { ok, error } = await api(`/api/modules/tickets/${encodeURIComponent(id)}/reply`, { method: "POST", body: { text: txt } });
    if (!ok) { showToast(`❌ ${error || "Could not send reply."}`, "rgba(155,22,22,.85)"); return; }
    window.__hdAdminTicket = id;
    await loadModule("tickets"); renderHelpdesk();
    if (document.querySelector(".page.active")?.id === "page-tickets") renderTicketsPage();
  } finally {
    helpDeskRepliesInFlight.delete(id);
    if (button?.isConnected) { button.disabled = false; button.textContent = "Send"; }
    if (inp?.isConnected) inp.disabled = false;
  }
}
function hdClose(id) {
  const t = (MOD.tickets || []).find((x) => x.id === id);
  openAppModal({ title: "Close this ticket?", subtitle: "The student will be notified that it is resolved.", icon: "fa-circle-check", content: `
    <div class="dm-kvs dm-kvs-box">${dmKv("Ticket", id)}${t ? dmKv("Subject", t.subject || t.title || "") : ""}${t ? dmKv("Requester", t.name || t.studentName || "") : ""}${t ? dmKv("Category", t.category || "") : ""}</div>
    <div class="ml-notice" style="margin:14px 0 0;"><i class="fa-solid fa-circle-info"></i><span>Closed tickets are read-only. The student can still open a new ticket if the concern comes back.</span></div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Keep open</button><button type="button" id="hdCloseBtn" class="bk-btn bk-btn-fill bk-btn-sm" onclick="hdCloseConfirm('${esc(id)}')"><i class="fa-solid fa-check"></i>Close ticket</button></div>` });
}
async function hdCloseConfirm(id) {
  const btn = document.getElementById("hdCloseBtn"); if (btn) btn.disabled = true;
  const { ok, error } = await api(`/api/modules/tickets/${encodeURIComponent(id)}/close`, { method: "POST" });
  if (!ok) { if (btn) btn.disabled = false; showToast(`❌ ${error || "Could not close ticket."}`, "rgba(155,22,22,.85)"); return; }
  closeAppModal();
  window.__hdAdminTicket = id;
  await loadModule("tickets"); renderHelpdesk();
  showToast("✅ Ticket closed.");
}


let faqQuery = "";
let faqCategoryForEntry = "";
let assistantCuration = [];
async function loadCuration() {
  if (!isAdmin()) { assistantCuration = []; return; }
  const r = await api("/api/assistant/curation");
  assistantCuration = r.ok && r.data ? (r.data.suggestions || []) : [];
}
// Phase 3 curation loop: turn an unanswered-question cluster into a verified
// FAQ. Saving reuses the standard FAQ form + POST (same validation and
// auto-embed); repeat questions then match the new FAQ and the cluster clears.
function answerCuration(i) {
  const s = assistantCuration[i];
  if (!s) return;
  const cats = [...new Set([...faqCategories.map((c) => c.name), ...MOD.faqs.map((f) => f.cat)])].filter(Boolean);
  const cat = (s.suggestedCategory && cats.includes(s.suggestedCategory)) ? s.suggestedCategory : (cats[0] || "General");
  openFaqEntryForm(cat, s.question);
}
async function runChatbotSimulation() {
  const input = document.getElementById("simChatInput");
  const out = document.getElementById("simChatOutput");
  const message = (input?.value || "").trim();
  if (!message || !out) return;
  out.style.display = "block";
  out.innerHTML = `<div style="font-size:12px;color:rgba(30,5,5,.6);">Simulating assistant pipeline…</div>`;
  const res = await api("/api/assistant/simulate", { method: "POST", body: { message } });
  if (!res.ok) {
    out.innerHTML = `<div style="color:#b91c1c;font-size:12px;font-weight:700;">${esc(res.error || "Simulation failed.")}</div>`;
    return;
  }
  const d = res.data;
  const confColor = d.confidence === "high" ? "#166534" : d.confidence === "medium" ? "#a16207" : "#b91c1c";
  out.innerHTML = `
    <div style="padding:12px 14px;border-radius:12px;background:rgba(139,26,26,.05);border:1px solid rgba(139,26,26,.16);font-size:12px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
        <span style="font-weight:800;padding:2px 8px;border-radius:999px;background:#8B1A1A;color:#fff;font-size:10px;">Stage: ${esc(d.stage)}</span>
        <span style="font-weight:800;padding:2px 8px;border-radius:999px;background:${confColor};color:#fff;font-size:10px;">Confidence: ${esc(d.confidence)}</span>
        ${d.ruleId ? `<span style="font-family:monospace;font-size:10px;">rule: <b>${esc(d.ruleId)}</b></span>` : ""}
        ${d.faqId ? `<span style="font-family:monospace;font-size:10px;">faq: <b>${esc(d.faqId)}</b></span>` : ""}
        ${d.semanticTopScore != null ? `<span style="font-family:monospace;font-size:10px;">semantic: <b>${d.semanticTopScore}</b></span>` : ""}
      </div>
      <div style="font-size:11px;color:rgba(30,5,5,.65);margin-bottom:6px;">Tokens: <code>${esc((d.tokens || []).join(", ") || "—")}</code></div>
      <div style="white-space:pre-wrap;background:#fff;border:1px solid rgba(139,26,26,.12);border-radius:10px;padding:10px 12px;color:#1a0505;line-height:1.45;">${esc(d.reply || "")}</div>
    </div>`;
}

let faqCat = "All";
try { new Image().src = "/chatbot-mascot.svg"; new Image().src = "/chatbot-mascot-head.svg"; } catch (_) {}
const FAQ_ICONS = { "account & security": "fa-lock", appointments: "fa-calendar-check", events: "fa-champagne-glasses", general: "fa-circle-info", "qr pass & scanner": "fa-qrcode", "service requests": "fa-file-lines", "student id": "fa-id-card" };
function faqIcon(c) { return FAQ_ICONS[String(c || "").toLowerCase()] || "fa-circle-question"; }
function faqAllCategories() {
  const map = new Map(faqCategories.map((c) => [c.name, c]));
  MOD.faqs.forEach((f) => { if (!map.has(f.cat)) map.set(f.cat, { id: "", name: f.cat }); });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function faqJs(s) { return esc(s).replace(/'/g, "\\'"); }
function renderFaq() {
  const trainer = document.getElementById("adminChatbotTrainer");
  if (trainer) trainer.style.display = isAdmin() ? "block" : "none";
  const addBtn = document.getElementById("faqAddCatBtn"); if (addBtn) addBtn.style.display = isAdmin() ? "" : "none";
  const el = document.getElementById("faqBody"); if (!el) return;
  const cats = faqAllCategories();
  if (faqCat !== "All" && !cats.some((c) => c.name === faqCat)) faqCat = "All";
  const student = session && session.role === "student";
    let curation = "";
  if (isAdmin() && assistantCuration.length) {
    curation = `<div class="fq-admin"><h3 class="bk-h"><i class="fa-solid fa-lightbulb"></i>Questions needing answers <span class="bl-cat">${assistantCuration.length}</span></h3>
      <p class="fq-sub">Asked ${assistantCuration.reduce((n, s) => n + s.count, 0)}× with no confident answer. Answer one to add it as a verified FAQ.</p>
      ${assistantCuration.map((s, i) => `<div class="fq-cur"><div><b>${esc(s.question)}</b> <span class="bl-cat">${s.count}×</span>
        <div class="fq-sub">Suggested: ${esc(s.suggestedCategory || "pick a category")}${s.similarFaq ? ` · Possibly covered by “${esc(s.similarFaq.q)}” (${Math.round(s.similarFaq.similarity * 100)}%)` : ""}</div></div>
        <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="answerCuration(${i})">Answer as FAQ</button></div>`).join("")}</div>`;
  }
  el.innerHTML = `
    <div class="fq-hero">
      <div class="fq-top"><h2>${student ? "Hi! How can we help?" : "Find answers fast"}</h2><div class="fq-mascot" aria-hidden="true"><img src="/chatbot-mascot.svg" alt="" decoding="sync"></div></div>
      <div class="fq-bar">
        <div class="fq-search"><i class="fa-solid fa-magnifying-glass"></i><input id="faqSearch" type="search" placeholder="Search questions\u2026" value="${esc(faqQuery)}" oninput="faqSearch(this.value)" aria-label="Search FAQs"></div>
        <div class="bk-input fq-filter"><select id="faqCatSel" data-dd="1" onchange="faqSetCat(this.value)" aria-label="Filter by category"><option value="All"${faqCat === "All" ? " selected" : ""}>All categories</option>${cats.map((c) => `<option value="${esc(c.name)}"${c.name === faqCat ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
      </div>
    </div>
    ${curation}
    <div id="faqList"></div>
    ${student ? `<div class="fq-foot"><div class="fq-foot-mascot"><img src="/chatbot-mascot-head.svg" alt=""></div><div><b>Still can’t find your answer?</b></div>
      <div class="fq-foot-act"><button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="openFloatingChatbot()"><i class="fa-solid fa-comment-dots"></i>Ask assistant</button><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="goTo('page-helpdesk')"><i class="fa-solid fa-headset"></i>Help Desk</button></div></div>` : ""}`;
  ddInitAll(el);
  renderFaqList();
}
function faqSearch(v) { faqQuery = String(v || ""); renderFaqList(); }
function faqSetCat(c) { faqCat = c; renderFaq(); }
function renderFaqList() {
  const box = document.getElementById("faqList"); if (!box) return;
  const q = faqQuery.trim().toLowerCase();
  const admin = isAdmin();
  const match = (f) => !q || f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q) || f.cat.toLowerCase().includes(q);
  const cats = faqAllCategories().filter((c) => (faqCat === "All" || c.name === faqCat) && (admin && !q ? true : MOD.faqs.some((f) => f.cat === c.name && match(f))));
  if (!cats.length) {
    box.innerHTML = `<div class="fq-empty"><i class="fa-solid fa-circle-question"></i><b>${q ? "No matching questions" : "No FAQs yet"}</b><span>${q ? "Try different keywords, or ask the assistant." : "Check back soon."}</span></div>`;
    return;
  }
  box.innerHTML = cats.map((c) => {
    const items = MOD.faqs.filter((f) => f.cat === c.name && match(f));
    return `<section class="fq-group">
      <div class="fq-gh"><h3>${esc(c.name)}</h3>
        ${admin ? `<div class="fq-gact">${mlAct("fa-plus", "Add FAQ", `openFaqEntryForm('${faqJs(c.name)}')`)}${c.id ? mlAct("fa-trash", "Delete category", `faqCategoryDelete('${esc(c.id)}','${faqJs(c.name)}')`, "ml-act-bad") : ""}</div>` : ""}</div>
      ${items.length ? `<div class="fq-list">${items.map((f) => `<details class="fq-item"${q ? " open" : ""}><summary><span>${esc(f.q)}</span>${admin ? mlAct("fa-trash", "Delete FAQ", `event.preventDefault();event.stopPropagation();faqDelete('${esc(f.id)}')`, "ml-act-bad") : ""}<i class="fa-solid fa-chevron-down fq-chev"></i></summary><div class="fq-a">${esc(f.a)}</div></details>`).join("")}</div>` : `<div class="fq-none">No FAQs in this category yet.${admin ? " Use Add FAQ to create the first one." : ""}</div>`}
    </section>`;
  }).join("");
}
function openFaqCategoryForm() {
  openAppModal({ title: "Add FAQ category", subtitle: "Group related questions together.", icon: "fa-folder-plus", content: `
    <div class="bk-form">${bkField("Category name", `<div class="bk-input"><input id="faqCategoryName" type="text" placeholder="e.g. Appointments" onkeydown="if(event.key==='Enter')faqCategoryAdd()"></div>`, { for: "faqCategoryName", req: true })}</div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Cancel</button><button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="faqCategoryAdd()">Add category</button></div>` });
  setTimeout(() => document.getElementById("faqCategoryName")?.focus(), 60);
}
async function faqCategoryAdd() {
  const input = document.getElementById("faqCategoryName");
  const name = input?.value.trim();
  if (!name) { showToast("⚠️ Enter a category name first.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/faq-categories", { method: "POST", body: { name } });
  if (!ok) { showToast(`❌ ${error || "Could not add FAQ category."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ FAQ category added.");
  closeAppModal();
  await loadFaqCategories(); renderFaq();
}
function faqCategoryDelete(id, name) {
  const n = MOD.faqs.filter((f) => f.cat === name).length;
  openAppModal({ title: "Delete this category?", subtitle: "This can’t be undone.", icon: "fa-trash", content: `
    <div class="dm-kvs dm-kvs-box">${dmKv("Category", name)}${dmKv("FAQs removed", String(n))}</div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Keep category</button><button type="button" id="faqDelBtn" class="bk-btn bk-btn-danger bk-btn-sm" onclick="faqCategoryDeleteConfirm('${esc(id)}')">Delete category</button></div>` });
}
async function faqCategoryDeleteConfirm(id) {
  const btn = document.getElementById("faqDelBtn"); if (btn) btn.disabled = true;
  const { ok, error, data } = await api(`/api/modules/faq-categories/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { if (btn) btn.disabled = false; showToast(`❌ ${error || "Could not delete FAQ category."}`, "rgba(155,22,22,.85)"); return; }
  closeAppModal();
  showToast(`✅ Category deleted${data?.removedFaqs ? ` with ${data.removedFaqs} FAQ(s)` : ""}.`);
  await Promise.all([loadModule("faqs"), loadFaqCategories()]); renderFaq();
}
function openFaqEntryForm(category, presetQ) {
  faqCategoryForEntry = category;
  openAppModal({ title: "Add FAQ", subtitle: `Category: ${category}`, icon: "fa-circle-question", content: `
    <div class="bk-form">
      ${bkField("Question", `<div class="bk-input"><input id="faqQ" type="text" placeholder="e.g. How do I reschedule a visit?" value="${esc(presetQ || "")}"></div>`, { for: "faqQ", req: true })}
      ${bkField("Answer", `<textarea id="faqA" class="bk-ta" rows="5" placeholder="Write a clear, short answer"></textarea>`, { for: "faqA", req: true })}
    </div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Cancel</button><button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="faqAdd()">Add FAQ</button></div>` });
}
async function faqAdd() {
  const c = faqCategoryForEntry;
  const q = document.getElementById("faqQ")?.value.trim();
  const a = document.getElementById("faqA")?.value.trim();
  if (!q || !a) { showToast("⚠️ Question and answer are required.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/faqs", { method: "POST", body: { cat: c, q, a } });
  if (!ok) { showToast(`❌ ${error || "Could not add FAQ."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ FAQ added.");
  closeAppModal();
  faqCategoryForEntry = "";
  await Promise.all([loadModule("faqs"), loadFaqCategories(), loadCuration()]); renderFaq();
}
function faqDelete(id) {
  const f = MOD.faqs.find((x) => x.id === id); if (!f) return;
  openAppModal({ title: "Delete this FAQ?", subtitle: "This can’t be undone.", icon: "fa-trash", content: `
    <div class="dm-kvs dm-kvs-box">${dmKv("Question", f.q)}${dmKv("Category", f.cat)}</div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Keep FAQ</button><button type="button" id="faqDelBtn" class="bk-btn bk-btn-danger bk-btn-sm" onclick="faqDeleteConfirm('${esc(id)}')">Delete FAQ</button></div>` });
}
async function faqDeleteConfirm(id) {
  const btn = document.getElementById("faqDelBtn"); if (btn) btn.disabled = true;
  const { ok, error } = await api(`/api/modules/faqs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { if (btn) btn.disabled = false; showToast(`❌ ${error || "Could not delete."}`, "rgba(155,22,22,.85)"); return; }
  closeAppModal(); await loadModule("faqs"); renderFaq();
}



const CMP_STATUSES = ["Submitted", "Under Investigation", "Resolved", "Dismissed"];
function renderComplaint() {
  const el = document.getElementById("complaintBody");
  const nb = document.getElementById("cmpNewBtn"); if (nb) nb.style.display = isAdmin() ? "none" : "";
  const sb = document.getElementById("cmpSub"); if (sb) sb.textContent = isAdmin() ? "Review, assign and resolve student complaints." : "Your confidential reports and where each one stands.";
  if (isAdmin()) {
    const list = [...MOD.complaints].reverse().filter((c) => matchQ(cmpAdminQ, [c.name, c.sn, c.id, c.category, c.status])
      && (!cmpFilters.conf || (c.confidentiality || "Standard") === cmpFilters.conf)
      && (!cmpFilters.cat || c.category === cmpFilters.cat)
      && (!cmpFilters.status || c.status === cmpFilters.status));
    const confBadge = (lv) => { const l = lv || "Standard"; const ic = l === "Strictly Confidential" ? "fa-user-lock" : l === "Restricted" ? "fa-lock" : "fa-lock-open"; return `<span title="${esc(l)}: ${l === "Strictly Confidential" ? "Super Admin only" : l === "Restricted" ? "Assigned staff and Super Admin" : "All OSS staff"}" style="font-size:11px;white-space:nowrap;"><i class="fa-solid ${ic}" style="color:#8B1A1A;margin-right:5px;"></i>${esc(l)}</span>`; };
    const rows = getModulePage("complaints-admin", list).items.map((c) => `<tr>
        <td><div style="font-weight:700;font-size:12px;color:#1a0505;">${esc(c.id)}</div><div style="font-size:10px;color:rgba(30,5,5,.55);">${esc(c.category)}</div></td>
        <td>${pill(c.status)}</td>
        <td>${confBadge(c.confidentiality)}</td>
        <td style="font-size:11px;">${c.assignedTo ? esc(c.assignedTo) : "\u2014"}</td>
        <td style="font-size:11px;white-space:nowrap;">${esc(c.ts)}</td>
        <td style="text-align:right;">${manageBtn(c.id, "openComplaintModal")}</td>
      </tr>`).join("");
    const statuses = [...new Set((MOD.complaints || []).map((c) => c.status))];
    const sel = (id, label, key, opts) => `<div class="bk-input ml-dd"><select id="${id}" data-dd="1" aria-label="${label}" onchange="setCmpFilter('${key}',this.value)"><option value="">${label}: All</option>${opts.map((o) => `<option${cmpFilters[key] === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></div>`;
    const catNames = [...new Set([...cmpCats.map((c) => c.name), ...(MOD.complaints || []).map((c) => c.category)])];
    const filtersHtml = `${adminSearchBox("cmpAdminQBox", "cmpAdminQ", "renderComplaint", "Search by name, student ID, or ref code\u2026", cmpAdminQ)}
      ${sel("cmpFConf", "Confidentiality", "conf", ["Standard", "Restricted", "Strictly Confidential"])}
      ${sel("cmpFCat", "Category", "cat", catNames)}
      ${sel("cmpFStatus", "Status", "status", statuses)}
      <button type="button" class="bk-btn bk-btn-text bk-btn-sm" onclick="cmpFilters={conf:'',cat:'',status:''};cmpAdminQ='';renderComplaint()" title="Clear filters"><i class="fa-solid fa-rotate-left"></i>Reset</button>
      ${isSuperAdmin() ? `<button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="openComplaintCategories()" title="Add, rename or retire complaint categories"><i class="fa-solid fa-tags"></i>Categories</button>` : ""}
      <div class="ml-fbar-row">${dtTabs([{ key: "active", label: "Active", icon: "fa-folder-open", count: cmpTab === "active" ? MOD.complaints.length : "\u00b7" }, { key: "archived", label: "Archived", icon: "fa-box-archive", tip: "Resolved complaints older than 30 days", count: cmpTab === "archived" ? MOD.complaints.length : "\u00b7" }], cmpTab, "setCmpTab")}</div>`;
    el.innerHTML = adminTableShell({
      icon: "fa-solid fa-shield-heart",
      title: "Complaints",
      count: `${list.length} shown`,
      filtersHtml,
      theadHtml: "<th>Reference</th><th>Status</th><th>Confidentiality</th><th>Assigned</th><th>Filed</th><th style=\"text-align:right;\">Action</th>",
      rowsHtml: rows,
      emptyHtml: emptyState(cmpAdminQ || cmpFilters.conf || cmpFilters.cat || cmpFilters.status ? "No complaints match these filters." : "No complaints filed."),
      paginationHtml: modulePagination("complaints-admin", list.length, "renderComplaint"),
    });
  } else {
    renderStudentComplaints(el);
  }
}
async function openComplaintCategories() {
  const r = await api("/api/modules/complaint-categories?all=1");
  const rows = (r.ok ? r.data : []).map((c) => `<tr>
      <td><input class="glass-input" id="ccn-${esc(c.id)}" value="${esc(c.name)}" maxlength="60" style="min-width:180px;"></td>
      <td>${c.active ? '<span class="badge badge-ready">Active</span>' : '<span class="badge badge-rejected">Retired</span>'}</td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn-soft" onclick="ccSave('${esc(c.id)}')" title="Save the new name" style="padding:6px 10px;font-size:11px;"><i class="fa-solid fa-floppy-disk"></i></button>
        <button class="btn-ghost" onclick="ccToggle('${esc(c.id)}',${c.active ? "false" : "true"})" title="${c.active ? "Retire: hide from the student form" : "Restore to the student form"}" style="padding:6px 10px;font-size:11px;"><i class="fa-solid ${c.active ? "fa-eye-slash" : "fa-eye"}"></i></button>
      </td></tr>`).join("");
  openAppModal({ title: "Complaint categories", subtitle: "Retired categories stay on existing complaints but disappear from the student form.", icon: "fa-tags", content: `
    <div style="display:flex;gap:8px;margin-bottom:12px;"><input id="ccNew" class="glass-input" placeholder="New category name" maxlength="60" style="flex:1;"><button class="btn-maroon" onclick="ccAdd()" style="padding:9px 14px;font-size:12px;"><i class="fa-solid fa-plus" style="margin-right:6px;"></i>Add</button></div>
    <table class="glass-table" style="width:100%;"><thead><tr><th>Name</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead><tbody>${rows}</tbody></table>` });
}
async function ccAdd() {
  const name = document.getElementById("ccNew").value.trim();
  const r = await api("/api/modules/complaint-categories", { method: "POST", body: { name } });
  if (!r.ok) { showToast(`\u26a0\ufe0f ${r.error || "Could not add."}`, "rgba(139,26,26,.9)"); return; }
  await loadComplaintData(); renderComplaint(); openComplaintCategories();
}
async function ccSave(id) {
  const r = await api(`/api/modules/complaint-categories/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: document.getElementById("ccn-" + id).value } });
  if (!r.ok) { showToast(`\u26a0\ufe0f ${r.error || "Could not save."}`, "rgba(139,26,26,.9)"); return; }
  await loadComplaintData(); renderComplaint(); openComplaintCategories();
}
async function ccToggle(id, active) {
  const r = await api(`/api/modules/complaint-categories/${encodeURIComponent(id)}`, { method: "PATCH", body: { active } });
  if (!r.ok) { showToast(`\u26a0\ufe0f ${r.error || "Could not update."}`, "rgba(139,26,26,.9)"); return; }
  await loadComplaintData(); renderComplaint(); openComplaintCategories();
}

/* ===== Student complaints: list (same shell as My Requests) + stepper wizard ===== */
let cmpMineQ = "";
function cmpMineSearch(v) { cmpMineQ = String(v || ""); drawMyComplaintsTable(); }
function renderStudentComplaints(el) {
  const mine = MOD.complaints.filter((c) => c.sn === session.id);
  const dot = "·";
  const tabs = [
    { key: "active", label: "Active", tip: "Complaints you filed", count: cmpTab === "active" ? mine.length : dot },
    { key: "archived", label: "Archived", tip: "Resolved complaints older than 30 days", count: cmpTab === "archived" ? mine.length : dot },
  ];
  el.innerHTML = `<div class="ml-notice"><i class="fa-solid fa-lock"></i><span><b>Confidentiality notice:</b> your complaints are visible only to authorized OSS personnel. Your identity is not disclosed to other parties without your consent.</span></div>`
    + mlToolbar(tabs, cmpTab, "setCmpTab", "mlSearchC", cmpMineQ, "Search by code, category or status", "cmpMineSearch") + `<div id="mlTableC"></div>`;
  drawMyComplaintsTable();
}
function drawMyComplaintsTable() {
  const host = document.getElementById("mlTableC"); if (!host || !session) return;
  let mine = MOD.complaints.filter((c) => c.sn === session.id).slice().reverse();
  const q = esc2q(cmpMineQ);
  if (q) mine = mine.filter((c) => `${c.id} ${c.category} ${c.status} ${c.confidentiality || ""}`.toLowerCase().includes(q));
  const rows = mine.map((c) => mlRow({ code: c.id, svc: c.category, sub: c.confidentiality || "Standard", d: splitWhen(c.ts)[0], t: splitWhen(c.ts)[1], status: stChip(c.status), acts: mlAct("fa-eye", "View details", `viewMyComplaint('${esc(c.id)}')`), open: `viewMyComplaint('${esc(c.id)}')` }));
  const cta = !q && cmpTab === "active" ? mlEmptyCta("New Complaint", "fa-pen-to-square", "openNewComplaint") : "";
  host.innerHTML = mlTable(ML_HEADERS("Filed").map((h, i) => i === 1 ? "Complaint" : h), rows, q ? "No complaints match your search." : (cmpTab === "archived" ? "No archived complaints." : "You haven’t filed any complaints.") + cta, "fa-shield-heart");
}
function viewMyComplaint(id) {
  const c = (MOD.complaints || []).find((x) => x.id === id);
  if (!c) { showToast("❌ Complaint not found.", "rgba(155,22,22,.85)"); return; }
  openAppModal({ title: c.category, subtitle: `${c.id} · filed ${c.ts}`, icon: "fa-shield-heart", content: `
    <div class="dm-info">
      <div class="dm-status">${stChip(c.status)}</div>
      <div class="dm-kvs">
        ${dmKv("Category", c.category)}
        ${dmKv("Confidentiality", c.confidentiality || "Standard")}
        ${dmKv("Details", c.details || "")}
        ${dmKv("OSS resolution note", c.note || "")}
      </div>
      ${c.attUrl ? `<div class="dm-files">${fileLink(c.attName, c.attUrl, "Attachment")}</div>` : ""}
    </div>
    <div class="dm-sec">${wfStepperHtml("complaint", c)}</div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Close</button></div>` });
}

// ── New Complaint wizard (same card, stepper and components as New Request) ──
let cnCat = "", cnStep = "main";
function openNewComplaint() { cnCat = ""; goTo("page-complaint-new"); }
async function cnInit() {
  const box = document.getElementById("cnCats"); if (!box) return;
  cnStep = "main"; cnCat = "";
  box.innerHTML = `<div class="ml-loading">Loading categories…</div>`;
  const r = await api("/api/modules/complaint-categories");
  if (r.ok) cmpCats = r.data;
  const det = document.getElementById("cnDetails"), att = document.getElementById("cnAtt"), conf = document.getElementById("cnConf");
  if (det) det.value = ""; fileClear(att);
  if (conf) { conf.selectedIndex = 0; conf.dispatchEvent(new Event("change", { bubbles: true })); }
  cnRenderCats();
  cnShow("main");
}
function cnRenderCats() {
  const box = document.getElementById("cnCats"); if (!box) return;
  box.innerHTML = cmpCats.length ? cmpCats.map((c) => {
    const on = cnCat === c.name;
    return `<button type="button" role="radio" aria-checked="${on}" class="bk-row${on ? " sel" : ""}" onclick="cnPick(this.dataset.n)" data-n="${esc(c.name)}"><span class="bk-row-ic"><i class="fa-solid fa-flag"></i></span><span class="bk-row-lbl">${esc(c.name)}</span><i class="fa-solid fa-chevron-right bk-row-chev"></i></button>`;
  }).join("") : `<div class="bk-empty" style="min-height:120px;">No complaint categories are available yet.</div>`;
}
function cnPick(name) { cnCat = name; cnErrSet(""); cnRenderCats(); cnShow("main"); }
function cnConfHelp() {
  const v = document.getElementById("cnConf")?.value, h = document.getElementById("cnConfHelp");
  if (h) h.textContent = v === "Strictly Confidential" ? "Visible to the Super Admin only." : v === "Restricted" ? "Visible to assigned staff and the Super Admin." : "Visible to all OSS staff.";
}
function cnErrSet(msg) { const e = document.getElementById("cnErr"); if (!e) return; e.textContent = msg || ""; e.style.display = msg ? "" : "none"; }
document.addEventListener("input", (e) => { if (e.target.closest && e.target.closest("#cnMain")) cnErrSet(""); });
function cnShow(step) {
  cnStep = step;
  document.getElementById("cnMain").style.display = step === "main" ? "" : "none";
  document.getElementById("cnConfirm").style.display = step === "confirm" ? "" : "none";
  document.getElementById("cnEmpty").style.display = cnCat ? "none" : "";
  document.getElementById("cnForm").style.display = cnCat ? "" : "none";
  if (cnCat) cnConfHelp();
  const cur = step === "confirm" ? 3 : cnCat ? 2 : 1;
  document.querySelectorAll("#cnStepper .bk-st").forEach((li) => { const n = +li.dataset.s; li.classList.toggle("active", n === cur); li.classList.toggle("done", n < cur); });
  const next = document.getElementById("cnNext");
  document.getElementById("cnNextLbl").textContent = step === "confirm" ? "Submit Complaint" : "Next";
  next.querySelector("i").className = step === "confirm" ? "fa-solid fa-check" : "fa-solid fa-arrow-right";
  document.getElementById("cnCancel").textContent = step === "confirm" ? "Back" : "Cancel";
  next.disabled = step === "main" && !cnCat;
}
function cnNext() {
  if (cnStep === "confirm") return cnSubmit();
  if (!cnCat) { cnErrSet("Choose a category to continue."); return; }
  const det = document.getElementById("cnDetails").value.trim();
  if (!det) { cnErrSet("Please describe what happened."); return; }
  const f = document.getElementById("cnAtt").files[0];
  document.getElementById("cnReview").innerHTML = [
    bkRow("fa-flag", "Category", cnCat),
    bkRow("fa-user-lock", "Confidentiality", document.getElementById("cnConf").value),
    bkRow("fa-align-left", "Details", det),
    f ? bkRow("fa-paperclip", "Attachment", f.name) : "",
  ].join("");
  cnErrSet(""); cnShow("confirm"); window.scrollTo({ top: 0 });
}
function cnCancel() {
  if (cnStep === "confirm") { cnShow("main"); return; }
  goTo("page-complaint");
}
async function cnSubmit() {
  const btn = document.getElementById("cnNext"); if (btn.disabled) return;
  btn.disabled = true;
  try {
    const details = document.getElementById("cnDetails").value.trim();
    const attInput = document.getElementById("cnAtt");
    let attName = "", attUrl = "";
    if (attInput.files.length) {
      const uploaded = await uploadFile(attInput);
      if (uploaded === false) return;
      attName = uploaded.fileName || ""; attUrl = uploaded.url || "";
    }
    const { ok, error } = await api("/api/modules/complaints", { method: "POST", body: { category: cnCat, details, attName, attUrl, confidentiality: document.getElementById("cnConf").value } });
    if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
    showToast("✅ Complaint filed confidentially.");
    cnCat = "";
    goTo("page-complaint");
  } finally { if (cnStep === "confirm") btn.disabled = false; }
}
async function cmpUpdate(id, next) {
  const sel = document.getElementById("cmst-" + id);
  const st = next || (sel ? sel.value : "");
  if (!st) { showToast("⚠️ No status selected.", "rgba(180,130,0,.85)"); return; }
  const note = document.getElementById("cmnt-" + id).value.trim();
  const assignedTo = document.getElementById("cmassign-" + id).value.trim();
  const confidentiality = document.getElementById("cmconf-" + id).value;
  const staffNotes = document.getElementById("cmstaff-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/complaints/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, note, assignedTo, confidentiality, staffNotes } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and complainant notified.");
  closeAppModal();
  await loadComplaintData(); renderComplaint();
}
function openComplaintModal(id) {
  const c = (MOD.complaints || []).find((x) => x.id === id);
  if (!c) { showToast("❌ Complaint not found.", "rgba(155,22,22,.85)"); return; }
  openAppModal({ title: `${c.id} — ${c.category}`, subtitle: `Filed ${c.ts}`, icon: "fa-shield-heart", wide: true, content: `
    <div style="display:grid;gap:12px;">
      <div class="glass-card" style="padding:14px;">
        <div style="font-size:10px;color:#8B1A1A;margin-bottom:6px;"><i class="fa-solid fa-lock" style="margin-right:4px;"></i>CONFIDENTIAL — Complainant: ${esc(c.name)} (${esc(c.sn)})</div>
        <div style="font-size:12px;color:rgba(30,5,5,.8);white-space:pre-wrap;">${esc(c.details)}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:center;">${pill(c.status)}
          ${c.attUrl ? fileLink(c.attName, c.attUrl, "Attachment") : ""}
          <span style="font-size:11px;"><i class="fa-solid fa-user-shield" style="margin-right:4px;"></i>${esc(c.confidentiality || "Standard")}${c.assignedTo ? ` · Assigned: ${esc(c.assignedTo)}` : ""}</span>
        </div>
      </div>
      ${wfStepperHtml("complaint", c)}
      <div class="app-modal-grid">
        <div class="app-field"><label>Confidentiality</label>
          <select id="cmconf-${c.id}" class="glass-input">${["Standard", "Restricted", "Strictly Confidential"].map((level) => `<option${level === (c.confidentiality || "Standard") ? " selected" : ""}>${level}</option>`).join("")}</select></div>
        <div class="app-field"><label>Assigned staff</label><input id="cmassign-${c.id}" class="glass-input" value="${esc(c.assignedTo || "")}"></div>
        <div class="app-field"><label>Resolution note (visible to student)</label><input id="cmnt-${c.id}" class="glass-input" value="${esc(c.note || "")}"></div>
        <div class="app-field full"><label>Internal staff notes (never visible to student)</label><input id="cmstaff-${c.id}" class="glass-input" value="${esc(c.staffNotes || "")}"></div>
      </div>
      <div class="ma-inline"><span>Edits to the fields above are saved separately from the status.</span><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="cmpUpdate('${esc(c.id)}','${esc(c.status)}')"><i class="fa-solid fa-floppy-disk"></i>Save details</button></div>
      ${wfFooterHtml("complaint", c.id, c)}
    </div>` });
}


function renderForms() {
  const el = document.getElementById("formsBody");
  if (!el) return;
  const nb = document.getElementById("frmNewBtn"); if (nb) nb.style.display = isAdmin() ? "" : "none";
  if (!el.dataset.built) {
    el.dataset.built = "1";
    el.innerHTML = `<div class="ml-toolbar"><span id="frmCount" class="ml-count"></span><div class="ml-tools"><label class="ml-search"><i class="fa-solid fa-magnifying-glass"></i><input id="frmSearch" type="search" autocomplete="off" placeholder="Search forms" aria-label="Search forms" oninput="window.__frmQ=this.value;renderFormsTable()"></label></div></div><div id="frmTable"></div>`;
  }
  renderFormsTable();
}
function frmIcon(name) { return fileIcon(name); }
function frmType(name) { const e = String(name || "").split(".").pop().toUpperCase(); return e.length <= 5 ? e : "FILE"; }
function frmDownload(id) {
  const f = MOD.forms.find((x) => x.id === id); if (!f) return;
  const a = document.createElement("a"); a.href = f.url; a.download = f.fileName || f.title; document.body.appendChild(a); a.click(); a.remove();
}
function renderFormsTable() {
  const box = document.getElementById("frmTable"); if (!box) return;
  const q = String(window.__frmQ || "").trim().toLowerCase();
  const list = [...MOD.forms].filter((f) => !q || `${f.title} ${f.fileName}`.toLowerCase().includes(q)).sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const cnt = document.getElementById("frmCount"); if (cnt) cnt.textContent = `${list.length} form${list.length === 1 ? "" : "s"}`;
  const rows = list.map((f) => {
    const id = esc(f.id), [d, t] = splitWhen(f.ts);
    return `<tr class="ml-tr" tabindex="0" onclick="frmDownload('${id}')" onkeydown="if(event.key==='Enter'&&event.target===this){frmDownload('${id}')}">
      <td class="c-svc"><div class="frm-name"><span class="frm-ic"><i class="fa-solid ${frmIcon(f.fileName)}"></i></span><div><div class="ml-svc">${esc(f.title)}</div><div class="ml-sub2">${esc(f.fileName)}</div></div></div></td>
      <td class="c-code"><span class="bl-cat">${esc(frmType(f.fileName))}</span></td>
      <td class="c-when"><div class="ml-d">${esc(d)}</div>${t ? `<div class="ml-t">${esc(t)}</div>` : ""}</td>
      <td class="c-act" onclick="event.stopPropagation()"><div class="ml-acts">${mlAct("fa-download", "Download " + f.title, `frmDownload('${id}')`, "ml-act-star")}${isAdmin() ? mlAct("fa-trash", "Remove this form", `frmDelete('${id}')`, "ml-act-bad") : ""}</div></td></tr>`;
  });
  box.innerHTML = mlTable(["Form", "Type", "Uploaded", "Actions"], rows, q ? "No forms match your search." : (isAdmin() ? "No forms uploaded yet." + mlEmptyCta("Upload a Form", "fa-upload", "openFormUpload") : "No forms available yet. Please check back soon."), "fa-file-arrow-down");
}
function openFormUpload() {
  openAppModal({ title: "Upload a form", subtitle: "Students can download it right away.", icon: "fa-upload", content: `
    <div class="bk-form">
      ${bkField("Form title", '<div class="bk-input"><input id="frmTitle" type="text" maxlength="120" placeholder="e.g. Excuse Slip Request Form"></div>', { req: true })}
      ${bkField("File", '<input id="frmFile" type="file" data-fu="1" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png">', { req: true })}
    </div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Cancel</button><button type="button" id="frmUpBtn" class="bk-btn bk-btn-fill bk-btn-sm" onclick="frmUpload()"><i class="fa-solid fa-upload"></i>Upload form</button></div>` });
}
async function frmUpload() {
  const t = document.getElementById("frmTitle").value.trim();
  const c = "General"; // forms are one flat list — no categories
  const inp = document.getElementById("frmFile");
  if (!t) { showToast("⚠️ Form title is required.", "rgba(180,130,0,.85)"); return; }
  if (!inp.files.length) { showToast("⚠️ Please choose a file.", "rgba(180,130,0,.85)"); return; }
  const btn = document.getElementById("frmUpBtn"); if (btn) btn.disabled = true;
  const uploaded = await uploadFile(inp);
  if (uploaded === false || !uploaded.url) { if (btn) btn.disabled = false; return; }
  const { ok, error } = await api("/api/modules/forms", { method: "POST", body: { title: t, cat: c, fileName: uploaded.fileName, url: uploaded.url } });
  if (!ok) { if (btn) btn.disabled = false; showToast(`❌ ${error || "Could not upload."}`, "rgba(155,22,22,.85)"); return; }
  closeAppModal();
  showToast("✅ Form uploaded.");
  await loadModule("forms"); renderForms();
}
function frmDelete(id) {
  const f = MOD.forms.find((x) => x.id === id); if (!f) return;
  openAppModal({ title: "Remove this form?", subtitle: "Students will no longer be able to download it.", icon: "fa-trash", content: `
    <div class="dm-kvs dm-kvs-box">${dmKv("Form", f.title)}${dmKv("File", f.fileName || "")}</div>
    <div class="app-modal-actions"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Keep form</button><button type="button" id="frmDelBtn" class="bk-btn bk-btn-danger bk-btn-sm" onclick="frmDeleteConfirm('${esc(id)}')">Remove form</button></div>` });
}
async function frmDeleteConfirm(id) {
  const btn = document.getElementById("frmDelBtn"); if (btn) btn.disabled = true;
  const { ok, error } = await api(`/api/modules/forms/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { if (btn) btn.disabled = false; showToast(`❌ ${error || "Could not remove."}`, "rgba(155,22,22,.85)"); return; }
  closeAppModal(); await loadModule("forms"); renderForms();
}


function renderMemo() {
  const el = document.getElementById("memoBody");
  if (!el) return;
  const courses = ["BSCS", "BSIT", "BSBA", "BSA", "BEED"];
  const years = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
  const memos = [...(MOD.memos || [])].reverse();
  el.innerHTML = `
    <div class="layout-ms sa-memo-layout">
      <div class="glass-card dl-card">
        <div class="dl-head">
          <div>
            <div class="dl-title"><i class="fa-solid fa-envelopes-bulk"></i>Compose Memo</div>
            <div class="dl-sub">Filter recipients by registration status, course, and year level.</div>
          </div>
        </div>
        <div class="sa-form-grid">
          <div class="sa-form-2">
            <div class="sa-field"><span class="input-label">Subject</span><input id="memoSubj" class="glass-input" placeholder="e.g., MEMO: Enrollment Schedule for 1st Semester"></div>
            <div class="sa-field"><span class="input-label">Recipients</span>
              <select id="memoSource" class="glass-input" onchange="memoRecipientOptions()">
                <option value="REGISTERED">Registered Students</option>
                <option value="MASTERLIST">CSV Masterlist Unregistered</option>
              </select>
            </div>
          </div>
          <div class="sa-subbox">
            <div class="sa-form-2">
              <div class="sa-field"><span class="input-label">Course</span><select id="memoCourse" class="glass-input"><option value="">All courses</option>${courses.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></div>
              <div class="sa-field"><span class="input-label">Year Level</span><select id="memoYear" class="glass-input"><option value="">All year levels</option>${years.map((y) => `<option value="${y}">${y}</option>`).join("")}</select></div>
            </div>
            <label id="memoIncludeUnregisteredLabel" class="sa-check"><input id="memoIncludeUnregistered" type="checkbox"> Include matching CSV Masterlist unregistered students</label>
            <div class="sa-hint">Example: choose BSIT + 1st Year and check the box above to also email unregistered students from the CSV masterlist.</div>
          </div>
          <div class="sa-field"><span class="input-label">Message</span><textarea id="memoBodyTxt" class="glass-input" rows="6" maxlength="2000" placeholder="Write the memorandum\u2026" oninput="memoCount()"></textarea><span class="sa-hint" id="memoCount" style="text-align:right;">0 / 2000</span></div>
          <div class="sa-form-foot">
            <span class="sa-hint"><i class="fa-solid fa-bell" style="margin-right:5px;color:var(--bk-maroon);"></i>Registered students receive this in their <b>Notifications</b>${EMAIL_CONFIGURED ? " and by email" : ""}.</span>
            <button type="button" onclick="memoSend()" class="bk-btn bk-btn-fill"><i class="fa-solid fa-paper-plane"></i>Send Blast</button>
          </div>
        </div>
      </div>

      <div class="glass-card dl-card">
        <div class="dl-head">
          <div>
            <div class="dl-title"><i class="fa-solid fa-clock-rotate-left"></i>Blast History</div>
            <div class="dl-sub">${memos.length} sent memorandum${memos.length === 1 ? "" : "s"}</div>
          </div>
        </div>
        ${memos.length ? `<div class="sa-memo-list">${memos.map((m) => `
          <div class="sa-memo-item">
            <div class="sa-memo-top">
              <div class="sa-memo-subj">${esc(m.subject)}</div>
              <span class="st-chip ${/partial/i.test(m.mode || "") ? "st-warn" : "st-ok"}"><i></i>${/partial/i.test(m.mode || "") ? "Partly delivered" : "Delivered"}</span>
            </div>
            <div class="sa-memo-meta">${esc(m.audienceLabel)} · ${m.recipients} recipient${m.recipients === 1 ? "" : "s"}</div>
            <div class="sa-memo-meta">${esc(m.ts)} · by ${esc(m.by)}</div>
          </div>`).join("")}</div>` : `<div class="dt-empty" style="padding:36px 16px;"><i class="fa-solid fa-envelope-open-text"></i><div>No memos sent yet.</div></div>`}
      </div>
    </div>`;
}
async function memoSend() {
  const subj = document.getElementById("memoSubj").value.trim();
  const body = document.getElementById("memoBodyTxt").value.trim();
  const source = document.getElementById("memoSource").value;
  const includeUnregistered = document.getElementById("memoIncludeUnregistered").checked;
  const course = document.getElementById("memoCourse").value;
  const year = document.getElementById("memoYear").value;
  const sourceLabel = document.getElementById("memoSource").selectedOptions[0].textContent;
  const filterLabel = [course, year].filter(Boolean).join(" · ") || "All courses and year levels";
  const audLabel = source === "REGISTERED" && includeUnregistered ? `${sourceLabel} + CSV Masterlist Unregistered (${filterLabel})` : `${sourceLabel} (${filterLabel})`;
  if (!subj || !body) { showToast("⚠️ Subject and message are required.", "rgba(180,130,0,.85)"); return; }
  const { ok, error, data } = await api("/api/modules/memos", { method: "POST", body: { subject: subj, body, recipientSource: source, includeUnregistered, course, year, audienceLabel: audLabel } });
  if (!ok) { showToast(`❌ ${error || "Could not send memo."}`, "rgba(155,22,22,.85)"); return; }
  const n = data?.recipients;
  showToast(`📧 Memo sent${n ? ` to ${n} student${n === 1 ? "" : "s"}` : ""}.`);
  await loadModule("memos"); renderMemo();
}
function memoCount() { const t = document.getElementById("memoBodyTxt"), c = document.getElementById("memoCount"); if (t && c) c.textContent = `${t.value.length} / 2000`; }
function memoRecipientOptions() {
  const source = document.getElementById("memoSource")?.value;
  const check = document.getElementById("memoIncludeUnregistered");
  const label = document.getElementById("memoIncludeUnregisteredLabel");
  if (!check || !label) return;
  const isMasterlistOnly = source === "MASTERLIST";
  if (isMasterlistOnly) check.checked = false;
  check.disabled = isMasterlistOnly;
  label.style.opacity = isMasterlistOnly ? ".55" : "1";
  label.title = isMasterlistOnly ? "CSV Masterlist Unregistered is already selected." : "";
}


function myNotifs() { return NOTIFS; } // server already scopes this to the caller
function updateBellBadge() {
  const unread = myNotifs().filter((n) => !n.read).length;
  document.querySelectorAll(".notification-badge").forEach((b) => {
    if (unread > 0) { b.textContent = unread > 9 ? "9+" : unread; b.style.display = "flex"; }
    else b.style.display = "none";
  });
}
function playNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const context = new AudioCtx();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.045, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.32);
    gain.connect(context.destination);
    [660, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, context.currentTime + index * 0.1);
      oscillator.connect(gain);
      oscillator.start(context.currentTime + index * 0.1);
      oscillator.stop(context.currentTime + 0.32);
    });
  } catch (_) {  }
}
function startNotificationPolling() {
  if (notificationPollingStarted) return;
  notificationPollingStarted = true;
  window.setInterval(async () => {
    if (!session) return;
    await loadNotifs();
    const newItems = NOTIFS.filter((n) => !knownNotificationIds.has(n.id));
    if (newItems.length) {
      playNotificationSound();
      showIncomingNotifications(newItems);
    }
    NOTIFS.forEach((n) => knownNotificationIds.add(n.id));
    updateBellBadge();
  }, 10000);
}

function showIncomingNotifications(items) {
  const newest = items[items.length - 1];
  if (!newest) return;
  showToast(`New notification: ${newest.title}`, "rgba(21, 80, 110, .92)");
  const panel = document.getElementById("bellPanel");
  if (!panel) return;
  renderBellPanel();
  positionBellPanel();
  panel.style.display = "block";
  window.setTimeout(() => {
    if (panel.style.display === "block") panel.style.display = "none";
  }, 9000);
}

function startAdminDashboardPolling() {
  if (adminDashboardPollingStarted || !isAdmin()) return;
  adminDashboardPollingStarted = true;
  adminDashboardSnapshot = JSON.stringify({
    appointments: queueData.map((q) => `${q.q}:${q.status}`),
  });
  window.setInterval(async () => {
    if (!session || !isAdmin() || adminDashboardRefreshInFlight || document.querySelector(".page.active")?.id !== "page-admin") return;
    adminDashboardRefreshInFlight = true;
    try {
      await Promise.all([loadQueueData(), loadAdminActivity(), loadPendingAccounts()]);
      const nextSnapshot = JSON.stringify({
        appointments: queueData.map((q) => `${q.q}:${q.status}`),
      });
      if (nextSnapshot === adminDashboardSnapshot) return;
      adminDashboardSnapshot = nextSnapshot;
      if (donutChart) { try { donutChart.destroy(); } catch {} donutChart = null; }
      if (barChartInst) { try { barChartInst.destroy(); } catch {} barChartInst = null; }
      renderAdminPage();
    } finally {
      adminDashboardRefreshInFlight = false;
    }
  }, 15000);
}
function notificationDestination(notification) {
  const text = `${notification.title} ${notification.body}`.toLowerCase();
  if (text.includes("complaint")) return "page-complaint";
  if (text.includes("referral")) return "page-referral";
  if (text.includes("id application") || text.includes("student id")) return "page-idapp";
  if (text.includes("ticket") || text.includes("help desk")) return "page-helpdesk";
  if (text.includes("announcement") || text.includes("bulletin")) return "page-bulletin";
  if (text.includes("memo")) return "page-memo";
  if (text.includes("form")) return "page-forms";
  if (text.includes("appointment")) return isAdmin() ? "page-admin" : "page-appointment";
  if (text.includes("document request") || text.includes("claim")) return isAdmin() ? "page-admin" : "page-student";
  if (text.includes("account approval") || text.includes("new student account") || text.includes("profile update") || text.includes("masterlist")) return isAdmin() ? "page-admin" : "page-student";
  return isAdmin() ? "page-admin" : "page-student";
}
async function openNotification(id) {
  const notification = NOTIFS.find((n) => n.id === id);
  if (!notification) return;
  notification.read = true;
  updateBellBadge();
  await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
  const panel = document.getElementById("bellPanel"); if (panel) panel.style.display = "none";
  await goTo(notificationDestination(notification));
}
async function toggleBell() {
  const p = document.getElementById("bellPanel");
  if (!p) return;
  if (p.style.display === "block") { p.style.display = "none"; return; }
  renderBellPanel();
  positionBellPanel();
  p.style.display = "block";
  await loadNotifs();
  if (p.style.display === "block") renderBellPanel();
}
function positionBellPanel() {
  const panel = document.getElementById("bellPanel");
  const toggle = document.getElementById("topBell");
  if (!panel || !toggle) return;
  const rect = toggle.getBoundingClientRect();
  const panelWidth = Math.min(340, window.innerWidth * .92);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
  panel.style.left = `${left}px`;
  panel.style.right = "auto";
  panel.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 80)}px`;
}
function renderBellPanel() {
  const p = document.getElementById("bellPanel");
  if (!p) return;
  const mine = [...myNotifs()].reverse();
  p.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid rgba(139,26,26,.12);">
      <span style="font-size:13px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-bell" style="color:#8B1A1A;margin-right:6px;"></i>Notifications</span>
      <button onclick="clearMyNotifs()" class="btn-ghost" style="padding:4px 9px;font-size:10px;">Clear all</button>
    </div>
    <div style="max-height:320px;overflow-y:auto;">
      ${mine.length ? mine.map((n) => `
        <button data-notification-id="${n.id}" onclick="openNotification('${n.id}')" style="width:100%;text-align:left;border:0;background:${n.read ? "transparent" : "rgba(245,197,24,.08)"};padding:10px 14px;border-bottom:1px solid rgba(139,26,26,.06);cursor:pointer;font-family:inherit;transition:opacity .5s ease;${n.read ? "opacity:.52;" : ""}">
          <div style="font-size:12px;font-weight:800;color:#1a0505;">${n.read ? "" : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#8B1A1A;margin-right:5px;"></span>'}${esc(n.title)}</div>
          <div style="font-size:11px;color:rgba(30,5,5,.75);margin-top:2px;">${esc(n.body)}</div>
          <div style="font-size:9px;color:rgba(30,5,5,.45);margin-top:3px;">${esc(n.ts)}</div>
        </button>`).join("")
      : '<div style="padding:22px;text-align:center;font-size:12px;color:rgba(30,5,5,.5);">No notifications yet.</div>'}
    </div>`;
  
  window.setTimeout(() => p.querySelectorAll("button[data-notification-id]").forEach((item) => {
    if (!NOTIFS.find((n) => n.id === item.dataset.notificationId)?.read) item.style.opacity = ".62";
  }), 7000);
}
async function clearMyNotifs() {
  if (!session) return;
  await api("/api/notifications", { method: "DELETE" });
  NOTIFS = [];
  updateBellBadge();
  const p = document.getElementById("bellPanel"); if (p) p.style.display = "none";
}


function renderAcctApprovals() {
  const wrap = document.getElementById("acctApprovalsWrap");
  if (!wrap) return;
  const pending = PENDING_ACCOUNTS;
  const verifyHtml = acctVerifyHtml();
  if (!pending.length) { BATCH_SEL.accounts.clear(); wrap.innerHTML = verifyHtml; return; }
  const validIds = new Set(pending.map((u) => u.id));
  for (const id of [...BATCH_SEL.accounts]) { if (!validIds.has(id)) BATCH_SEL.accounts.delete(id); }
  const selCount = BATCH_SEL.accounts.size;
  wrap.innerHTML = `
    <div class="glass-card" style="overflow:hidden;border:1px solid rgba(245,197,24,.45);">
      <div style="padding:16px 20px;border-bottom:1px solid rgba(139,26,26,.1);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" class="batch-chk" ${selCount === pending.length ? "checked" : ""} onchange="toggleBatchSelectAll('accounts', this.checked)" aria-label="Select all pending accounts">
          <span style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-user-clock" style="color:#C8890F;margin-right:8px;"></i>Account Approvals</span>
          <span style="font-size:10px;font-weight:800;background:rgba(245,197,24,.2);border:1px solid rgba(212,160,23,.5);color:#7a4f00;border-radius:99px;padding:3px 9px;">${pending.length} pending</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <button type="button" onclick="batchApproveAccounts(true)" class="btn-maroon" style="padding:6px 12px;font-size:11px;" ${selCount ? "" : "disabled"}><i class="fa-solid fa-check-double" style="margin-right:4px;"></i>Approve Selected (${selCount})</button>
          <button type="button" onclick="batchApproveAccounts(false)" class="btn-ghost" style="padding:6px 12px;font-size:11px;color:#b91c1c;" ${selCount ? "" : "disabled"}><i class="fa-solid fa-xmark" style="margin-right:4px;"></i>Reject Selected</button>
          ${pending.length > 1 ? `<button type="button" onclick="batchApproveAccounts(true, true)" class="btn-gold" style="padding:6px 12px;font-size:11px;"><i class="fa-solid fa-bolt" style="margin-right:4px;"></i>Approve All (${pending.length})</button>` : ""}
        </div>
      </div>
      <div style="padding:8px 20px 14px;">
        ${pending.map((u) => `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid rgba(139,26,26,.06);">
            <div style="display:flex;align-items:center;gap:10px;">
              <input type="checkbox" class="batch-chk" data-batch="accounts" value="${esc(u.id)}" ${BATCH_SEL.accounts.has(u.id) ? "checked" : ""} onchange="toggleBatchItem('accounts','${esc(u.id)}',this.checked)" aria-label="Select ${esc(u.id)}">
              <div>
                <div style="font-size:13px;font-weight:800;color:#1a0505;">${esc(u.name)}</div>
                <div style="font-size:11px;font-family:monospace;color:rgba(30,5,5,.6);">${esc(u.id)} · ${esc(u.email)} · ${esc(u.course || "")} ${esc(u.year || "")}</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;">
              <button onclick="acctApprove('${esc(u.id)}')" style="background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:#15803d;font-weight:800;padding:7px 14px;border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-check" style="margin-right:4px;"></i>Approve</button>
              <button onclick="acctReject('${esc(u.id)}')" style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#b91c1c;font-weight:800;padding:7px 14px;border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-xmark" style="margin-right:4px;"></i>Reject</button>
            </div>
          </div>`).join("")}
      </div>
    </div>${verifyHtml ? `<div style="margin-top:16px;">${verifyHtml}</div>` : ""}`;
}
function acctVerifyHtml() {
  const list = UNVERIFIED_ACCOUNTS || [];
  if (!list.length) return "";
  return `<div class="glass-card" style="overflow:hidden;">
    <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-user-shield" style="color:var(--maroon);margin-right:8px;"></i>Needs Verification</span>
      <span class="st-chip st-warn"><i></i>${list.length} not on masterlist</span>
      <span style="font-size:12px;color:var(--text-muted);">These students signed up with a student number that is not listed yet. They can sign in but cannot book until you confirm them.</span>
    </div>
    <div style="padding:6px 20px 12px;">
      ${list.map((u) => `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border);">
        <div>
          <div style="font-size:13px;font-weight:800;color:#1a0505;">${esc(u.name)}</div>
          <div style="font-size:11px;font-family:monospace;color:var(--text-muted);">${esc(u.id)} · ${esc(u.email)} · ${esc(u.course)} ${esc(u.year)}</div>
          ${u.listedAs ? `<div class="ml-sub2" style="color:#b45309;"><i class="fa-solid fa-triangle-exclamation"></i> This number is listed under &ldquo;${esc(u.listedAs)}&rdquo;. Check before verifying.</div>` : ""}
        </div>
        <div class="ml-acts">
          <button type="button" class="bk-btn bk-btn-out bk-btn-sm" title="Remove this account" onclick="acctVerify('${esc(u.id)}', false)"><i class="fa-solid fa-xmark"></i>Reject</button>
          <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" title="Confirm this student and add them to the masterlist" onclick="acctVerify('${esc(u.id)}', true)"><i class="fa-solid fa-user-check"></i>Verify</button>
        </div>
      </div>`).join("")}
    </div>
  </div>`;
}
async function acctVerify(sn, verify) {
  if (!verify && !confirm(`Remove the account of ${sn}? They will be told to visit the SSO.`)) return;
  const { ok, error } = await api(`/api/users/${encodeURIComponent(sn)}/verify`, { method: "PATCH", body: { verify } });
  if (!ok) { showToast(`❌ ${error || "Could not update the account."}`, "rgba(155,22,22,.85)"); return; }
  showToast(verify ? "✅ Student verified and added to the masterlist." : "Account removed.");
  await loadPendingAccounts();
  renderAcctApprovals();
  if (document.getElementById("page-accounts")?.classList.contains("active")) await loadAccountsPage();
}
async function acctApprove(sn) {
  const { ok, error } = await api(`/api/users/${encodeURIComponent(sn)}/approve`, { method: "PATCH", body: { approve: true } });
  if (!ok) { showToast(`❌ ${error || "Could not approve."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`✅ Account approved.`);
  await loadPendingAccounts(); await loadAuditLog();
  renderAcctApprovals(); renderAuditLog();
}
async function acctReject(sn) {
  if (!confirm(`Reject and remove the account of ${sn}?`)) return;
  const { ok, error } = await api(`/api/users/${encodeURIComponent(sn)}/approve`, { method: "PATCH", body: { approve: false } });
  if (!ok) { showToast(`❌ ${error || "Could not reject."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`Account rejected and removed.`);
  await loadPendingAccounts(); await loadAuditLog();
  renderAcctApprovals(); renderAuditLog();
}


function renderEmailOutbox() {
  const badge = document.getElementById("emailModeBadge");
  if (badge) {
    badge.innerHTML = EMAIL_CONFIGURED
      ? '<span style="color:#16a34a;">● LIVE — real emails</span>'
      : '<span style="color:#d97706;">● SIMULATED — set SMTP_* in .env to send for real</span>';
  }
  const el = document.getElementById("emailOutbox");
  if (!el) return;
  if (!EMAIL_LOG.length) {
    el.innerHTML = '<div style="color:rgba(30,5,5,.5);padding:6px 0;">No notifications yet. Approving or rejecting a request will email the student automatically.</div>';
    return;
  }
  const tag = (m) => ({
    SENT: '<span style="color:#16a34a;font-weight:800;">SENT</span>',
    SIMULATED: '<span style="color:#d97706;font-weight:800;">SIMULATED</span>',
    FAILED: '<span style="color:#dc2626;font-weight:800;">FAILED</span>',
    NO_EMAIL: '<span style="color:#dc2626;font-weight:800;">NO EMAIL</span>',
  }[m] || m);
  el.innerHTML = [...EMAIL_LOG].reverse().map((e) => `
    <div style="padding:8px 10px;margin-bottom:6px;background:rgba(255,255,255,.55);border:1px solid rgba(139,26,26,.1);border-radius:10px;">
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <span style="font-weight:700;color:#1a0505;">${e.name} · ${e.status}</span><span>${tag(e.mode)}</span>
      </div>
      <div style="font-size:11px;color:rgba(30,5,5,.6);margin-top:2px;">${e.to ? "✉ " + e.to : "⚠ no email on file"} · ${e.ref} · ${e.doc}</div>
      <div style="font-size:10px;color:rgba(30,5,5,.45);font-family:monospace;margin-top:2px;">${e.ts}${e.error ? " · " + e.error : ""}</div>
    </div>`).join("");
}


function mountVersionBadge() {
  const vb = document.createElement("div");
  vb.style.cssText = "position:fixed;bottom:8px;right:12px;font-size:10px;font-weight:800;color:rgba(30,5,5,.45);z-index:60;pointer-events:none;letter-spacing:.04em;";
  vb.textContent = "STARS v" + APP_VERSION;
  document.body.appendChild(vb);
}


(async function init() {
  mountVersionBadge();
  document.addEventListener("pointerdown", (event) => {
    const panel = document.getElementById("bellPanel");
    const toggle = document.getElementById("topBell");
    if (!panel || panel.style.display !== "block") return;
    if (!panel.contains(event.target) && !toggle?.contains(event.target)) panel.style.display = "none";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const panel = document.getElementById("bellPanel");
      if (panel) panel.style.display = "none";
    }
  });
  await Promise.all([refreshMasterlistStatus(), loadRegistrationCourses()]);
  try {
    await restoreSession(); // silently signs the user back in if their cookie is still valid
  } finally {
    const overlay = document.getElementById("authLoadingOverlay");
    if (overlay) { overlay.classList.add("ld2-out"); setTimeout(() => { overlay.style.display = "none"; }, 220); }
  }

window.doForgotPassword = function doForgotPassword() {
  window.location.assign("/forgot-password");
}

})();


async function loadSystemPage() {
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Analytics is restricted to Super Admin.", "rgba(139,26,26,.9)"); const box0 = document.getElementById("systemBody"); if (box0) box0.innerHTML = `<div class="empty-state" style="padding:24px;">Restricted to Super Admin.</div>`; return; }
  const box = document.getElementById("systemBody");
  if (box) box.innerHTML = `<div class="insight-skeleton">
      <div class="grid-4" style="margin-bottom:16px;">
        <div class="stat-card ac-maroon"><div class="insight-shimmer" style="height:12px;width:55%;border-radius:6px;"></div><div class="insight-shimmer" style="height:34px;width:40%;border-radius:8px;margin-top:10px;"></div></div>
        <div class="stat-card ac-gold"><div class="insight-shimmer" style="height:12px;width:55%;border-radius:6px;"></div><div class="insight-shimmer" style="height:34px;width:40%;border-radius:8px;margin-top:10px;"></div></div>
        <div class="stat-card ac-green"><div class="insight-shimmer" style="height:12px;width:55%;border-radius:6px;"></div><div class="insight-shimmer" style="height:34px;width:40%;border-radius:8px;margin-top:10px;"></div></div>
        <div class="stat-card ac-blue"><div class="insight-shimmer" style="height:12px;width:55%;border-radius:6px;"></div><div class="insight-shimmer" style="height:34px;width:40%;border-radius:8px;margin-top:10px;"></div></div>
      </div>
      <div class="glass-card" style="padding:22px;text-align:center;font-size:12px;color:rgba(30,5,5,.55);"><span class="spinner" style="border-color:rgba(139,26,26,.2);border-top-color:#8B1A1A;"></span> Loading insights…</div>
    </div>`;
  const qs = new URLSearchParams();
  if (ANALYTICS_RANGE.from) qs.set("from", ANALYTICS_RANGE.from);
  if (ANALYTICS_RANGE.to) qs.set("to", ANALYTICS_RANGE.to);
  const analyticsUrl = `/api/reports/analytics${qs.toString() ? `?${qs.toString()}` : ""}`;
  const [analytics, faq] = await Promise.all([api(analyticsUrl), api("/api/faq-analytics")]);
  window.__qrsAnalytics = analytics.ok ? analytics.data : null;
  window.__qrsFaqUsage = faq.ok ? faq.data : null;
  window.__qrsSystemLoadedAt = new Date();
  renderSystemPage();
}
let SYS_TAB = "overview";
let SYS_FB_STAR = "all";
let SYS_FB_Q = "";
let SYS_FB_COMMENTS_ONLY = false;
window.__anCharts = window.__anCharts || {};

function setSysTab(k) { SYS_TAB = k; renderSystemPage(); }
function setSysFbStar(v) { SYS_FB_STAR = v || "all"; renderSystemFeedbackList(); }
function setSysFbQuery(v) { SYS_FB_Q = String(v || ""); renderSystemFeedbackList(); }
function setSysFbCommentsOnly(checked) { SYS_FB_COMMENTS_ONLY = Boolean(checked); renderSystemFeedbackList(); }
function anRangeChange(v) {
  if (v === "custom") { ANALYTICS_RANGE.preset = "custom"; renderSystemPage(); return; }
  setAnalyticsPreset(v);
}

function destroyAnalyticsCharts() {
  Object.values(window.__anCharts || {}).forEach((ch) => { try { ch && ch.destroy(); } catch {} });
  window.__anCharts = {};
}

function renderSystemFeedbackList() {
  const host = document.getElementById("anFeedbackList");
  const countEl = document.getElementById("anFeedbackCount");
  if (!host) return;
  const csat = window.__qrsAnalytics && window.__qrsAnalytics.csat;
  const all = (csat && csat.recent) || [];
  let shown = all;
  if (SYS_FB_STAR === "5") shown = shown.filter((r) => r.rating === 5);
  else if (SYS_FB_STAR === "4") shown = shown.filter((r) => r.rating === 4);
  else if (SYS_FB_STAR === "3") shown = shown.filter((r) => r.rating === 3);
  else if (SYS_FB_STAR === "low") shown = shown.filter((r) => r.rating <= 2);
  if (SYS_FB_COMMENTS_ONLY) shown = shown.filter((r) => r.comment && r.comment.trim());
  const q = SYS_FB_Q.trim().toLowerCase();
  if (q) shown = shown.filter((r) => `${r.serviceLabel} ${r.requestId} ${r.studentId} ${r.comment || ""}`.toLowerCase().includes(q));

  if (countEl) countEl.textContent = `${shown.length} of ${all.length} response${all.length === 1 ? "" : "s"}`;

  // Sync active star filter button states
  document.querySelectorAll("[data-fb-star]").forEach((btn) => {
    const on = btn.getAttribute("data-fb-star") === SYS_FB_STAR;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  });

  if (!shown.length) {
    host.innerHTML = `<div class="dt-empty ml-empty" style="padding:36px 16px;"><i class="fa-solid fa-comment-dots"></i><div>${all.length ? "No feedback matches your filters." : "No student feedback recorded in this period yet."}</div></div>`;
    return;
  }

  host.innerHTML = `<div class="an-fb-grid">${shown.map((r) => {
    const tone = r.rating >= 4 ? "st-ok" : (r.rating === 3 ? "st-warn" : "st-bad");
    return `
      <article class="an-fb-card">
        <div class="an-fb-top">
          <div class="an-fb-meta-l">
            <span class="an-fb-svc">${esc(r.serviceLabel)}</span>
            <span class="ml-code">${esc(r.requestId)}</span>
          </div>
          <span class="st-chip ${tone}"><i></i>${r.rating}/5 ★</span>
        </div>
        <div class="an-fb-stars">${hdStarsHtml(r.rating)}</div>
        ${r.comment ? `<p class="an-fb-comment">“${esc(r.comment)}”</p>` : `<p class="an-fb-nocomment">Rated without additional comment.</p>`}
        <div class="an-fb-foot">
          <span><i class="fa-regular fa-id-badge" style="margin-right:4px;"></i>${esc(r.studentId)}</span>
          <span>${esc(r.ts)}</span>
        </div>
      </article>`;
  }).join("")}</div>`;
}

function mountAnalyticsCharts(a, f) {
  destroyAnalyticsCharts();
  if (typeof window.Chart === "undefined" || !a) return;
  const ChartLib = window.Chart;
  const font = { family: "Inter, system-ui, -apple-system, sans-serif", size: 11.5 };
  const gridColor = "#F3E8EA";
  const tickColor = "#6B5557";
  const maroon = "#7A0F1F";
  const maroonSoft = "rgba(122, 15, 31, 0.14)";
  const gold = "#D4A017";
  const goldSoft = "rgba(212, 160, 23, 0.16)";

  const make = (id, cfg) => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    window.__anCharts[id] = new ChartLib(canvas, cfg);
  };

  if (SYS_TAB === "overview") {
    const trend = a.trend || [];
    if (trend.length) {
      make("anChartTrend", {
        type: "line",
        data: {
          labels: trend.map((t) => t.label),
          datasets: [
            {
              label: "Appointments",
              data: trend.map((t) => t.appointments),
              borderColor: maroon,
              backgroundColor: maroonSoft,
              fill: true,
              tension: 0.35,
              borderWidth: 2.5,
              pointRadius: 3.5,
              pointHoverRadius: 5,
              pointBackgroundColor: maroon,
            },
            {
              label: "Service Requests",
              data: trend.map((t) => t.requests),
              borderColor: gold,
              backgroundColor: goldSoft,
              fill: true,
              tension: 0.35,
              borderWidth: 2,
              pointRadius: 3,
              pointHoverRadius: 5,
              pointBackgroundColor: gold,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { position: "top", align: "end", labels: { boxWidth: 10, usePointStyle: true, font, color: "#1F1415" } },
          },
          scales: {
            x: { grid: { display: false }, ticks: { font, color: tickColor } },
            y: { beginAtZero: true, grid: { color: gridColor }, ticks: { precision: 0, font, color: tickColor } },
          },
        },
      });
    }

    const ops = a.operations;
    if (ops && ops.totalAppointments > 0) {
      make("anChartOutcomes", {
        type: "doughnut",
        data: {
          labels: ["Served", "Active / Pending", "No-Show", "Cancelled"],
          datasets: [{
            data: [ops.servedCount, ops.activeCount + ops.pendingCount, ops.noShowCount, ops.cancelledCount],
            backgroundColor: ["#15803D", "#1D4ED8", "#D97706", "#B42318"],
            borderWidth: 2,
            borderColor: "#FFFFFF",
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "68%",
          plugins: { legend: { display: false } },
        },
      });
    }

    const svcs = (a.services || []).slice(0, 7);
    if (svcs.length) {
      make("anChartServices", {
        type: "bar",
        data: {
          labels: svcs.map((s) => s.label),
          datasets: [{
            label: "Appointments",
            data: svcs.map((s) => s.count),
            backgroundColor: maroon,
            borderRadius: 6,
            maxBarThickness: 22,
          }],
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { beginAtZero: true, grid: { color: gridColor }, ticks: { precision: 0, font, color: tickColor } },
            y: { grid: { display: false }, ticks: { font, color: "#1F1415" } },
          },
        },
      });
    }

    const peaks = (a.peakTimes || []).slice(0, 8);
    if (peaks.length) {
      make("anChartPeaks", {
        type: "bar",
        data: {
          labels: peaks.map((p) => p.label),
          datasets: [{
            label: "Bookings",
            data: peaks.map((p) => p.count),
            backgroundColor: "#A6283B",
            hoverBackgroundColor: maroon,
            borderRadius: 6,
            maxBarThickness: 32,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { font, color: tickColor } },
            y: { beginAtZero: true, grid: { color: gridColor }, ticks: { precision: 0, font, color: tickColor } },
          },
        },
      });
    }
  } else if (SYS_TAB === "satisfaction" && a.csat) {
    const dist = a.csat.distribution || [];
    if (dist.some((d) => d.count > 0)) {
      make("anChartCsatDist", {
        type: "bar",
        data: {
          labels: dist.map((d) => `${d.star} Stars`),
          datasets: [{
            label: "Ratings",
            data: dist.map((d) => d.count),
            backgroundColor: ["#15803D", "#22A05B", "#D99B08", "#D97706", "#B42318"],
            borderRadius: 6,
            maxBarThickness: 22,
          }],
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { beginAtZero: true, grid: { color: gridColor }, ticks: { precision: 0, font, color: tickColor } },
            y: { grid: { display: false }, ticks: { font, color: "#1F1415" } },
          },
        },
      });
    }

    const bySvc = (a.csat.byService || []).slice(0, 7);
    if (bySvc.length) {
      make("anChartCsatSvc", {
        type: "bar",
        data: {
          labels: bySvc.map((s) => `${s.label} (${s.count})`),
          datasets: [{
            label: "Avg Rating",
            data: bySvc.map((s) => s.average),
            backgroundColor: maroon,
            borderRadius: 6,
            maxBarThickness: 22,
          }],
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { beginAtZero: true, max: 5, grid: { color: gridColor }, ticks: { stepSize: 1, font, color: tickColor } },
            y: { grid: { display: false }, ticks: { font, color: "#1F1415" } },
          },
        },
      });
    }
  } else if (SYS_TAB === "students") {
    const courses = [...(a.byCourse || [])].sort((x, y) => y.count - x.count).slice(0, 8);
    if (courses.length) {
      make("anChartCourse", {
        type: "bar",
        data: {
          labels: courses.map((c) => c.label),
          datasets: [{
            label: "Students",
            data: courses.map((c) => c.count),
            backgroundColor: maroon,
            borderRadius: 6,
            maxBarThickness: 24,
          }],
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { beginAtZero: true, grid: { color: gridColor }, ticks: { precision: 0, font, color: tickColor } },
            y: { grid: { display: false }, ticks: { font, color: "#1F1415" } },
          },
        },
      });
    }

    const years = a.byYear || [];
    if (years.length) {
      make("anChartYear", {
        type: "doughnut",
        data: {
          labels: years.map((y) => y.label),
          datasets: [{
            data: years.map((y) => y.count),
            backgroundColor: ["#7A0F1F", "#B84354", "#D4A017", "#1D4ED8", "#15803D", "#8B7D80"],
            borderWidth: 2,
            borderColor: "#FFFFFF",
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "64%",
          plugins: {
            legend: { position: "right", labels: { boxWidth: 10, usePointStyle: true, font, color: "#1F1415" } },
          },
        },
      });
    }
  } else if (SYS_TAB === "assistant" && a.assistant) {
    const q = a.assistant.queries || {};
    if ((q.high || 0) + (q.medium || 0) + (q.low || 0) > 0) {
      make("anChartAsstConf", {
        type: "doughnut",
        data: {
          labels: ["High (Auto-answered)", "Medium (Clarified)", "Low (Escalated)"],
          datasets: [{
            data: [q.high || 0, q.medium || 0, q.low || 0],
            backgroundColor: ["#15803D", "#D99B08", "#B42318"],
            borderWidth: 2,
            borderColor: "#FFFFFF",
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "64%",
          plugins: {
            legend: { position: "right", labels: { boxWidth: 10, usePointStyle: true, font, color: "#1F1415" } },
          },
        },
      });
    }
    const fb = a.assistant.feedback || { up: 0, down: 0 };
    if ((fb.up || 0) + (fb.down || 0) > 0) {
      make("anChartAsstFb", {
        type: "bar",
        data: {
          labels: ["Helpful (Thumbs Up)", "Not Helpful (Thumbs Down)"],
          datasets: [{
            label: "Ratings",
            data: [fb.up || 0, fb.down || 0],
            backgroundColor: ["#15803D", "#B42318"],
            borderRadius: 8,
            maxBarThickness: 44,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { font, color: "#1F1415" } },
            y: { beginAtZero: true, grid: { color: gridColor }, ticks: { precision: 0, font, color: tickColor } },
          },
        },
      });
    }
  }
}

function renderSystemPage() {
  const box = document.getElementById("systemBody");
  if (!box) return;
  const a = window.__qrsAnalytics;
  const f = window.__qrsFaqUsage;
  const loadedAt = window.__qrsSystemLoadedAt ? fnow(window.__qrsSystemLoadedAt) : "";
  const sum = (items) => (items || []).reduce((t, x) => t + (Number(x.count) || 0), 0);
  const totalStudents = a ? sum(a.byCourse) : 0;
  const totalAppointments = a ? sum(a.services) : 0;
  const totalQueries = f ? (Number(f.totalQueries) || 0) : 0;
  const asst = a && a.assistant ? a.assistant : null;
  const ops = a && a.operations ? a.operations : null;
  const csat = a && a.csat ? a.csat : null;
  const asstTotal = asst && asst.queries ? (Number(asst.queries.total) || 0) : 0;
  const asstHigh = asst && asst.queries ? (Number(asst.queries.high) || 0) : 0;
  const answerRate = asstTotal ? Math.round((asstHigh / asstTotal) * 100) : 0;
  const rangeBadge = ANALYTICS_RANGE.from || ANALYTICS_RANGE.to ? `${ANALYTICS_RANGE.from || "Beginning"} → ${ANALYTICS_RANGE.to || "Today"}` : "All Time";
  const printBtn = document.getElementById("sysPrintBtn");
  if (printBtn) printBtn.disabled = !a;

  const kpi = (icon, label, value, sub) => `
    <div class="stat-card sd-kpi">
      <div class="stat-card-top">
        <div class="input-label kpi-title" style="margin-bottom:0;"><i class="kpi-gi fa-solid ${icon}" aria-hidden="true"></i>${esc(label)}</div>
      </div>
      <div class="sd-kpi-mid"><span class="sd-kpi-val">${esc(value)}</span></div>
      <div class="sd-kpi-sub">${esc(sub)}</div>
    </div>`;

  const chartCard = (icon, title, sub, canvasId, hasData, emptyMsg, extraHtml, badgeHtml) => `
    <div class="glass-card dl-card">
      <div class="dl-head">
        <div>
          <div class="dl-title"><i class="fa-solid ${icon}"></i>${esc(title)}</div>
          ${sub ? `<div class="dl-sub">${esc(sub)}</div>` : ""}
        </div>
        ${badgeHtml || ""}
      </div>
      ${hasData
        ? `<div class="an-chart-wrap"><canvas id="${canvasId}"></canvas></div>${extraHtml || ""}`
        : `<div class="dt-empty" style="padding:36px 12px;"><i class="fa-solid fa-chart-simple"></i><div>${esc(emptyMsg || "No data in this range yet.")}</div></div>`}
    </div>`;

  const tabs = [
    { key: "overview", label: "Overview", count: totalAppointments || 0 },
    { key: "satisfaction", label: "Feedback & CSAT", count: csat ? csat.total : 0 },
    { key: "students", label: "Students", count: totalStudents || 0 },
    { key: "assistant", label: "Assistant", count: asstTotal || 0 },
    { key: "exports", label: "CSV Exports", count: 8 },
  ];
  if (!tabs.some((t) => t.key === SYS_TAB)) SYS_TAB = "overview";

  const unavailable = `<div class="dt-empty ml-empty"><i class="fa-solid fa-triangle-exclamation"></i><div>Could not load analytics. Check your connection, then press Refresh.</div></div>`;

  // ── 1. Overview Tab ──
  let overviewHtml = unavailable;
  if (a) {
    const seg = ops ? [
      ["Served", ops.servedCount, "#15803D"],
      ["Active / Pending", ops.activeCount + ops.pendingCount, "#1D4ED8"],
      ["No-Show", ops.noShowCount, "#D97706"],
      ["Cancelled", ops.cancelledCount, "#B42318"],
    ] : [];
    const outcomeLegend = ops && ops.totalAppointments > 0
      ? `<div class="ad-legend" style="margin-top:14px;">${seg.map(([lbl, n, col]) => `<div><span><i style="background:${col}"></i>${esc(lbl)}</span><b>${n}</b></div>`).join("")}</div>`
      : "";
    overviewHtml = `
      <div class="grid-4 sd-kpi-grid sa-kpi-row">
        ${kpi("fa-calendar-check", "Appointments", totalAppointments.toLocaleString(), ops ? `${ops.completionRate}% completed · ${ops.noShowRate}% no-show` : "Selected range")}
        ${kpi("fa-user-graduate", "Students Tracked", totalStudents.toLocaleString(), `${(a.byCourse || []).length} course${(a.byCourse || []).length === 1 ? "" : "s"} represented`)}
        ${kpi("fa-star", "Avg Satisfaction", csat && csat.total ? `${csat.average.toFixed(2)} / 5` : "—", csat && csat.total ? `${csat.total} student rating${csat.total === 1 ? "" : "s"}` : "No ratings yet")}
        ${kpi("fa-stopwatch", "Avg Turnaround", ops && ops.avgTurnaroundHours != null ? `${ops.avgTurnaroundHours}h` : "—", ops && ops.completedRequestsCount ? `Across ${ops.completedRequestsCount} completed requests` : "No completed requests")}
      </div>

      <div class="layout-ms sa-sect-card">
        ${chartCard("fa-chart-area", "Activity Volume Trend", "Appointments and service requests over time.", "anChartTrend", (a.trend || []).length > 0, "No activity trend data for this range.", "", `<span class="st-chip st-info"><i></i>${esc(rangeBadge)}</span>`)}
        ${chartCard("fa-chart-pie", "Visit Outcomes", "Distribution of completed, active, missed, and cancelled visits.", "anChartOutcomes", Boolean(ops && ops.totalAppointments > 0), "No appointments recorded yet.", outcomeLegend, ops ? `<span class="st-chip st-ok"><i></i>${ops.completionRate}% Served</span>` : "")}
      </div>

      <div class="layout-2c sa-sect-card">
        ${chartCard("fa-concierge-bell", "Appointments by Service", "Most requested Student Services Office lanes.", "anChartServices", (a.services || []).length > 0, "No appointments recorded in range.")}
        ${chartCard("fa-clock", "Peak Appointment Times", "Busiest booking slots across the selected period.", "anChartPeaks", (a.peakTimes || []).length > 0, "No peak-time signal in range.")}
      </div>

      ${csat && csat.recent && csat.recent.length ? `
        <div class="glass-card dl-card sa-sect-card">
          <div class="dl-head">
            <div>
              <div class="dl-title"><i class="fa-solid fa-comment-dots"></i>Latest Student Feedback</div>
              <div class="dl-sub">Recent post-visit, request, and Help Desk ticket ratings.</div>
            </div>
            <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="setSysTab('satisfaction')">View All Feedback<i class="fa-solid fa-arrow-right"></i></button>
          </div>
          <div class="an-fb-grid">${csat.recent.slice(0, 3).map((r) => `
            <article class="an-fb-card">
              <div class="an-fb-top">
                <div class="an-fb-meta-l"><span class="an-fb-svc">${esc(r.serviceLabel)}</span><span class="ml-code">${esc(r.requestId)}</span></div>
                <span class="st-chip ${r.rating >= 4 ? "st-ok" : (r.rating === 3 ? "st-warn" : "st-bad")}"><i></i>${r.rating}/5 ★</span>
              </div>
              <div class="an-fb-stars">${hdStarsHtml(r.rating)}</div>
              ${r.comment ? `<p class="an-fb-comment">“${esc(r.comment)}”</p>` : `<p class="an-fb-nocomment">Rated without additional comment.</p>`}
              <div class="an-fb-foot"><span>${esc(r.studentId)}</span><span>${esc(r.ts)}</span></div>
            </article>`).join("")}</div>
        </div>` : ""}`;
  }

  // ── 2. Feedback & CSAT Tab ──
  let satisfactionHtml = `<div class="dt-empty ml-empty"><i class="fa-solid fa-star"></i><div>No satisfaction data available.</div></div>`;
  if (csat) {
    const posRate = csat.positiveRate != null ? csat.positiveRate : (csat.total ? Math.round((((csat.distribution?.[0]?.count || 0) + (csat.distribution?.[1]?.count || 0)) / csat.total) * 100) : 0);
    const commentN = csat.commentCount != null ? csat.commentCount : (csat.recent || []).filter((r) => r.comment && r.comment.trim()).length;
    const starBtns = [
      { key: "all", label: "All Ratings" },
      { key: "5", label: "5 ★" },
      { key: "4", label: "4 ★" },
      { key: "3", label: "3 ★" },
      { key: "low", label: "1–2 ★" },
    ];
    satisfactionHtml = `
      <div class="grid-4 sd-kpi-grid sa-kpi-row">
        ${kpi("fa-star", "Average CSAT", csat.total ? `${csat.average.toFixed(2)} / 5` : "—", csat.total ? `Across ${csat.total} student rating${csat.total === 1 ? "" : "s"}` : "No ratings in range")}
        ${kpi("fa-thumbs-up", "Positive Rate", csat.total ? `${posRate}%` : "—", "4-star & 5-star responses")}
        ${kpi("fa-comments", "Written Comments", String(commentN), "Responses with student remarks")}
        ${kpi("fa-layer-group", "Services Rated", String((csat.byService || []).length), "Visits, requests & Help Desk")}
      </div>

      <div class="layout-2c sa-sect-card">
        ${chartCard("fa-ranking-star", "Rating Distribution", "Breakdown of 1-star to 5-star student ratings.", "anChartCsatDist", csat.total > 0, "No ratings submitted yet.")}
        ${chartCard("fa-concierge-bell", "Average Score by Service", "Average 1–5 rating per OSS service and Help Desk category.", "anChartCsatSvc", (csat.byService || []).length > 0, "No service ratings yet.")}
      </div>

      <div class="glass-card dl-card sa-sect-card">
        <div class="dl-head">
          <div>
            <div class="dl-title"><i class="fa-solid fa-comment-dots"></i>Student Feedback Directory</div>
            <div class="dl-sub">Filter submitted post-service and Help Desk ratings by star level or keyword.</div>
          </div>
          <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="window.open(analyticsExportUrl('feedback'),'_blank')"><i class="fa-solid fa-file-csv"></i>Export CSAT CSV</button>
        </div>

        <div class="ml-fbar" style="margin-bottom:14px;">
          <div class="dt-tabs" role="tablist" aria-label="Filter feedback by star rating" style="margin:0;">
            ${starBtns.map((b) => `<button type="button" role="tab" data-fb-star="${b.key}" aria-selected="${SYS_FB_STAR === b.key}" onclick="setSysFbStar('${b.key}')" class="dt-tab${SYS_FB_STAR === b.key ? " active" : ""}">${esc(b.label)}</button>`).join("")}
          </div>
          <label class="ml-search" style="width:240px;height:36px;border-radius:10px;">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" value="${esc(SYS_FB_Q)}" placeholder="Search feedback…" aria-label="Search student feedback" oninput="setSysFbQuery(this.value)">
          </label>
          <label class="sa-check" style="margin-top:0;">
            <input type="checkbox" ${SYS_FB_COMMENTS_ONLY ? "checked" : ""} onchange="setSysFbCommentsOnly(this.checked)"> Comments only
          </label>
          <span id="anFeedbackCount" class="ml-count"></span>
        </div>

        <div id="anFeedbackList"></div>
      </div>`;
  }

  // ── 3. Students Tab ──
  const studentsHtml = a ? `
    <div class="layout-2c sa-sect-card">
      ${chartCard("fa-graduation-cap", "Students by Course", "Registered student distribution across programs.", "anChartCourse", (a.byCourse || []).length > 0, "No students grouped by course yet.")}
      ${chartCard("fa-layer-group", "Students by Year Level", "Breakdown of registered students by year level.", "anChartYear", (a.byYear || []).length > 0, "No students grouped by year yet.")}
    </div>` : unavailable;

  // ── 4. Assistant Tab ──
  const matches = (f && f.matches) || [];
  const topUnanswered = (asst && asst.topUnanswered) || [];
  const fbStats = asst && asst.feedback ? asst.feedback : { up: 0, down: 0 };
  const fbTotal = (fbStats.up || 0) + (fbStats.down || 0);
  const helpfulPct = fbTotal ? Math.round(((fbStats.up || 0) / fbTotal) * 100) : null;
  const assistantHtml = asst ? `
    <div class="grid-4 sd-kpi-grid sa-kpi-row">
      ${kpi("fa-robot", "Auto-Answered", `${answerRate}%`, `${asstHigh} of ${asstTotal} total queries`)}
      ${kpi("fa-circle-question", "Clarified First", String(asst.queries.medium || 0), "Medium confidence matches")}
      ${kpi("fa-headset", "Escalated", String(asst.queries.low || 0), `${asst.ticketsFromChat || 0} ticket${asst.ticketsFromChat === 1 ? "" : "s"} opened from chat`)}
      ${kpi("fa-thumbs-up", "Helpful Rating", helpfulPct != null ? `${helpfulPct}%` : "—", fbTotal ? `${fbStats.up} up · ${fbStats.down} down` : "No chat feedback yet")}
    </div>

    <div class="layout-2c sa-sect-card">
      ${chartCard("fa-brain", "Confidence Breakdown", "How the STARS Assistant resolved incoming student questions.", "anChartAsstConf", asstTotal > 0, "No assistant traffic recorded yet.")}
      ${chartCard("fa-thumbs-up", "Assistant Helpfulness Feedback", "Student thumbs-up vs thumbs-down ratings on assistant replies.", "anChartAsstFb", fbTotal > 0, "No assistant feedback recorded yet.")}
    </div>

    <div class="layout-2c sa-sect-card">
      <div class="glass-card dl-card">
        <div class="dl-head"><div><div class="dl-title"><i class="fa-solid fa-circle-question"></i>Top Unanswered Questions</div><div class="dl-sub">Add these to your FAQ knowledge base to improve resolution rate.</div></div></div>
        ${topUnanswered.length ? `<div class="an-simple-list">${topUnanswered.slice(0, 6).map((x) => `<div class="an-simple-row"><span>${esc(x.question || x.q || "Unknown")}</span><b>${esc(x.count)}</b></div>`).join("")}</div>` : `<div class="dt-empty" style="padding:28px 12px;"><i class="fa-solid fa-circle-check"></i><div>No unanswered clusters — the FAQ base covers current demand.</div></div>`}
      </div>
      <div class="glass-card dl-card">
        <div class="dl-head"><div><div class="dl-title"><i class="fa-solid fa-comments"></i>Most Asked FAQ Topics</div><div class="dl-sub">${totalQueries} total matched chatbot queries.</div></div></div>
        ${matches.length ? `<div class="an-simple-list">${matches.slice(0, 6).map((x) => `<div class="an-simple-row"><span>${esc(x.question)}</span><b>${esc(x.count)}</b></div>`).join("")}</div>` : `<div class="dt-empty" style="padding:28px 12px;"><i class="fa-solid fa-comments"></i><div>No chatbot questions recorded yet.</div></div>`}
      </div>
    </div>` : unavailable;

  // ── 5. CSV Exports Tab ──
  const exportTypes = [
    ["appointments", "Appointments", "fa-calendar-check", "Scheduled visits, check-ins, and statuses"],
    ["requests", "Service Requests", "fa-file-circle-check", "Document requests and pickup dates"],
    ["idapps", "ID Applications", "fa-id-card", "New & replacement ID applications"],
    ["events", "Event Requests", "fa-champagne-glasses", "Student organization event filings"],
    ["referrals", "Referrals", "fa-hand-holding-heart", "Guidance and intervention referrals"],
    ["complaints", "Complaints", "fa-shield-heart", "Student complaints log"],
    ["feedback", "CSAT Ratings & Feedback", "fa-star", "Post-service & Help Desk star ratings and comments"],
    ["audit", "Audit Logs", "fa-clipboard-list", "System-wide sensitive action history"],
  ];
  const exportsHtml = `
    <div class="glass-card dl-card">
      <div class="dl-head">
        <div>
          <div class="dl-title"><i class="fa-solid fa-file-csv"></i>CSV Export Center</div>
          <div class="dl-sub">Exports respect the active date range (${esc(rangeBadge)}).</div>
        </div>
      </div>
      <div class="ml-card dt-wrap">
        <table class="dt-table ml-table ml-admin">
          <thead><tr><th>Dataset</th><th>Includes</th><th style="text-align:right;">Download</th></tr></thead>
          <tbody>
            ${exportTypes.map(([t, label, icon, desc]) => `<tr>
              <td><div class="ml-svc"><i class="fa-solid ${icon}" style="color:var(--bk-maroon);margin-right:8px;width:16px;text-align:center;"></i>${esc(label)}</div></td>
              <td><div class="ml-sub2">${esc(desc)}</div></td>
              <td style="text-align:right;"><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="window.open(analyticsExportUrl('${t}'),'_blank')"><i class="fa-solid fa-download"></i>Export CSV</button></td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;

  const body = { overview: overviewHtml, satisfaction: satisfactionHtml, students: studentsHtml, assistant: assistantHtml, exports: exportsHtml }[SYS_TAB];
  const presetVal = ANALYTICS_RANGE.preset || "all";

  box.innerHTML = `
    <div class="ml-fbar an-toolbar">
      ${dtTabs(tabs, SYS_TAB, "setSysTab", true)}
      <div class="an-range-ctrl">
        ${presetVal === "custom" ? `<div class="bk-input sa-date-input"><input id="analyticsFrom" type="date" value="${esc(ANALYTICS_RANGE.from)}" aria-label="From date"></div><span class="sa-date-sep">to</span><div class="bk-input sa-date-input"><input id="analyticsTo" type="date" value="${esc(ANALYTICS_RANGE.to)}" aria-label="To date"></div><button type="button" onclick="applyCustomAnalyticsRange()" class="bk-btn bk-btn-fill bk-btn-sm">Apply</button>` : ""}
        <div class="bk-input ml-dd" style="width:168px;">
          <select id="anRange" aria-label="Date range" onchange="anRangeChange(this.value)">
            ${[["all", "All Time"], ["7d", "Last 7 Days"], ["30d", "Last 30 Days"], ["month", "This Month"], ["year", "This Year"], ["custom", "Custom Range…"]].map(([k, l]) => `<option value="${k}"${k === presetVal ? " selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        ${loadedAt ? `<span class="ml-count" style="margin-left:4px;">Updated ${esc(loadedAt)}</span>` : ""}
      </div>
    </div>
    <div class="an-content">${body}</div>`;

  if (SYS_TAB === "satisfaction") renderSystemFeedbackList();
  requestAnimationFrame(() => mountAnalyticsCharts(a, f));
}
async function sendRemindersPage() {
  if (!confirm("Email students with appointments within the next 24 hours?")) return;
  const result = await api("/api/reminders", { method: "POST" });
  showToast(result.ok ? `Sent ${result.data.appointmentEmails} appointment reminders.` : (result.error || "Could not send reminders."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

// Email notification controls are hidden (not removed). Flip to true to restore them.
const FEATURE_EMAIL_NOTIFICATIONS_UI = false;
async function renderSettingsPage() {
  if (!isSuperAdmin()) { showToast("⚠️ System Settings is restricted to Super Admin.", "rgba(139,26,26,.9)"); const box0 = document.getElementById("settingsBody"); if (box0) box0.innerHTML = `<div class="empty-state" style="padding:24px;">Restricted to Super Admin.</div>`; return; }
  const box = document.getElementById("settingsBody");
  if (!box) return;
  box.innerHTML = `<div class="glass-card" style="padding:22px;text-align:center;font-size:12px;color:rgba(30,5,5,.55);"><span class="spinner" style="border-color:rgba(139,26,26,.2);border-top-color:#8B1A1A;"></span> Loading settings…</div>`;
  const result = await api("/api/settings");
  if (!result.ok) { box.innerHTML = `<div class="empty-state" style="padding:24px;"><i class="fa-solid fa-triangle-exclamation"></i>Could not load settings.<br><button class="btn-ghost" onclick="renderSettingsPage()" style="margin-top:12px;padding:8px 16px;font-size:12px;"><i class="fa-solid fa-rotate-right" style="margin-right:6px;"></i>Retry</button></div>`; return; }
  const s = result.data;
  window.__qrsSettings = s;
  window.__qrsSettingsDirty = false;
  const svcLabel = (k) => (APPT_SERVICES.find((x) => x.key === k)?.label || k);
  const svcIcon = (k) => {
    const key = String(k || "").toUpperCase();
    if (key.includes("AUTH")) return "fa-stamp";
    if (key.includes("EXCUSE")) return "fa-file-circle-check";
    if (key.includes("ID")) return "fa-id-card";
    if (key.includes("EVENT")) return "fa-calendar-star";
    if (key.includes("PSYCH") || key.includes("COUNSEL") || key.includes("GUID")) return "fa-heart-circle-check";
    if (key.includes("REFERRAL")) return "fa-hand-holding-heart";
    return "fa-concierge-bell";
  };
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const svcEntries = s.serviceConfigs ? Object.entries(s.serviceConfigs) : [];
  const svcCards = svcEntries.map(([k, c]) => {
    const days = (c.weekdays || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    const dayBtns = dayNames.map((d, i) => `<button type="button" class="sys-day${days.includes(i) ? " on" : ""}" data-day="${i}" onclick="toggleSvcDay('${esc(k)}',${i},this)" aria-pressed="${days.includes(i) ? "true" : "false"}" title="${d}">${d[0]}</button>`).join("");
    return `
    <div class="sys-svc-card">
      <div class="sys-svc-head"><span class="sys-svc-icon"><i class="fa-solid ${svcIcon(k)}"></i></span>
        <div style="min-width:0;"><div class="sys-svc-name">${esc(svcLabel(k))}</div><div class="sys-svc-code">${esc(k)}</div></div>
      </div>
      <div class="sys-svc-summary" id="svcSummary-${esc(k)}"></div>
      <div class="sys-field-row">
        <div><span class="input-label">Seats / slot</span><input id="svcCap-${esc(k)}" class="glass-input" type="number" inputmode="numeric" onkeydown="return intOnlyKey(event)" min="1" max="50" value="${c.capacity}" oninput="sysMarkDirty();sysSyncSvcSummary('${esc(k)}')"></div>
        <div><span class="input-label">Minutes / visit</span><input id="svcDur-${esc(k)}" class="glass-input" type="number" inputmode="numeric" onkeydown="return intOnlyKey(event)" min="5" max="240" value="${c.durationMin}" oninput="sysMarkDirty();sysSyncSvcSummary('${esc(k)}')"></div>
      </div>
      <div style="margin-top:10px;"><span class="input-label">Offered days</span>
        <div class="sys-days" id="svcDayBtns-${esc(k)}">${dayBtns}</div>
        <input id="svcDays-${esc(k)}" type="hidden" value="${esc(days.join(","))}">
        <div class="sys-hint">Tap days to toggle. At least one day keeps the lane bookable.</div>
      </div>
    </div>`;
  }).join("");
  const field = (label, id, value, hint, extra) => `<div class="sys-field"><span class="input-label">${label}</span><input id="${id}" class="glass-input" value="${esc(value)}" oninput="sysMarkDirty()${extra ? ";" + extra : ""}">${hint ? `<div class="sys-hint">${hint}</div>` : ""}</div>`;
  const numField = (label, id, value, hint, min, max, step) => `<div class="sys-field"><span class="input-label">${label}</span><input id="${id}" class="glass-input" type="number" inputmode="numeric" ${step === 1 ? 'onkeydown="return intOnlyKey(event)"' : ""} value="${esc(value)}" ${min != null ? `min="${min}"` : ""} ${max != null ? `max="${max}"` : ""} ${step != null ? `step="${step}"` : ""} oninput="sysMarkDirty()${id.startsWith("setAssistant") ? ";sysSyncAsst()" : ""}">${hint ? `<div class="sys-hint">${hint}</div>` : ""}</div>`;
  const hours = (s.businessHours || []).join(", ");
  const holidays = (s.holidays || []).join(", ");
  const courses = (s.courses || DEFAULT_REGISTRATION_COURSES).join(", ");
  const svcCount = svcEntries.length;
  const slotCount = (s.businessHours || []).length;
  box.innerHTML = `
  <div class="sys-layout">
  <nav class="sys-side" role="tablist" aria-label="Settings categories">
    <button type="button" role="tab" data-sec="setSecSchedule" onclick="sysShowSection('setSecSchedule')" title="Business hours, capacity, cutoffs and closed dates"><i class="fa-solid fa-calendar-day"></i><span>Schedule &amp; Capacity</span></button>
    <button type="button" role="tab" data-sec="setSecServices" onclick="sysShowSection('setSecServices')" title="Per-service slots and durations"><i class="fa-solid fa-concierge-bell"></i><span>Services (${svcCount})</span></button>
    <button type="button" role="tab" data-sec="setSecAssistant" onclick="sysShowSection('setSecAssistant')" title="AI assistant thresholds and behaviour"><i class="fa-solid fa-robot"></i><span>AI Assistant</span></button>
    <button type="button" role="tab" data-sec="setSecEmail" onclick="sysShowSection('setSecEmail')" title="Registration courses"><i class="fa-solid fa-user-plus"></i><span>Registration &amp; Courses</span></button>
    <button type="button" role="tab" data-sec="setSecSplash" onclick="sysShowSection('setSecSplash')" title="Login splash image and caption"><i class="fa-solid fa-image"></i><span>Login Splash</span></button>
    <button type="button" role="tab" data-sec="setSecBackups" onclick="sysShowSection('setSecBackups')" title="Export backups, restore, and archive retention"><i class="fa-solid fa-database"></i><span>Backups &amp; Archives</span></button>
    <div class="sys-status" aria-label="System status">
      <div class="sys-status-t">System status</div>
      <div class="sys-status-r"><span><i class="fa-solid fa-envelope"></i>Email</span>${EMAIL_CONFIGURED ? '<span class="st-chip st-ok"><i></i>Live</span>' : '<span class="st-chip st-warn" title="Set SMTP_* in .env to send real emails"><i></i>Not set up</span>'}</div>
      <div class="sys-status-r"><span><i class="fa-solid fa-calendar-day"></i>Booking slots</span><b>${slotCount}</b></div>
      <div class="sys-status-r"><span><i class="fa-solid fa-concierge-bell"></i>Service lanes</span><b>${svcCount}</b></div>
    </div>
  </nav>
  <div class="sys-pane">
  <div id="setSecSchedule" class="glass-card dl-card sys-anchor">
    <div class="dl-head">
      <div><div class="dl-title"><i class="fa-solid fa-calendar-day"></i>Schedule &amp; Capacity</div><div class="dl-sub">Business hours drive the booking calendar; the per-slot fallback applies where a service has no override.</div></div>
      <span class="st-chip st-info" id="hoursCountPill">${slotCount} slots</span>
    </div>
    <div style="display:grid;gap:12px;">
      <div class="sys-field"><span class="input-label">Business hours (comma-separated)</span>
        <input id="setHours" class="glass-input" value="${esc(hours)}" placeholder="8:00 AM, 8:30 AM, 9:00 AM …" oninput="sysMarkDirty();sysPreviewList('setHours','hoursPreview',',','hoursCountPill','slot')">
        <div class="sys-hint">e.g. 8:00 AM, 8:30 AM, 9:00 AM … (max 20 slots)</div>
        <div id="hoursPreview" class="sys-chips"></div>
      </div>
      <div class="sys-grid-3">
        ${numField("Capacity per slot (fallback)", "setCapacity", s.appointmentCapacity, "Used when a lane has no override.", 1, 50, 1)}
        ${numField("Cutoff — hours before visit", "setCutoff", s.cancellationCutoffHours, "Blocks cancel / reschedule inside this window.", 0, 168, 1)}
        ${numField("Max reschedules (0–10)", "setMaxReschedules", s.maxReschedules ?? 2, "Per appointment. 0 disables rescheduling.", 0, 10, 1)}
      </div>
      <div class="sys-field"><span class="input-label">Closed dates / holidays (comma-separated)</span>
        <input id="setHolidays" class="glass-input" value="${esc(holidays)}" placeholder="December 25, 2026, January 1, 2027" oninput="sysMarkDirty();sysPreviewList('setHolidays','holidaysPreview',',',null,'closed date')">
        <div class="sys-hint">e.g. December 25, 2026 — these dates are removed from the booking calendar.</div>
        <div id="holidaysPreview" class="sys-chips"></div>
      </div>
    </div>
  </div>
  <div id="setSecServices" class="glass-card dl-card sys-anchor">
    <div class="dl-head">
      <div><div class="dl-title"><i class="fa-solid fa-sliders"></i>Per-Service Slots</div><div class="dl-sub">Seats, visit length, and offered weekdays per service lane. Changes apply to future bookings.</div></div>
      <span class="st-chip st-info">${svcCount} lanes</span>
    </div>
    ${svcCards ? `<div class="sys-svc-grid">${svcCards}</div>` : `<div class="dt-empty" style="padding:24px;"><i class="fa-solid fa-inbox"></i><div>No service lanes configured.</div></div>`}
  </div>
  <div id="setSecAssistant" class="glass-card dl-card sys-anchor">
    <div class="dl-head">
      <div><div class="dl-title"><i class="fa-solid fa-robot"></i>AI Assistant</div><div class="dl-sub">Confidence thresholds for chatbot answers. Lower values answer more (risking misses); higher values escalate to tickets more often.</div></div>
    </div>
    <div class="sys-grid-3">
      <div class="sys-field"><span class="input-label">Keyword high score (1–100)</span>
        <div class="sys-slider-row"><input id="setAssistantHighScoreRange" type="range" min="1" max="100" step="1" value="${esc(s.assistantHighScore ?? 6)}" oninput="sysSyncSliderPair('setAssistantHighScoreRange','setAssistantHighScore')"><input id="setAssistantHighScore" class="glass-input sys-num" type="number" min="1" max="100" step="1" value="${esc(s.assistantHighScore ?? 6)}" oninput="sysSyncSliderPair('setAssistantHighScore','setAssistantHighScoreRange')"></div>
        <div class="sys-hint">Auto-answer when keyword score reaches this.</div>
      </div>
      <div class="sys-field"><span class="input-label">Semantic high (0–1)</span>
        <div class="sys-slider-row"><input id="setAssistantHighSimilarityRange" type="range" min="0" max="1" step="0.05" value="${esc(s.assistantHighSimilarity ?? 0.6)}" oninput="sysSyncSliderPair('setAssistantHighSimilarityRange','setAssistantHighSimilarity')"><input id="setAssistantHighSimilarity" class="glass-input sys-num" type="number" min="0" max="1" step="0.05" value="${esc(s.assistantHighSimilarity ?? 0.6)}" oninput="sysSyncSliderPair('setAssistantHighSimilarity','setAssistantHighSimilarityRange')"></div>
        <div class="sys-hint">Auto-answer when meaning match reaches this.</div>
      </div>
      <div class="sys-field"><span class="input-label">Semantic medium (0–1)</span>
        <div class="sys-slider-row"><input id="setAssistantMediumSimilarityRange" type="range" min="0" max="1" step="0.05" value="${esc(s.assistantMediumSimilarity ?? 0.45)}" oninput="sysSyncSliderPair('setAssistantMediumSimilarityRange','setAssistantMediumSimilarity')"><input id="setAssistantMediumSimilarity" class="glass-input sys-num" type="number" min="0" max="1" step="0.05" value="${esc(s.assistantMediumSimilarity ?? 0.45)}" oninput="sysSyncSliderPair('setAssistantMediumSimilarity','setAssistantMediumSimilarityRange')"></div>
        <div class="sys-hint">Ask a clarification above this; escalate below.</div>
      </div>
    </div>
    <div id="asstVerdict" class="info-box" style="margin-top:12px;"></div>
  </div>
  <div id="setSecEmail" class="glass-card dl-card sys-anchor">
    <div class="dl-head">
      <div><div class="dl-title"><i class="fa-solid fa-user-plus"></i>Registration &amp; Courses</div><div class="dl-sub">Which courses students can pick when they register.</div></div>
    </div>
    <div style="display:grid;gap:12px;">
      <div class="sys-field"><span class="input-label">Available registration courses (comma-separated)</span>
        <input id="setCourses" class="glass-input" value="${esc(courses)}" oninput="sysMarkDirty();sysPreviewList('setCourses','coursesPreview',',',null,'course')">
        <div id="coursesPreview" class="sys-chips"></div>
      </div>
      <div class="sys-field"${FEATURE_EMAIL_NOTIFICATIONS_UI ? "" : ' style="display:none"'}><span class="input-label">Email template</span>
        <div class="sys-ph-row">
          <button type="button" class="sys-ph" onclick="sysInsertPlaceholder('{{name}}')">{{name}}</button>
          <button type="button" class="sys-ph" onclick="sysInsertPlaceholder('{{title}}')">{{title}}</button>
          <button type="button" class="sys-ph" onclick="sysInsertPlaceholder('{{message}}')">{{message}}</button>
          <span class="sys-hint" style="margin:0;">Click to insert at cursor.</span>
        </div>
        <textarea id="setEmailTemplate" class="glass-input" rows="3" oninput="sysMarkDirty();sysUpdateEmailPreview()">${esc(s.emailTemplate || "{{message}}\n\n— STARS")}</textarea>
        <div class="sys-hint">Available placeholders: {{name}}, {{title}}, {{message}}</div>
        <div class="sys-preview-label">Live preview <span>— sample student &amp; reminder</span></div>
        <div id="emailPreview" class="sys-email-preview"></div>
      </div>
    </div>
  </div>
  <div id="setSecBackups" class="glass-card dl-card sys-anchor">
    <div class="dl-head">
      <div><div class="dl-title"><i class="fa-solid fa-database"></i>Backups &amp; Archives</div><div class="dl-sub">Export a backup on demand, restore it, and control when finished records are archived.</div></div>
    </div>
    <div style="display:grid;gap:14px;">
      <div class="sys-card-sub">
        <div class="input-label"><i class="fa-solid fa-download" style="margin-right:6px;"></i>Export backup</div>
        <div class="sys-hint" style="margin:0 0 10px;">Downloads a full JSON snapshot to your device. Nothing is stored on the server. Keep the file private; it contains student data.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="downloadBackup()" title="Download a full database backup"><i class="fa-solid fa-download"></i>Export backup</button>
          <button type="button" class="bk-btn bk-btn-danger bk-btn-sm" onclick="restoreBackup()" title="Replace all records from a backup file (irreversible)"><i class="fa-solid fa-clock-rotate-left"></i>Restore from backup</button>
        </div>
      </div>
      <div class="sys-card-sub">
        <div class="input-label"><i class="fa-solid fa-box-archive" style="margin-right:6px;"></i>Archive finished records</div>
        <div class="sys-hint" style="margin:0 0 10px;">Completed, closed, cancelled or rejected complaints and transactions older than the number of days below move to the Archive automatically every day. Open items are never archived.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
          <div class="sys-field" style="width:170px;"><span class="input-label">Archive after (days)</span>
            <input id="archDays" class="glass-input" type="text" inputmode="numeric" maxlength="3" title="Whole number from 7 to 365" onkeydown="return intOnlyKey(event)" oninput="intOnlyClean(this,7,365)" value="30"></div>
          <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="archiveSaveDays()" title="Save the retention period"><i class="fa-solid fa-floppy-disk"></i>Save</button>
          <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="archiveRunNow()" title="Archive everything that is due now"><i class="fa-solid fa-box-archive"></i>Run archive now</button>
        </div>
        <div id="archStatus" class="sys-hint" style="margin-top:10px;">Loading…</div>
      </div>
      <div class="sys-card-sub">
        <div class="input-label"><i class="fa-solid fa-folder-tree" style="margin-right:6px;"></i>Archived records</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 10px;">
          <select id="archType" class="glass-input" aria-label="Record type" onchange="archiveBrowse()" style="width:180px;"><option value="">All types</option><option value="complaints">Complaints</option><option value="requests">Requests</option><option value="idApplications">ID applications</option><option value="eventRequests">Event requests</option><option value="referrals">Referrals</option><option value="appointments">Appointments</option><option value="tickets">Tickets</option></select>
          <input id="archQ" class="glass-input" placeholder="Search code, student, status\u2026" maxlength="80" style="flex:1;min-width:200px;" onkeydown="if(event.key==='Enter')archiveBrowse()">
          <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="archiveBrowse()" title="Search archived records"><i class="fa-solid fa-magnifying-glass"></i>Search</button>
        </div>
        <div id="archList"></div>
      </div>
    </div>
  </div>
  <div id="setSecSplash" class="glass-card dl-card sys-anchor">
    <div class="dl-head">
      <div><div class="dl-title"><i class="fa-solid fa-image"></i>Login Splash Screen</div><div class="dl-sub">PUP San Pedro Branch image displayed on the Login and Register pages.</div></div>
    </div>
    <div style="display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:16px;align-items:start;">
      <div style="border-radius:14px;overflow:hidden;border:1px solid var(--bk-line);background:#2a0808;aspect-ratio:4/3;position:relative;">
        <img id="setSplashPreview" src="${esc(s.loginSplashUrl || "/pup-san-pedro-campus.svg")}" alt="Login Splash Preview" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.src='/pup-san-pedro-campus.svg'">
      </div>
      <div style="display:grid;gap:10px;">
        <div class="sys-field">
          <span class="input-label">Splash Image URL</span>
          <input id="setLoginSplashUrl" class="glass-input" value="${esc(s.loginSplashUrl || "/pup-san-pedro-campus.svg")}" oninput="sysMarkDirty();sysUpdateSplashPreview()">
        </div>
        <div class="sys-field">
          <span class="input-label">Campus Caption Badge</span>
          <input id="setLoginSplashCaption" class="glass-input" value="${esc(s.loginSplashCaption || "PUP San Pedro Campus — Student Services Office")}" oninput="sysMarkDirty()">
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input id="setSplashFile" type="file" accept="image/png,image/jpeg,image/webp" style="display:none;" onchange="uploadLoginSplash(this)">
          <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="document.getElementById('setSplashFile')?.click()"><i class="fa-solid fa-upload"></i>Upload Photo</button>
          <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="resetLoginSplash()"><i class="fa-solid fa-rotate-left"></i>Reset to Default</button>
        </div>
        <div class="sys-hint">Recommended: landscape or portrait photo (JPG/PNG/WebP, max 5 MB). Click Save All to publish.</div>
      </div>
    </div>
  </div>
  </div>
  </div>
  <div class="sys-savebar">
    <span id="settingsDirtyDotBottom" class="sys-clean"><i class="fa-solid fa-circle-check"></i>No unsaved changes</span>
    <span id="settingsSaveMsg" class="sys-save-msg"></span>
    <span style="flex:1;"></span>
    <button type="button" class="bk-btn bk-btn-out bk-btn-sm sys-save-btn" onclick="renderSettingsPage()">Discard</button>
    <button type="button" class="bk-btn bk-btn-fill bk-btn-sm sys-save-btn" onclick="saveSettingsPage()"><i class="fa-solid fa-floppy-disk"></i>Save Settings</button>
  </div>`;
  sysPreviewList("setHours", "hoursPreview", ",", "hoursCountPill", "slot");
  sysPreviewList("setHolidays", "holidaysPreview", ",", null, "closed date");
  sysPreviewList("setCourses", "coursesPreview", ",", null, "course");
  svcEntries.forEach(([k]) => sysSyncSvcSummary(k));
  sysSyncAsst();
  sysUpdateEmailPreview();
  sysShowSection(sessionStorage.getItem("qrsSettingsSec") || "setSecSchedule");
  archiveRefresh();
  archiveBrowse();
}
// ── System Settings: one category visible at a time (left sidebar) ──
function sysShowSection(id) {
  const ids = ["setSecSchedule", "setSecServices", "setSecAssistant", "setSecEmail", "setSecSplash", "setSecBackups"];
  if (!ids.includes(id)) id = ids[0];
  ids.forEach((x) => { const el = document.getElementById(x); if (el) el.classList.toggle("sys-hidden", x !== id); });
  document.querySelectorAll(".sys-side button").forEach((b) => {
    const on = b.dataset.sec === id;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  try { sessionStorage.setItem("qrsSettingsSec", id); } catch (e) {}
  const pane = document.querySelector(".sys-pane"); if (pane) pane.scrollTop = 0;
}
async function archiveRefresh() {
  const el = document.getElementById("archStatus"); if (!el) return;
  const r = await api("/api/admin/archive");
  if (!r.ok) { el.textContent = "Could not load archive status."; return; }
  const d = r.data, n = Object.values(d.archived).reduce((a, b) => a + b, 0);
  const inp = document.getElementById("archDays"); if (inp) inp.value = d.days;
  el.innerHTML = `<b>${esc(d.dueTotal)}</b> record(s) are due for archiving now. <b>${esc(n)}</b> already archived. Retention: ${esc(d.days)} days.`;
}
async function archiveBrowse() {
  const box = document.getElementById("archList"); if (!box) return;
  const qs = new URLSearchParams({ type: document.getElementById("archType")?.value || "", q: document.getElementById("archQ")?.value || "" });
  const r = await api("/api/admin/archive/records?" + qs.toString());
  if (!r.ok) { box.innerHTML = `<div class="dt-empty">Could not load archived records.</div>`; return; }
  const rows = r.data.map((x) => `<tr><td style="font-family:monospace;font-size:11px;">${esc(x.id)}</td><td style="font-size:12px;">${esc(x.label)}</td><td style="font-size:11px;">${esc(x.who)}</td><td>${pill(x.status)}</td><td style="font-size:11px;white-space:nowrap;">${esc(String(x.archivedAt).slice(0, 10))}</td><td style="text-align:right;"><button class="btn-ghost" onclick="archiveRestore('${esc(x.type)}','${esc(x.id)}')" title="Move back to the active lists" style="padding:5px 10px;font-size:11px;"><i class="fa-solid fa-box-open" style="margin-right:5px;"></i>Unarchive</button></td></tr>`);
  box.innerHTML = dtTable({ headers: ["Code", "Record", "Student", "Status", "Archived", "Action"], rows, empty: "No archived records.", emptyIcon: "fa-box-archive" });
}
async function archiveRestore(type, id) {
  if (!confirm(`Move ${id} back to the active lists?`)) return;
  const r = await api("/api/admin/archive/records", { method: "POST", body: { type, id } });
  if (!r.ok) { showToast(`\u26a0\ufe0f ${r.error || "Could not unarchive."}`, "rgba(139,26,26,.9)"); return; }
  showToast("\u2705 Record restored."); archiveBrowse(); archiveRefresh();
}

async function archiveSaveDays() {
  const days = readIntInput("archDays", 7, 365, "Archive after (days)"); if (days === null) return;
  const r = await api("/api/admin/archive", { method: "PUT", body: { days } });
  if (!r.ok) { showToast(`\u26a0\ufe0f ${r.error || "Could not save."}`, "rgba(139,26,26,.9)"); return; }
  showToast("\u2705 Archive retention saved.", "rgba(21,128,61,.9)"); archiveRefresh();
}
async function archiveRunNow() {
  if (!confirm("Archive all finished records that are past the retention period?")) return;
  const r = await api("/api/admin/archive", { method: "POST" });
  if (!r.ok) { showToast(`\u26a0\ufe0f ${r.error || "Archive failed."}`, "rgba(139,26,26,.9)"); return; }
  showToast(`\u2705 Archived ${r.data.total} record(s).`, "rgba(21,128,61,.9)"); archiveRefresh();
}

function sysBar(on) { document.querySelector("#page-settings .sys-savebar")?.classList.toggle("on", !!on); }
function sysMarkDirty() {
  window.__qrsSettingsDirty = true; sysBar(true);
  ["settingsDirtyDot", "settingsDirtyDotBottom"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.className = "sys-dirty"; el.innerHTML = `<i class="fa-solid fa-circle" style="margin-right:5px;font-size:8px;"></i>Unsaved changes`; }
  });
}
function sysMarkClean() {
  window.__qrsSettingsDirty = false; sysBar(false);
  ["settingsDirtyDot", "settingsDirtyDotBottom"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.className = "sys-clean"; el.innerHTML = `<i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>No unsaved changes`; }
  });
}
function sysPreviewList(inputId, previewId, sep, pillId, noun) {
  const inp = document.getElementById(inputId);
  const prev = document.getElementById(previewId);
  const items = String(inp?.value || "").split(sep || ",").map((x) => x.trim()).filter(Boolean);
  if (prev) prev.innerHTML = items.length
    ? items.slice(0, 24).map((x) => `<span class="sys-chip">${esc(x)}</span>`).join("") + (items.length > 24 ? `<span class="sys-chip sys-chip-more">+${items.length - 24} more</span>` : "")
    : `<span class="sys-hint">Nothing set${noun ? " — no " + noun + "s" : ""}.</span>`;
  if (pillId) {
    const pill = document.getElementById(pillId);
    if (pill) pill.textContent = `${items.length} ${(noun || "item")}${items.length === 1 ? "" : "s"}`;
  }
}
function toggleSvcDay(key, day, btn) {
  const inp = document.getElementById(`svcDays-${key}`);
  if (!inp) return;
  let days = String(inp.value || "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  if (days.includes(day)) days = days.filter((d) => d !== day);
  else days.push(day);
  days.sort((x, y) => x - y);
  inp.value = days.join(",");
  btn?.classList.toggle("on", days.includes(day));
  btn?.setAttribute("aria-pressed", days.includes(day) ? "true" : "false");
  sysMarkDirty();
  sysSyncSvcSummary(key);
}
function sysSyncSvcSummary(key) {
  const el = document.getElementById(`svcSummary-${key}`);
  if (!el) return;
  const cap = document.getElementById(`svcCap-${key}`)?.value;
  const dur = document.getElementById(`svcDur-${key}`)?.value;
  const days = String(document.getElementById(`svcDays-${key}`)?.value || "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayTxt = days.length === 7 ? "Every day" : days.length ? days.map((d) => dayNames[Number(d)]).join(" · ") : "No days — lane paused";
  el.innerHTML = `<b>${esc(cap || "?")} seats</b> × <b>${esc(dur || "?")} min</b> <span>— ${esc(dayTxt)}</span>`;
}
function sysSyncSliderPair(fromId, toId) {
  const from = document.getElementById(fromId);
  const to = document.getElementById(toId);
  if (from && to && to.value !== from.value) to.value = from.value;
  sysMarkDirty();
  sysSyncAsst();
}
function sysSyncAsst() {
  const v = document.getElementById("asstVerdict");
  if (!v) return;
  const hs = Number(document.getElementById("setAssistantHighScore")?.value);
  const hi = Number(document.getElementById("setAssistantHighSimilarity")?.value);
  const mid = Number(document.getElementById("setAssistantMediumSimilarity")?.value);
  let tone = "Balanced — answers clear matches, clarifies near-misses.";
  if (!isNaN(hs) && hs <= 3) tone = "Lenient — answers aggressively; expect occasional misses. Good for coverage.";
  if (!isNaN(hs) && hs >= 20) tone = "Strict — escalates often; safest answers, more tickets.";
  if (!isNaN(hi) && !isNaN(mid) && mid >= hi) tone = "⚠️ Medium threshold is at/above High — the clarify band does nothing. Lower medium below high.";
  v.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles" style="margin-right:6px;"></i><b>Current posture:</b> ${esc(tone)} <span style="opacity:.75;">(keyword ≥ ${esc(isNaN(hs) ? "?" : hs)} · high ≥ ${esc(isNaN(hi) ? "?" : hi)} · medium ≥ ${esc(isNaN(mid) ? "?" : mid)})</span>`;
}
function sysInsertPlaceholder(ph) {
  const ta = document.getElementById("setEmailTemplate");
  if (!ta) return;
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + ph + ta.value.slice(e);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = s + ph.length;
  sysMarkDirty();
  sysUpdateEmailPreview();
}
function sysUpdateEmailPreview() {
  const ta = document.getElementById("setEmailTemplate");
  const prev = document.getElementById("emailPreview");
  if (!prev) return;
  const tpl = String(ta?.value ?? "");
  const sample = { name: "Juan dela Cruz", title: "Appointment Reminder — APT-007", message: "Hi Juan! This is a friendly reminder of your visit tomorrow at 9:30 AM. Please bring your registration form." };
  const rendered = tpl.split("{{name}}").join(sample.name).split("{{title}}").join(sample.title).split("{{message}}").join(sample.message) || "(Empty template — emails would go out blank.)";
  const escHtml = String(rendered).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  prev.innerHTML = `<div class="sys-email-subject">${esc(sample.title)}</div><div class="sys-email-to">To: juan@iskolar.pup.edu.ph</div><div class="sys-email-body">${escHtml}</div>`;
}
function sysUpdateSplashPreview() {
  const url = document.getElementById("setLoginSplashUrl")?.value.trim() || "/pup-san-pedro-campus.svg";
  const img = document.getElementById("setSplashPreview");
  if (img) img.src = url;
}
function resetLoginSplash() {
  const urlEl = document.getElementById("setLoginSplashUrl");
  const capEl = document.getElementById("setLoginSplashCaption");
  if (urlEl) urlEl.value = "/pup-san-pedro-campus.svg";
  if (capEl) capEl.value = "PUP San Pedro Campus — Student Services Office";
  sysUpdateSplashPreview();
  sysMarkDirty();
}
async function uploadLoginSplash(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast("Image must be 5 MB or smaller.", "rgba(155,22,22,.85)"); return; }
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) { showToast(data.error || "Failed to upload splash image.", "rgba(155,22,22,.85)"); return; }
  const urlEl = document.getElementById("setLoginSplashUrl");
  if (urlEl) urlEl.value = data.url;
  sysUpdateSplashPreview();
  sysMarkDirty();
  showToast("✅ Splash photo uploaded. Click Save settings to apply.");
}
async function saveSettingsPage() {
  const msg = document.getElementById("settingsSaveMsg");
  const btns = Array.from(document.querySelectorAll(".sys-save-btn"));
  btns.forEach((b) => { b.disabled = true; b.dataset.label = b.innerHTML; b.innerHTML = `<span class="spinner"></span>Saving…`; });
  if (msg) { msg.textContent = "Saving…"; msg.className = "sys-save-msg"; }
  try {
    const prev = window.__qrsSettings || {};
    const num = (id, fallback, min, max) => {
      const raw = document.getElementById(id)?.value;
      let n = raw === "" || raw == null ? NaN : Number(raw);
      if (!Number.isFinite(n)) n = Number(fallback);
      if (!Number.isFinite(n)) n = min;
      n = Math.min(max, Math.max(min, n));
      return n;
    };
    const hours = document.getElementById("setHours")?.value.split(",").map((x) => x.trim()).filter(Boolean) || [];
    if (hours.length > 20) { showToast("Business hours are capped at 20 slots — extra entries were ignored.", "rgba(180,130,0,.9)"); }
    const serviceConfigs = Object.keys(prev.serviceConfigs || {}).map((k) => ({
      service: k,
      capacity: num(`svcCap-${k}`, prev.serviceConfigs[k]?.capacity ?? 5, 1, 50),
      durationMin: num(`svcDur-${k}`, prev.serviceConfigs[k]?.durationMin ?? 30, 5, 240),
      weekdays: String(document.getElementById(`svcDays-${k}`)?.value || "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    }));
    const hi = num("setAssistantHighSimilarity", prev.assistantHighSimilarity ?? 0.6, 0, 1);
    let mid = num("setAssistantMediumSimilarity", prev.assistantMediumSimilarity ?? 0.45, 0, 1);
    if (mid >= hi) { showToast("Medium similarity was at/above High — it was clamped just below High.", "rgba(180,130,0,.9)"); mid = Math.max(0, hi - 0.05); }
    const body = {
      businessHours: hours.slice(0, 20),
      appointmentCapacity: num("setCapacity", prev.appointmentCapacity ?? 5, 1, 50),
      cancellationCutoffHours: num("setCutoff", prev.cancellationCutoffHours ?? 24, 0, 168),
      maxReschedules: Math.round(num("setMaxReschedules", prev.maxReschedules ?? 2, 0, 10)),
      holidays: (document.getElementById("setHolidays")?.value || "").split(",").map((x) => x.trim()).filter(Boolean),
      courses: (document.getElementById("setCourses")?.value || "").split(",").map((x) => x.trim()).filter(Boolean),
      emailTemplate: document.getElementById("setEmailTemplate")?.value || "",
      serviceConfigs,
      assistantHighScore: Math.round(num("setAssistantHighScore", prev.assistantHighScore ?? 6, 1, 100)),
      assistantHighSimilarity: hi,
      assistantMediumSimilarity: mid,
      loginSplashUrl: (document.getElementById("setLoginSplashUrl")?.value || "").trim() || "/pup-san-pedro-campus.svg",
      loginSplashCaption: (document.getElementById("setLoginSplashCaption")?.value || "").trim() || "PUP San Pedro Campus — Student Services Office",
    };
    const result = await api("/api/settings", { method: "PUT", body });
    if (msg) { msg.textContent = result.ok ? "Saved ✓" : (result.error || "Could not save settings."); msg.className = "sys-save-msg" + (result.ok ? " ok" : " err"); }
    showToast(result.ok ? "System settings saved." : (result.error || "Could not save settings."), result.ok ? undefined : "rgba(155,22,22,.85)");
    if (result.ok) { sysMarkClean(); void loadPublicSplash(); renderSettingsPage(); return; }
  } finally {
    btns.forEach((b) => { b.disabled = false; if (b.dataset.label) b.innerHTML = b.dataset.label; });
  }
}

function openStaffEditor(id) {
  const u = id ? (window.__qrsStaff || []).find((x) => x.id === id) : null;
  openAppModal({ title: u ? "Edit Staff Account" : "Create Staff Account", subtitle: u ? "Update access role or deactivate this account." : "Create an Admin or Scanner account with a temporary password.", icon: "fa-user-gear", content: `<div class="app-modal-grid">${modalField("Full name", "staffName", u?.name || "")}${modalField("Email", "staffEmail", u?.email || "")}<div class="app-field"><label for="staffRole">Role</label><select id="staffRole" class="glass-input"><option value="ADMIN" ${u?.role === "ADMIN" ? "selected" : ""}>Admin</option><option value="SCANNER" ${u?.role === "SCANNER" ? "selected" : ""}>Scanner</option></select></div>${u ? `<div class="app-field"><label for="staffActive">Account status</label><select id="staffActive" class="glass-input"><option value="true" ${u.active ? "selected" : ""}>Active</option><option value="false" ${!u.active ? "selected" : ""}>Deactivated</option></select></div>` : `<div class="app-field"><label for="staffPassword">Temporary password</label><input id="staffPassword" class="glass-input" type="password" placeholder="At least 10 characters"></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Back</button><button class="btn-maroon" onclick="saveStaffAccount('${u?.id || ""}')">${u ? "Save changes" : "Create account"}</button></div>` });
}
async function saveStaffAccount(id) {
  const name = document.getElementById("staffName")?.value.trim(), email = document.getElementById("staffEmail")?.value.trim(), role = document.getElementById("staffRole")?.value;
  const result = id ? await api(`/api/users/staff/${encodeURIComponent(id)}`, { method: "PATCH", body: { name, role, active: document.getElementById("staffActive")?.value === "true" } }) : await api("/api/users/staff", { method: "POST", body: { name, email, role, password: document.getElementById("staffPassword")?.value } });
  if (result.ok) { closeAppModal(); showToast("Staff account saved."); return reloadAccountsPage(); }
  showToast(result.error || "Could not save staff account.", "rgba(155,22,22,.85)");
}

function scopeArgOf(scope) { return scope ? `{schoolYear:'${esc(scope.schoolYear)}',course:'${esc(scope.course)}',year:'${esc(scope.year)}'}` : "null"; }

const ML_PER_PAGE = 10;
var mlQuery = "", mlStatus = "all", mlCourseF = "", mlYearF = "";
var mlScope = null;
var mlPage = 1;
var mlSelected = new Set();

async function openMasterlistPage(scope = null, query = "") {
  mlScope = scope || null;
  mlQuery = query || "";
  mlPage = 1;
  mlSelected = new Set();
  closeAppModal();
  await goTo("page-masterlist");
}
// Backward-compatible entry point: the Masterlist Manager is now a full page,
// so legacy modal callers funnel here instead of opening a modal.
async function manageMasterlist(query = "", scope = null) {
  mlScope = scope || null;
  mlQuery = query || "";
  mlPage = 1;
  closeAppModal();
  if (document.getElementById("page-masterlist")?.classList.contains("active")) {
    await loadMasterlistPage();
  } else {
    await goTo("page-masterlist");
  }
}
async function loadMasterlistPage() {
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Masterlist is restricted to Super Admin.", "rgba(139,26,26,.9)"); const box0 = document.getElementById("masterlistBody"); if (box0) box0.innerHTML = `<div class="empty-state" style="padding:24px;">Restricted to Super Admin.</div>`; return; }
  const box = document.getElementById("masterlistBody");
  if (box) box.innerHTML = `<div style="text-align:center;font-size:12px;color:rgba(30,5,5,.55);padding:24px;">Loading masterlist…</div>`;
  const result = await api("/api/masterlist?full=1");
  if (!result.ok) {
    if (box) box.innerHTML = `<div class="empty-state">Could not load the masterlist.</div>`;
    else showToast("Could not load the masterlist.", "rgba(155,22,22,.85)");
    return;
  }
  window.__qrsMasterlist = result.data;
  mlSelected = new Set();
  renderMasterlistPage();
}
async function refreshMasterlistPageData() {
  const result = await api("/api/masterlist?full=1");
  if (!result.ok) { showToast("Could not reload the masterlist.", "rgba(155,22,22,.85)"); return; }
  window.__qrsMasterlist = result.data;
  mlSelected = new Set();
  await refreshMasterlistStatus();
  if (document.getElementById("page-masterlist")?.classList.contains("active")) renderMasterlistPage();
}
function masterlistFilteredList(ignoreStatus) {
  const all = window.__qrsMasterlist || [];
  const scoped = mlScope ? all.filter((e) => e.schoolYear === mlScope.schoolYear && e.course === mlScope.course && e.year === mlScope.year) : all;
  const q = (mlQuery || "").trim().toLowerCase();
  return scoped.filter((e) =>
    (!q || (e.sn || "").toLowerCase().includes(q) || (e.name || "").toLowerCase().includes(q) || (e.email || "").toLowerCase().includes(q) || (e.course || "").toLowerCase().includes(q))
    && (!mlCourseF || e.course === mlCourseF) && (!mlYearF || e.year === mlYearF)
    && (ignoreStatus || mlStatus === "all" || (mlStatus === "reg" ? e.registered : !e.registered)));
}
function setMlStatus(k) { mlStatus = k; mlPage = 1; renderMasterlistTable(); }
function setMlFilter(kind, v) { if (kind === "course") mlCourseF = v; else mlYearF = v; mlPage = 1; renderMasterlistTable(); }
function mlReset() { mlQuery = ""; mlStatus = "all"; mlCourseF = ""; mlYearF = ""; mlPage = 1; renderMasterlistPage(); }
function renderMasterlistPage() {
  const box = document.getElementById("masterlistBody");
  if (!box) return;
  const scopeBanner = mlScope
    ? `<div class="glass-card dl-card sa-scope-bar">
        <div>
          <div class="dl-title"><i class="fa-solid fa-layer-group"></i>${esc(mlScope.schoolYear)} · ${esc(mlScope.course)} · ${esc(mlScope.year)}</div>
          <div id="mlScopeCount" class="dl-sub"></div>
        </div>
        <div class="ml-tools">
          <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="openAccountsPage('groups')"><i class="fa-solid fa-arrow-left"></i>Groups</button>
          <label class="bk-btn bk-btn-out bk-btn-sm" style="cursor:pointer;"><i class="fa-solid fa-file-import"></i>Import CSV<input type="file" accept=".csv" style="display:none;" onchange="handleGroupCSV(this,'${esc(mlScope.schoolYear)}','${esc(mlScope.course)}','${esc(mlScope.year)}')"></label>
          <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="clearMasterlistScope()">View All</button>
        </div>
      </div>`
    : "";
  const mlAll = window.__qrsMasterlist || [];
  const mlCourses = [...new Set(mlAll.map((e) => e.course).filter(Boolean))].sort();
  const mlYears = [...new Set(mlAll.map((e) => e.year).filter(Boolean))].sort();
  box.innerHTML = `${scopeBanner}
    <div class="ad-tdbar"><div id="mlTabs"></div></div>
    <div class="ml-fbar">
      <label class="ml-search"><i class="fa-solid fa-magnifying-glass"></i><input id="mlSearch" type="search" placeholder="Search student no., name, email, or course\u2026" aria-label="Search masterlist" value="${esc(mlQuery)}" oninput="filterMasterlistPage(this.value)"></label>
      <div class="bk-input ml-dd"><select data-dd="1" aria-label="Course" onchange="setMlFilter('course',this.value)"><option value="">All courses</option>${mlCourses.map((c) => `<option value="${esc(c)}" ${c === mlCourseF ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
      <div class="bk-input ml-dd"><select data-dd="1" aria-label="Year level" onchange="setMlFilter('year',this.value)"><option value="">All year levels</option>${mlYears.map((y) => `<option value="${esc(y)}" ${y === mlYearF ? "selected" : ""}>${esc(y)}</option>`).join("")}</select></div>
      <button type="button" class="bk-btn bk-btn-text bk-btn-sm" onclick="mlReset()" title="Clear search and filters"><i class="fa-solid fa-rotate-left"></i>Reset</button>
      <div id="mlSelectBar" class="batch-bar" style="display:none;align-items:center;gap:10px;flex-wrap:wrap;">
        <span id="mlSelectCount" style="font-weight:700;"></span>
        <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="openRegisterAccountsModal()"><i class="fa-solid fa-user-check"></i>Register Accounts</button>
        <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="clearMlSelection()">Clear</button>
      </div>
    </div>
    <div class="ml-card dt-wrap">
      <table class="dt-table ml-table ml-admin" style="min-width:860px;">
        <thead><tr><th style="width:36px;"><input type="checkbox" id="mlSelectPage" class="batch-chk" onchange="toggleMlSelectPage(this.checked)" title="Select unregistered rows on this page" aria-label="Select unregistered rows on this page"></th><th>Student No.</th><th>Student</th><th>Course &amp; Year</th><th>School Year</th><th>Account</th><th style="text-align:right;">Actions</th></tr></thead>
        <tbody id="masterlistTableBody"></tbody>
      </table>
      <div id="masterlistTableEmpty" class="dt-empty" style="display:none;"><i class="fa-solid fa-users-rectangle"></i><div>No matching entries.</div></div>
    </div>
    <div id="masterlistPagination"></div>`;
  renderMasterlistTable();
}
function renderMasterlistTable() {
  const tbody = document.getElementById("masterlistTableBody");
  if (!tbody) return;
  const scopeArg = scopeArgOf(mlScope);
  const list = masterlistFilteredList();
  const totalPages = Math.max(1, Math.ceil(list.length / ML_PER_PAGE));
  mlPage = Math.min(Math.max(1, mlPage), totalPages);
  const items = list.slice((mlPage - 1) * ML_PER_PAGE, mlPage * ML_PER_PAGE);
  const base = masterlistFilteredList(true);
  const tabsEl = document.getElementById("mlTabs");
  if (tabsEl) tabsEl.innerHTML = dtTabs([
    { key: "all", label: "All students", count: base.length },
    { key: "unreg", label: "Not registered", count: base.filter((e) => !e.registered).length },
    { key: "reg", label: "Registered", count: base.filter((e) => e.registered).length },
  ], mlStatus, "setMlStatus", true);
  const scopeCount = document.getElementById("mlScopeCount");
  if (scopeCount) scopeCount.textContent = `${list.length} student${list.length === 1 ? "" : "s"} in this group.`;
  const empty = document.getElementById("masterlistTableEmpty");
  tbody.innerHTML = items.map((e) => `<tr class="ml-tr" onclick="if(!event.target.closest('button,input,label'))openMasterlistEditor('${esc(e.sn)}', ${scopeArg})">
      <td>${e.registered ? "" : `<input type="checkbox" class="batch-chk" ${mlSelected.has(e.sn) ? "checked" : ""} onchange="toggleMlSelect('${esc(e.sn)}', this.checked)" title="Select ${esc(e.sn)}">`}</td>
      <td><span class="ml-code">${esc(e.sn)}</span></td>
      <td><div class="ml-svc">${esc(e.name || "—")}</div><div class="ml-sub2">${esc(e.email || "—")}</div></td>
      <td><div class="ml-d">${esc(e.course || "—")}</div>${e.year ? `<div class="ml-t">${esc(e.year)}</div>` : ""}</td>
      <td><div class="ml-d">${esc(e.schoolYear || "—")}</div></td>
      <td>${e.registered ? `<span class="st-chip st-ok" title="${esc(e.account?.name || e.name || "")} · ${esc(e.account?.email || "")}"><i></i>Registered</span>` : `<span class="st-chip st-warn"><i></i>Not registered</span>`}</td>
      <td style="text-align:right;"><div class="ml-acts">
        ${e.registered ? "" : `<button type="button" class="ml-act" title="Register account" aria-label="Register account" onclick="openRegisterAccountModal('${esc(e.sn)}')"><i class="fa-solid fa-user-check"></i></button>`}
        <button type="button" class="ml-act" title="Edit entry" aria-label="Edit entry" onclick="openMasterlistEditor('${esc(e.sn)}', ${scopeArg})"><i class="fa-solid fa-pen"></i></button>
        <button type="button" class="ml-act ml-act-bad" title="Remove entry" aria-label="Remove entry" onclick="removeMasterlistEntry('${esc(e.sn)}', ${scopeArg})"><i class="fa-solid fa-trash"></i></button>
      </div></td>
    </tr>`).join("");
  if (empty) empty.style.display = list.length ? "none" : "block";
  renderTablePagination(document.getElementById("masterlistPagination"), mlPage, totalPages, list.length, "setMasterlistPage", ML_PER_PAGE);
  updateMlSelectBar(items);
}
function toggleMlSelect(sn, checked) {
  if (checked) mlSelected.add(sn);
  else mlSelected.delete(sn);
  updateMlSelectBar();
}
function toggleMlSelectPage(checked) {
  const list = masterlistFilteredList();
  const totalPages = Math.max(1, Math.ceil(list.length / ML_PER_PAGE));
  mlPage = Math.min(Math.max(1, mlPage), totalPages);
  const items = list.slice((mlPage - 1) * ML_PER_PAGE, mlPage * ML_PER_PAGE);
  items.forEach((e) => { if (!e.registered) { if (checked) mlSelected.add(e.sn); else mlSelected.delete(e.sn); } });
  renderMasterlistTable();
}
function clearMlSelection() {
  mlSelected = new Set();
  renderMasterlistTable();
}
function updateMlSelectBar(items) {
  const bar = document.getElementById("mlSelectBar");
  const count = document.getElementById("mlSelectCount");
  const pageBox = document.getElementById("mlSelectPage");
  if (pageBox && items) {
    const unreg = items.filter((e) => !e.registered);
    pageBox.checked = unreg.length > 0 && unreg.every((e) => mlSelected.has(e.sn));
    pageBox.disabled = unreg.length === 0;
  }
  if (!bar) return;
  if (!mlSelected.size) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  if (count) count.textContent = `${mlSelected.size} selected`;
}
function setMasterlistPage(page) {
  mlPage = Math.max(1, page);
  renderMasterlistTable();
}
function filterMasterlistPage(query) {
  mlQuery = query;
  mlPage = 1;
  renderMasterlistTable();
}
function clearMasterlistScope() {
  mlScope = null;
  mlQuery = "";
  mlPage = 1;
  renderMasterlistPage();
}
// Legacy modal-list helpers kept as thin aliases so any stale inline
// oninput handlers rendered before this deploy keep working.
function renderMasterlistShell(query, scope) {
  mlQuery = query || "";
  mlScope = scope || null;
  mlPage = 1;
  renderMasterlistPage();
}
function renderMasterlistResults(query, scope) {
  mlQuery = query || "";
  if (scope !== undefined) mlScope = scope || null;
  renderMasterlistTable();
}
function filterMasterlistList(query, scope) {
  mlQuery = query || "";
  if (scope !== undefined) mlScope = scope || null;
  mlPage = 1;
  if (document.getElementById("masterlistTableBody")) renderMasterlistTable();
}
function openMasterlistEditor(sn, scope = null) {
  const e = sn ? (window.__qrsMasterlist || []).find((x) => x.sn === sn) : null;
  const scopeArg = scopeArgOf(scope);
  openAppModal({ title: e ? "Edit Masterlist Entry" : "Add Masterlist Entry", subtitle: e ? "Update this student's masterlist record." : scope ? `Add a student to ${scope.schoolYear} · ${scope.course} · ${scope.year}.` : "Add a single student to the masterlist.", icon: "fa-user-pen", content: `<div class="app-modal-grid">${modalField("Student number", "mlSn", e?.sn || "", "full")}${modalField("Full name", "mlName", e?.name || "")}${modalField("Email", "mlEmail", e?.email || "")}${modalField("Course", "mlCourse", e?.course || scope?.course || "")}${modalField("Year level", "mlYear", e?.year || scope?.year || "")}${schoolYearField("mlSchoolYear", e?.schoolYear || scope?.schoolYear || "")}</div><div class="app-modal-actions"><button class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Back</button><button class="bk-btn bk-btn-fill bk-btn-sm" onclick="saveMasterlistEntry('${e?.sn || ""}', ${scopeArg})">${e ? "Save changes" : "Add entry"}</button></div>` });
  const snField = document.getElementById("mlSn");
  if (snField && e) snField.disabled = true;
  if (scope && !e) { const courseField = document.getElementById("mlCourse"), yearField = document.getElementById("mlYear"), syField = document.getElementById("mlSchoolYear"); if (courseField) courseField.disabled = true; if (yearField) yearField.disabled = true; if (syField) syField.disabled = true; }
}
async function saveMasterlistEntry(originalSn, scope = null) {
  const sn = document.getElementById("mlSn")?.value.trim();
  const name = document.getElementById("mlName")?.value.trim();
  const email = document.getElementById("mlEmail")?.value.trim();
  const course = document.getElementById("mlCourse")?.value.trim();
  const year = document.getElementById("mlYear")?.value.trim();
  const schoolYear = document.getElementById("mlSchoolYear")?.value.trim();
  if (!/^\d{4}-\d{5}-SP-\d$/.test(sn || originalSn) || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !course || !year || !validSchoolYear(schoolYear)) {
    return showToast("Enter a valid student number, full name, email, course, year level, and school year (e.g. 2026-2027).", "rgba(155,22,22,.85)");
  }
  const result = originalSn
    ? await api(`/api/masterlist/${encodeURIComponent(originalSn)}`, { method: "PATCH", body: { name, email, course, year, schoolYear } })
    : await api("/api/masterlist", { method: "POST", body: { sn, name, email, course, year, schoolYear } });
  if (result.ok) { closeAppModal(); showToast(originalSn ? "Masterlist entry updated." : "Masterlist entry added."); return refreshMasterlistPageData(); }
  showToast(result.error || "Could not save masterlist entry.", "rgba(155,22,22,.85)");
}
function removeMasterlistEntry(sn, scope = null) {
  const scopeArg = scopeArgOf(scope);
  openAppModal({ title: "Remove Masterlist Entry", subtitle: `Remove ${sn} from the masterlist? This does not delete any registered account.`, icon: "fa-user-xmark", content: `<div class="app-modal-actions"><button class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Cancel</button><button class="bk-btn bk-btn-danger bk-btn-sm" onclick="confirmRemoveMasterlistEntry('${esc(sn)}', ${scopeArg})">Remove</button></div>` });
}
async function confirmRemoveMasterlistEntry(sn, scope = null) {
  const result = await api(`/api/masterlist/${encodeURIComponent(sn)}`, { method: "DELETE" });
  if (result.ok) { closeAppModal(); showToast("Masterlist entry removed."); return refreshMasterlistPageData(); }
  showToast(result.error || "Could not remove masterlist entry.", "rgba(155,22,22,.85)");
}
function mlGenPassword(inputId) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = new Uint32Array(12);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 4294967296);
  let pw = "";
  for (let i = 0; i < buf.length; i++) pw += chars[buf[i] % chars.length];
  const el = document.getElementById(inputId);
  if (el) { el.type = "text"; el.value = pw; }
}
function openRegisterAccountModal(sn) {
  const e = (window.__qrsMasterlist || []).find((x) => x.sn === sn);
  if (!e) return showToast("Masterlist entry not found.", "rgba(155,22,22,.85)");
  if (e.registered) return showToast("That student already has an account.", "rgba(180,130,0,.85)");
  openAppModal({
    title: "Register Student Account",
    subtitle: "Create an active account from this masterlist entry — no approval needed.",
    icon: "fa-user-check",
    content: `<div class="glass-card" style="padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:14px;font-weight:800;color:#1a0505;">${esc(e.name || "—")}</div>
        <div style="font-size:11px;color:rgba(30,5,5,.62);margin-top:3px;font-family:monospace;">${esc(e.sn)}</div>
        <div style="font-size:11px;color:rgba(30,5,5,.62);margin-top:3px;">${esc(e.email || "—")} · ${esc(e.course || "—")}${e.year ? ` · ${esc(e.year)}` : ""}${e.schoolYear ? ` · ${esc(e.schoolYear)}` : ""}</div>
      </div>
      <div class="app-modal-grid"><div class="app-field full"><label for="regTempPw">Temporary password</label><div style="display:flex;gap:8px;"><div style="position:relative;flex:1;"><input id="regTempPw" type="password" class="glass-input" style="padding-right:38px;" placeholder="At least 10 characters"><button type="button" onclick="togglePass('regTempPw',this)" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(30,5,5,.55);cursor:pointer;font-size:13px;" aria-label="Toggle"><i class="fa-solid fa-eye"></i></button></div><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="mlGenPassword('regTempPw')" style="padding:8px 14px;font-size:12px;white-space:nowrap;"><i class="fa-solid fa-dice"></i> Generate</button></div><div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Share this with the student — they should change it after signing in. A copy is also emailed to them.</div></div></div>
      <div class="app-modal-actions"><button class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Back</button><button class="bk-btn bk-btn-fill bk-btn-sm" onclick="confirmRegisterAccounts(['${esc(e.sn)}'], 'regTempPw')">Register account</button></div>`,
  });
}
function openRegisterAccountsModal() {
  const list = [...mlSelected]
    .map((sn) => (window.__qrsMasterlist || []).find((x) => x.sn === sn))
    .filter((e) => e && !e.registered);
  if (!list.length) return showToast("Select at least one unregistered entry first.", "rgba(180,130,0,.85)");
  openAppModal({
    title: `Register ${list.length} Student Account${list.length === 1 ? "" : "s"}`,
    subtitle: "One shared temporary password for all selected students — they should each change it after signing in.",
    icon: "fa-users-gear",
    wide: true,
    content: `<div style="overflow:auto;max-height:30vh;border:1px solid rgba(30,5,5,.1);border-radius:12px;margin-bottom:14px;">
        <table class="glass-table" style="min-width:520px;">
          <thead><tr><th>Student No.</th><th>Name</th><th>Email</th></tr></thead>
          <tbody>${list.map((e) => `<tr><td style="font-family:monospace;font-size:12px;font-weight:800;">${esc(e.sn)}</td><td style="font-size:12px;">${esc(e.name || "—")}</td><td style="font-size:12px;">${esc(e.email || "—")}</td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="app-modal-grid"><div class="app-field full"><label for="regTempPwBulk">Temporary password (shared)</label><div style="display:flex;gap:8px;"><div style="position:relative;flex:1;"><input id="regTempPwBulk" type="password" class="glass-input" style="padding-right:38px;" placeholder="At least 10 characters"><button type="button" onclick="togglePass('regTempPwBulk',this)" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(30,5,5,.55);cursor:pointer;font-size:13px;" aria-label="Toggle"><i class="fa-solid fa-eye"></i></button></div><button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="mlGenPassword('regTempPwBulk')" style="padding:8px 14px;font-size:12px;white-space:nowrap;"><i class="fa-solid fa-dice"></i> Generate</button></div><div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Share this with the students — a copy is also emailed to each of them.</div></div></div>
      <div class="app-modal-actions"><button class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Back</button><button class="bk-btn bk-btn-fill bk-btn-sm" onclick="confirmRegisterAccounts(null, 'regTempPwBulk')">Register ${list.length} account${list.length === 1 ? "" : "s"}</button></div>`,
  });
}
async function confirmRegisterAccounts(sns, pwInputId) {
  const targets = Array.isArray(sns) && sns.length ? sns : [...mlSelected];
  if (!targets.length) return showToast("Nothing to register.", "rgba(180,130,0,.85)");
  const password = document.getElementById(pwInputId)?.value || "";
  if (password.length < 10) return showToast("Temporary password must be at least 10 characters.", "rgba(155,22,22,.85)");
  const result = await api("/api/users/students", { method: "POST", body: { sns: targets, password } });
  if (!result.ok) { showToast(result.error || "Could not register those accounts.", "rgba(155,22,22,.85)"); return; }
  const { createdCount = 0, skipped = [] } = result.data || {};
  closeAppModal();
  if (skipped.length) {
    const lines = skipped.slice(0, 8).map((s) => `${s.sn} — ${s.reason}`).join("<br>");
    openAppModal({
      title: `Registered ${createdCount} of ${targets.length}`,
      subtitle: "Some entries were skipped.",
      icon: "fa-triangle-exclamation",
      content: `<div style="font-size:12px;color:rgba(30,5,5,.75);line-height:1.7;">${lines}${skipped.length > 8 ? `<br>…and ${skipped.length - 8} more.` : ""}</div><div class="app-modal-actions"><button class="bk-btn bk-btn-fill bk-btn-sm" onclick="closeAppModal()">Done</button></div>`,
    });
  } else {
    showToast(`Registered ${createdCount} account${createdCount === 1 ? "" : "s"}.`);
  }
  mlSelected = new Set();
  return refreshMasterlistPageData();
}
async function downloadMasterlistTemplate() {
  try {
    const res = await fetch("/api/masterlist/template", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) { showToast("Could not download the template.", "rgba(155,22,22,.85)"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "masterlist-template.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    showToast("Could not download the template.", "rgba(155,22,22,.85)");
  }
}
function openMasterlistBulkAdd() {
  window.__qrsBulkRows = null;
  window.__qrsBulkPreview = null;
  window.__qrsBulkFileName = "";
  openAppModal({
    title: "Bulk Add Masterlist Entries",
    subtitle: "1) Download the template  2) Fill it in  3) Upload — review conflicts, then confirm.",
    icon: "fa-file-arrow-up",
    wide: true,
    content: `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
        <button class="btn-soft" onclick="downloadMasterlistTemplate()" style="padding:7px 14px;font-size:12px;"><i class="fa-solid fa-file-arrow-down"></i> Download template</button>
        <label class="btn-maroon" style="padding:7px 14px;font-size:12px;cursor:pointer;"><i class="fa-solid fa-file-arrow-up"></i> Choose filled sheet<input id="mlBulkFile" type="file" accept=".csv" style="display:none;" onchange="handleMasterlistBulkFile(this)"></label>
      </div>
      <div style="font-size:11px;color:rgba(30,5,5,.62);margin-bottom:12px;">Sheet columns: <b>sn, name, email, course, year, schoolYear</b> — e.g. <span style="font-family:monospace;">2024-00001-SP-0, Juan D. Cruz, juan@example.com, BSIT, 1st Year, 2026-2027</span>. Nothing is added until you confirm below.</div>
      <div id="mlBulkPreview"><div class="empty-state" style="padding:18px;"><i class="fa-solid fa-inbox"></i>No file uploaded yet.</div></div>
      <div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button id="mlBulkConfirmBtn" class="btn-maroon" onclick="confirmMasterlistBulkAdd()" disabled>Add entries</button></div>`,
  });
}
function handleMasterlistBulkFile(input) {
  if (!input.files || !input.files.length) return;
  const file = input.files[0];
  window.__qrsBulkFileName = file.name;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const rows = parseCSV(e.target.result);
      if (!rows.length) { showToast("The file is empty.", "rgba(180,130,0,.85)"); return; }
      const norm = (s) => (s || "").toLowerCase().replace(/[\s_-]/g, "");
      const SN = ["sn", "studentnumber", "studentno", "studentid", "studno", "studnum", "srcode", "idnumber", "id", "number"];
      const NM = ["name", "fullname", "studentname", "completename"];
      const EM = ["email", "emailaddress", "pupemail", "mail"];
      const CO = ["course", "program", "degree"];
      const YR = ["year", "yearlevel", "level", "yr"];
      const SY = ["schoolyear", "schoolyr", "sy", "academicyear", "ay"];
      const header = rows[0].map(norm);
      const has = (arr) => header.some((h) => arr.includes(h));
      const idxOf = (arr) => header.findIndex((h) => arr.includes(h));
      const hasHeader = has(SN) || has(NM) || has(EM) || has(CO) || has(YR) || has(SY);
      let iSN, iNM, iEM, iCO, iYR, iSY, dataRows;
      if (hasHeader) {
        iSN = idxOf(SN); iNM = idxOf(NM); iEM = idxOf(EM); iCO = idxOf(CO); iYR = idxOf(YR); iSY = idxOf(SY);
        if (iSN === -1) iSN = 0;
        dataRows = rows.slice(1);
      } else {
        iSN = 0; iNM = 1; iEM = 2; iCO = 3; iYR = 4; iSY = 5;
        dataRows = rows;
      }
      const cell = (r, i) => (i > -1 && i < r.length ? (r[i] || "").toString().trim() : "");
      const list = dataRows
        .map((r) => ({ sn: cell(r, iSN), name: cell(r, iNM), email: cell(r, iEM), course: cell(r, iCO), year: cell(r, iYR), schoolYear: cell(r, iSY) }))
        .filter((r) => r.sn || r.name || r.email);
      if (!list.length) { showToast("No rows found in the file.", "rgba(180,130,0,.85)"); return; }
      window.__qrsBulkRows = list;
      const box = document.getElementById("mlBulkPreview");
      if (box) box.innerHTML = `<div style="text-align:center;font-size:12px;color:rgba(30,5,5,.55);padding:24px;">Checking ${list.length} row${list.length === 1 ? "" : "s"} for conflicts…</div>`;
      const result = await api("/api/masterlist/batch", { method: "POST", body: { rows: list, dryRun: true, fileName: file.name } });
      if (!result.ok) { showToast(result.error || "Could not preview the file.", "rgba(155,22,22,.85)"); return; }
      window.__qrsBulkPreview = result.data;
      renderMasterlistBulkPreview();
    } catch (err) {
      showToast("Could not read that file.", "rgba(155,22,22,.85)");
    }
    input.value = "";
  };
  reader.readAsText(file);
}
function renderMasterlistBulkPreview() {
  const box = document.getElementById("mlBulkPreview");
  const btn = document.getElementById("mlBulkConfirmBtn");
  const preview = window.__qrsBulkPreview;
  if (!box || !preview) return;
  const rows = preview.rows || [];
  if (btn) {
    btn.disabled = !preview.readyCount;
    btn.innerHTML = preview.readyCount ? `Add ${preview.readyCount} entr${preview.readyCount === 1 ? "y" : "ies"}` : "Add entries";
  }
  const bannerBg = preview.conflictCount ? "rgba(180,130,0,.10)" : "rgba(22,163,74,.10)";
  const bannerBd = preview.conflictCount ? "rgba(180,130,0,.3)" : "rgba(22,163,74,.3)";
  const bannerFg = preview.conflictCount ? "#a16207" : "#15803d";
  const MAX_SHOWN = 500;
  const shown = rows.slice(0, MAX_SHOWN);
  box.innerHTML = `<div style="font-size:12px;font-weight:800;color:${bannerFg};background:${bannerBg};border:1px solid ${bannerBd};border-radius:10px;padding:9px 12px;margin-bottom:10px;">
      ${esc(window.__qrsBulkFileName || "Uploaded sheet")} — ${preview.total} row${preview.total === 1 ? "" : "s"}: <b>${preview.readyCount} ready</b>, <b>${preview.conflictCount} conflict${preview.conflictCount === 1 ? "" : "s"}</b>${rows.length > MAX_SHOWN ? ` (showing first ${MAX_SHOWN})` : ""}
    </div>
    <div style="overflow:auto;max-height:46vh;border:1px solid rgba(30,5,5,.1);border-radius:12px;">
      <table class="glass-table" style="min-width:760px;">
        <thead><tr><th>#</th><th>Student No.</th><th>Name</th><th>Email</th><th>Course / Year</th><th>SY</th><th>Status</th></tr></thead>
        <tbody>${shown.map((r) => `<tr style="${r.status === "conflict" ? "background:rgba(220,38,38,.05);" : ""}">
          <td style="font-size:11px;color:rgba(30,5,5,.55);">${r.index + 1}</td>
          <td style="font-weight:800;font-family:monospace;font-size:11px;">${esc(r.sn || "—")}</td>
          <td style="font-size:11px;">${esc(r.name || "—")}</td>
          <td style="font-size:11px;">${esc(r.email || "—")}</td>
          <td style="font-size:11px;">${esc(r.course || "—")}${r.year ? ` · ${esc(r.year)}` : ""}</td>
          <td style="font-size:11px;">${esc(r.schoolYear || "—")}</td>
          <td>${r.status === "ready"
            ? `<span style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:99px;background:rgba(22,163,74,.12);color:#15803d;white-space:nowrap;"><i class="fa-solid fa-check" style="margin-right:4px;"></i>Ready</span>`
            : `<span title="${esc(r.reason || "Conflict")}" style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:99px;background:rgba(220,38,38,.10);color:#b91c1c;white-space:nowrap;"><i class="fa-solid fa-triangle-exclamation" style="margin-right:4px;"></i>Conflict</span><div style="font-size:10px;color:#b91c1c;margin-top:3px;max-width:220px;">${esc(r.reason || "Conflict")}</div>`}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>
    ${preview.conflictCount ? `<div style="font-size:11px;color:rgba(30,5,5,.6);margin-top:8px;">Conflict rows are skipped — only the <b>${preview.readyCount} ready</b> row${preview.readyCount === 1 ? " is" : "s are"} added on confirm.</div>` : ""}`;
}
async function confirmMasterlistBulkAdd() {
  const list = window.__qrsBulkRows;
  if (!list || !list.length) return;
  const btn = document.getElementById("mlBulkConfirmBtn");
  if (btn) { btn.disabled = true; btn.innerHTML = "Adding…"; }
  const result = await api("/api/masterlist/batch", { method: "POST", body: { rows: list, dryRun: false, fileName: window.__qrsBulkFileName || "upload" } });
  if (!result.ok) {
    showToast(result.error || "Could not add those entries.", "rgba(155,22,22,.85)");
    if (btn) { btn.disabled = false; renderMasterlistBulkPreview(); }
    return;
  }
  closeAppModal();
  showToast(`Added ${result.data.added} entr${result.data.added === 1 ? "y" : "ies"}${result.data.skipped ? ` — ${result.data.skipped} conflict${result.data.skipped === 1 ? "" : "s"} skipped` : ""}.`);
  window.__qrsBulkRows = null;
  window.__qrsBulkPreview = null;
  return refreshMasterlistPageData();
}
function handleGroupCSV(input, schoolYear, course, year) {
  if (!input.files.length) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const rows = parseCSV(e.target.result);
      if (!rows.length) { showToast("The CSV file is empty.", "rgba(180,130,0,.85)"); return; }
      const norm = (s) => (s || "").toLowerCase().replace(/[\s_-]/g, "");
      const SN = ["studentnumber", "studentno", "studentid", "studno", "studnum", "srcode", "idnumber", "id", "number"];
      const NM = ["name", "fullname", "studentname", "completename"];
      const EM = ["email", "emailaddress", "pupemail", "mail"];
      const header = rows[0].map(norm);
      const has = (arr) => header.some((h) => arr.includes(h));
      const idxOf = (arr) => header.findIndex((h) => arr.includes(h));
      const hasHeader = has(SN) || has(NM) || has(EM);
      let iSN, iNM, iEM, dataRows;
      if (hasHeader) { iSN = idxOf(SN); iNM = idxOf(NM); iEM = idxOf(EM); if (iSN === -1) iSN = 0; dataRows = rows.slice(1); }
      else { iSN = 0; iNM = 1; iEM = 2; dataRows = rows; }
      const list = [];
      const seen = new Set();
      dataRows.forEach((r) => {
        const sn = (r[iSN] || "").toString().trim().toUpperCase();
        if (!sn || seen.has(sn)) return;
        seen.add(sn);
        list.push({ sn, name: iNM > -1 ? (r[iNM] || "").trim() : "", email: iEM > -1 ? (r[iEM] || "").trim() : "" });
      });
      if (!list.length) { showToast("No valid student numbers found in the CSV.", "rgba(180,130,0,.85)"); return; }
      const result = await api("/api/masterlist/import", { method: "POST", body: { rows: list, fileName: file.name, scope: { schoolYear, course, year } } });
      if (!result.ok) { showToast(result.error || "Could not import the masterlist.", "rgba(155,22,22,.85)"); return; }
      await refreshMasterlistStatus();
      showToast(`Imported ${result.data.count} students into ${schoolYear} · ${course} · ${year}.`);
      manageMasterlist("", { schoolYear, course, year });
    } catch (err) {
      showToast("Could not read that CSV file.", "rgba(155,22,22,.85)");
    }
  };
  reader.readAsText(file);
}

function addMasterlistGroupPrompt() {
  openAppModal({ title: "Add Masterlist Group", subtitle: "Register a school year, course, and year level — useful for assigning an owner before any students are imported.", icon: "fa-layer-group", content: `<div class="app-modal-grid">${schoolYearField("grpSchoolYear", "", "full")}${modalField("Course", "grpCourse", "")}${modalField("Year level", "grpYear", "")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Back</button><button class="btn-maroon" onclick="saveMasterlistGroup()">Add group</button></div>` });
}
async function saveMasterlistGroup() {
  const schoolYear = document.getElementById("grpSchoolYear")?.value.trim();
  const course = document.getElementById("grpCourse")?.value.trim();
  const year = document.getElementById("grpYear")?.value.trim();
  if (!validSchoolYear(schoolYear)) return showToast("School year must be in YYYY-YYYY format, e.g. 2026-2027.", "rgba(155,22,22,.85)");
  const result = await api("/api/masterlist/groups", { method: "POST", body: { schoolYear, course, year } });
  if (result.ok) { showToast("Masterlist group added."); closeAppModal(); return reloadAccountsPage(); }
  showToast(result.error || "Could not add that group.", "rgba(155,22,22,.85)");
}
async function openGroupOwnerEditor(id, schoolYear, course, year, currentOwnerId) {
  const staff = await api("/api/users/staff");
  const eligible = staff.ok ? staff.data.filter((u) => u.role === "ADMIN" || u.role === "SUPER_ADMIN") : [];
  let groupId = id;
  if (!groupId) {
    const created = await api("/api/masterlist/groups", { method: "POST", body: { schoolYear, course, year } });
    if (!created.ok) return showToast(created.error || "Could not register that group.", "rgba(155,22,22,.85)");
    groupId = created.data.id;
  }
  openAppModal({ title: "Assign Group Owner", subtitle: `${schoolYear} · ${course} · ${year}`, icon: "fa-user-shield", content: `<div class="app-modal-grid"><div class="app-field full"><label for="grpOwner">Owner</label><select id="grpOwner" class="glass-input"><option value="">Unassigned</option>${eligible.map((u) => `<option value="${esc(u.id)}" ${u.id === currentOwnerId ? "selected" : ""}>${esc(u.name)} (${u.role === "SUPER_ADMIN" ? "Super Admin" : "Admin"})</option>`).join("")}</select></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Back</button><button class="btn-maroon" onclick="saveGroupOwner('${esc(groupId)}')">Save</button></div>` });
}
async function saveGroupOwner(groupId) {
  const ownerId = document.getElementById("grpOwner")?.value || null;
  const result = await api(`/api/masterlist/groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: { ownerId } });
  if (result.ok) { showToast("Group owner updated."); closeAppModal(); return reloadAccountsPage(); }
  showToast(result.error || "Could not update the group owner.", "rgba(155,22,22,.85)");
}

const ACCOUNTS_TABS = [
  { id: "verifications", label: "Verifications", icon: "fa-user-check" },
  { id: "students", label: "Students", icon: "fa-user-graduate", superOnly: true },
  { id: "staff", label: "Staff", icon: "fa-user-shield", superOnly: true },
  { id: "organizations", label: "Organizations", icon: "fa-people-group", superOnly: true },
  { id: "groups", label: "Groups", icon: "fa-layer-group", superOnly: true },
];
var accountsTab = "verifications";
var accountsQuery = "";
var accountsPage = 1;
const ACCOUNTS_PER_PAGE = 10;

function visibleAccountsTabs() { return ACCOUNTS_TABS.filter((t) => !t.superOnly || isSuperAdmin()); }
async function openAccountsPage(tab) {
  if (tab) accountsTab = tab;
  if (!visibleAccountsTabs().some((t) => t.id === accountsTab)) accountsTab = "verifications";
  accountsQuery = "";
  accountsPage = 1;
  closeAppModal();
  await goTo("page-accounts");
}
async function loadAccountsPage() {
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Accounts is restricted to Super Admin.", "rgba(139,26,26,.9)"); const box0 = document.getElementById("accountsBody"); if (box0) box0.innerHTML = `<div class="empty-state" style="padding:24px;">Restricted to Super Admin.</div>`; return; }
  const box = document.getElementById("accountsBody");
  if (box) box.innerHTML = `<div style="text-align:center;font-size:12px;color:rgba(30,5,5,.55);padding:24px;">Loading accounts…</div>`;
  const superAdmin = isSuperAdmin();
  const [prof, students, staff, orgs, groups] = await Promise.all([
    api("/api/profile"),
    superAdmin ? api("/api/users/students") : Promise.resolve({ ok: true, data: [] }),
    superAdmin ? api("/api/users/staff") : Promise.resolve({ ok: true, data: [] }),
    superAdmin ? api("/api/organizations") : Promise.resolve({ ok: true, data: [] }),
    superAdmin ? api("/api/masterlist/groups") : Promise.resolve({ ok: true, data: [] }),
  ]);
  if (!prof.ok) {
    if (box) box.innerHTML = `<div class="empty-state">Could not load account data.</div>`;
    else showToast("Could not load account data.", "rgba(155,22,22,.85)");
    return;
  }
  window.__qrsProfileQueue = prof.data || [];
  window.__qrsStudents = students.ok ? (students.data || []) : [];
  window.__qrsStaff = staff.ok ? (staff.data || []) : [];
  window.__qrsOrganizations = orgs.ok ? (orgs.data || []) : [];
  window.__qrsOrganizationRepresentatives = (window.__qrsOrganizations || []).flatMap((o) => o.representatives || []);
  window.__qrsGroups = groups.ok ? (groups.data || []) : [];
  if (!visibleAccountsTabs().some((t) => t.id === accountsTab)) accountsTab = "verifications";
  renderAccountsPage();
}
async function reloadAccountsPage() {
  if (document.getElementById("page-accounts")?.classList.contains("active")) await loadAccountsPage();
}
function setAccountsTab(tab) {
  if (!isSuperAdmin() && tab !== "verifications") { showToast("\u26a0\ufe0f Access denied.", "rgba(139,26,26,.9)"); tab = "verifications"; }
  accountsTab = tab;
  accountsQuery = "";
  accountsPage = 1;
  renderAccountsPage();
}
function renderAccountsPage() {
  const box = document.getElementById("accountsBody");
  if (!box) return;
  const countMap = {
    verifications: (window.__qrsProfileQueue || []).length,
    students: (window.__qrsStudents || []).length,
    staff: (window.__qrsStaff || []).length,
    organizations: (window.__qrsOrganizations || []).length,
    groups: (window.__qrsGroups || []).length,
  };
  const tabs = visibleAccountsTabs().map((t) => ({
    key: t.id,
    label: t.label,
    icon: t.icon,
    count: countMap[t.id] ?? 0,
  }));
  box.innerHTML = `<div class="ml-toolbar" style="margin-bottom:16px;">${dtTabs(tabs, accountsTab, "setAccountsTab", true)}</div><div id="accountsTabBody"></div>`;
  renderAccountsTabBody();
}
function renderAccountsTabBody() {
  const el = document.getElementById("accountsTabBody");
  if (!el) return;
  if (accountsTab === "students") { el.innerHTML = accountsStudentsShell(); renderAccountsStudentsTable(); }
  else if (accountsTab === "staff") el.innerHTML = accountsStaffHtml();
  else if (accountsTab === "organizations") el.innerHTML = accountsOrgsHtml();
  else if (accountsTab === "groups") el.innerHTML = accountsGroupsHtml();
  else el.innerHTML = accountsVerificationsHtml();
}
function accountsVerificationsHtml() {
  const list = window.__qrsProfileQueue || [];
  if (!list.length) {
    return `<div class="dt-empty ml-empty"><i class="fa-solid fa-user-check"></i><div>No profile updates awaiting review.</div></div>`;
  }
  const rows = list.map((p) => `<tr>
    <td><span class="ml-code">${esc(p.studentId)}</span></td>
    <td><div class="ml-svc">${esc(p.name)}</div><div class="ml-sub2">${esc(p.email)}</div></td>
    <td><div class="ml-d">${esc(p.course || "No course")}</div><div class="ml-t">${esc(p.year || "No year level")}</div></td>
    <td style="text-align:right;"><div class="ml-acts">
      <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="resolveProfileChange('${esc(p.id)}','Rejected')">Reject</button>
      <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="resolveProfileChange('${esc(p.id)}','Approved')">Approve</button>
    </div></td>
  </tr>`).join("");
  return `<div class="ml-card dt-wrap"><table class="dt-table ml-table ml-admin"><thead><tr><th>Student No.</th><th>Student</th><th>Program</th><th style="text-align:right;">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
async function resolveProfileChange(id, status) {
  const result = await api(`/api/profile/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
  if (!result.ok) return showToast(result.error || "Could not update profile.", "rgba(155,22,22,.85)");
  showToast(`Profile update ${status.toLowerCase()}.`);
  const list = await api("/api/profile");
  if (list.ok) window.__qrsProfileQueue = list.data || [];
  if (document.getElementById("page-accounts")?.classList.contains("active")) renderAccountsPage();
}
function accountsStudentsShell() {
  return `
    <div class="ml-fbar">
      <label class="ml-search"><i class="fa-solid fa-magnifying-glass"></i><input id="saSearch" type="search" placeholder="Search student no., name, or email\u2026" aria-label="Search student accounts" value="${esc(accountsQuery)}" oninput="filterAccountsStudents(this.value)"></label>
      <span id="saCount" class="ml-count"></span>
    </div>
    <div class="ml-card dt-wrap">
      <table class="dt-table ml-table ml-admin" style="min-width:760px;">
        <thead><tr><th>Student No.</th><th>Student</th><th>Masterlist</th><th>Status</th><th style="text-align:right;">Action</th></tr></thead>
        <tbody id="saTableBody"></tbody>
      </table>
      <div id="saTableEmpty" class="dt-empty" style="display:none;"><i class="fa-solid fa-user-graduate"></i><div>No matching student accounts.</div></div>
    </div>
    <div id="saPagination"></div>`;
}
function accountsFilteredStudents() {
  const q = (accountsQuery || "").trim().toLowerCase();
  const all = window.__qrsStudents || [];
  if (!q) return all;
  return all.filter((u) => (u.studentId || "").toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q));
}
function renderAccountsStudentsTable() {
  const tbody = document.getElementById("saTableBody");
  if (!tbody) return;
  const list = accountsFilteredStudents();
  const totalPages = Math.max(1, Math.ceil(list.length / ACCOUNTS_PER_PAGE));
  accountsPage = Math.min(Math.max(1, accountsPage), totalPages);
  const items = list.slice((accountsPage - 1) * ACCOUNTS_PER_PAGE, accountsPage * ACCOUNTS_PER_PAGE);
  const countEl = document.getElementById("saCount");
  if (countEl) countEl.textContent = `${list.length} registered student${list.length === 1 ? "" : "s"}`;
  const empty = document.getElementById("saTableEmpty");
  tbody.innerHTML = items.map((u) => `<tr>
      <td><span class="ml-code">${esc(u.studentId || "—")}</span></td>
      <td><div class="ml-svc">${esc(u.name)}</div><div class="ml-sub2">${esc(u.email)}${u.course ? ` · ${esc(u.course)} ${esc(u.year || "")}` : ""}</div></td>
      <td>${u.masterlistLinked ? `<span class="st-chip st-ok" title="${esc(u.masterlist?.course || "")} ${esc(u.masterlist?.year || "")} · ${esc(u.masterlist?.schoolYear || "")}"><i></i>Linked</span>` : `<span class="st-chip st-warn" title="No masterlist record for this student number"><i></i>Not listed</span>`}</td>
      <td><span class="st-chip ${u.active ? "st-ok" : "st-bad"}"><i></i>${u.active ? "Active" : "On Hold"}</span></td>
      <td style="text-align:right;"><div class="ml-acts">
        <button type="button" class="bk-btn ${u.active ? "bk-btn-out" : "bk-btn-fill"} bk-btn-sm" onclick="toggleStudentHold('${esc(u.studentId)}', ${!u.active})">${u.active ? "Put on Hold" : "Reactivate"}</button>
      </div></td>
    </tr>`).join("");
  if (empty) empty.style.display = list.length ? "none" : "block";
  renderTablePagination(document.getElementById("saPagination"), accountsPage, totalPages, list.length, "setAccountsStudentsPage", ACCOUNTS_PER_PAGE);
}
function setAccountsStudentsPage(page) {
  accountsPage = Math.max(1, page);
  renderAccountsStudentsTable();
}
function filterAccountsStudents(query) {
  accountsQuery = query;
  accountsPage = 1;
  renderAccountsStudentsTable();
}
async function toggleStudentHold(sn, active) {
  const result = await api(`/api/users/students/${encodeURIComponent(sn)}`, { method: "PATCH", body: { active } });
  if (!result.ok) return showToast(result.error || "Could not update the account.", "rgba(155,22,22,.85)");
  showToast(active ? "Account reactivated." : "Account put on hold.");
  const list = await api("/api/users/students");
  if (list.ok) window.__qrsStudents = list.data || [];
  if (document.getElementById("page-accounts")?.classList.contains("active")) renderAccountsTabBody();
}
function accountsStaffHtml() {
  const list = window.__qrsStaff || [];
  const head = `<div class="ml-fbar">
    <span class="ml-count" style="margin-left:0;">${list.length} staff account${list.length === 1 ? "" : "s"}</span>
    <span style="flex:1;"></span>
    <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="openStaffEditor()"><i class="fa-solid fa-user-plus"></i>Add Staff Account</button>
  </div>`;
  if (!list.length) {
    return `${head}<div class="dt-empty ml-empty"><i class="fa-solid fa-user-shield"></i><div>No staff accounts yet.</div></div>`;
  }
  const rows = list.map((u) => `<tr>
      <td><div class="ml-svc">${esc(u.name)}</div><div class="ml-sub2">${esc(u.email)}</div></td>
      <td><span class="st-chip st-info"><i></i>${esc(String(u.role || "").replace(/_/g, " "))}</span></td>
      <td><span class="st-chip ${u.active ? "st-ok" : "st-bad"}"><i></i>${u.active ? "Active" : "Deactivated"}</span></td>
      <td style="text-align:right;"><div class="ml-acts"><button type="button" class="ml-act" title="Edit staff account" aria-label="Edit staff account" onclick="openStaffEditor('${esc(u.id)}')"><i class="fa-solid fa-pen"></i></button></div></td>
    </tr>`).join("");
  return `${head}<div class="ml-card dt-wrap"><table class="dt-table ml-table ml-admin" style="min-width:640px;"><thead><tr><th>Staff</th><th>Role</th><th>Status</th><th style="text-align:right;">Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function accountsOrgsHtml() {
  const orgs = window.__qrsOrganizations || [];
  const head = `<div class="ml-fbar">
    <span class="ml-count" style="margin-left:0;">${orgs.length} registered organization${orgs.length === 1 ? "" : "s"}</span>
    <span style="flex:1;"></span>
    <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="createOrganization()"><i class="fa-solid fa-plus"></i>Register Organization</button>
  </div>`;
  if (!orgs.length) {
    return `${head}<div class="dt-empty ml-empty"><i class="fa-solid fa-people-group"></i><div>No organizations registered yet.</div></div>`;
  }
  const cards = orgs.map((org) => {
    const reps = (org.representatives || []).map((rep) => `
      <div class="sa-rep-row">
        <div>
          <span class="ml-code" style="font-size:12px;">${esc(rep.studentId)}</span>
          <span class="st-chip ${rep.active ? "st-ok" : "st-bad"}" style="margin-left:6px;padding:2px 8px;font-size:11px;"><i></i>${rep.active ? "Active" : "Revoked"}</span>
          ${rep.expiresAt ? `<span class="ml-t" style="display:inline;margin-left:6px;">until ${new Date(rep.expiresAt).toLocaleDateString()}</span>` : ""}
        </div>
        <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="setOrganizationRep('${rep.id}',${!rep.active})">${rep.active ? "Revoke" : "Reactivate"}</button>
      </div>`).join("") || `<div class="sa-hint" style="padding-top:8px;">No representative assigned yet.</div>`;
    return `<div class="glass-card dl-card">
      <div class="dl-head">
        <div>
          <div class="dl-title">${esc(org.name)}</div>
          <div class="dl-sub">Adviser: ${esc(org.adviserName)}${org.schoolYear ? ` · ${esc(org.schoolYear)}` : ""}</div>
        </div>
        <div class="ml-tools">
          <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="assignOrganizationRep('${org.id}','${esc(org.name)}')">Assign Officer</button>
          <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="setOrganizationActive('${org.id}',${!org.active})">${org.active ? "Deactivate" : "Activate"}</button>
        </div>
      </div>
      <div class="sa-rep-list">${reps}</div>
    </div>`;
  }).join("");
  return `${head}<div class="layout-2c">${cards}</div>`;
}
function accountsGroupsHtml() {
  const list = window.__qrsGroups || [];
  const head = `<div class="ml-fbar">
    <span class="ml-count" style="margin-left:0;">${list.length} masterlist group${list.length === 1 ? "" : "s"}</span>
    <span style="flex:1;"></span>
    <button type="button" class="bk-btn bk-btn-fill bk-btn-sm" onclick="addMasterlistGroupPrompt()"><i class="fa-solid fa-plus"></i>Add Group</button>
  </div>`;
  if (!list.length) {
    return `${head}<div class="dt-empty ml-empty"><i class="fa-solid fa-layer-group"></i><div>No groups yet.</div></div>`;
  }
  const rows = list.map((g) => `<tr>
    <td><div class="ml-svc">${esc(g.course)} · ${esc(g.year)}</div><div class="ml-sub2">School Year ${esc(g.schoolYear)}</div></td>
    <td><span class="st-chip st-info"><i></i>${g.count} student${g.count === 1 ? "" : "s"}</span></td>
    <td><div class="ml-d">${g.owner ? esc(g.owner.name) : "Unassigned"}</div></td>
    <td style="text-align:right;"><div class="ml-acts">
      <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="openMasterlistPage({schoolYear:'${esc(g.schoolYear)}',course:'${esc(g.course)}',year:'${esc(g.year)}'})">View Students</button>
      <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="openGroupOwnerEditor('${esc(g.id || "")}','${esc(g.schoolYear)}','${esc(g.course)}','${esc(g.year)}','${esc(g.owner?.id || "")}')">Assign Owner</button>
    </div></td>
  </tr>`).join("");
  return `${head}<div class="ml-card dt-wrap"><table class="dt-table ml-table ml-admin"><thead><tr><th>Group</th><th>Students</th><th>Owner</th><th style="text-align:right;">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function cancelAppointment(code) {
  const a = (MOD.visits || []).find((x) => x.q === code) || {};
  openAppModal({ title: "Cancel this appointment?", subtitle: "This frees the slot for other students.", icon: "fa-calendar-xmark", content: `
    <div class="dm-kvs dm-kvs-box">
      ${dmKv("Service", a.serviceLabel || a.service || "")}
      ${dmKv("Date", a.dateLabel || "")}
      ${dmKv("Time", a.time || "")}
      ${dmKv("Reference", code)}
    </div>
    <div class="dm-note dm-note-warn"><i class="fa-solid fa-circle-info"></i><span>Cancellations follow the cutoff set by the SSO. You can book a new visit at any time.</span></div>
    <div class="app-modal-actions">
      <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Keep appointment</button>
      <button type="button" id="cancelApptBtn" class="bk-btn bk-btn-danger bk-btn-sm" onclick="confirmCancelAppointment('${esc(code)}')">Cancel appointment</button>
    </div>` });
}
async function confirmCancelAppointment(code) {
  const btn = document.getElementById("cancelApptBtn"); if (btn) btn.disabled = true;
  const result = await api(`/api/queue/${encodeURIComponent(code)}/cancel`, { method: "DELETE" });
  if (result.ok) { closeAppModal(); await refreshStudentVisitViews(); }
  else if (btn) btn.disabled = false;
  showToast(result.ok ? "Appointment cancelled." : (result.error || "Could not cancel appointment."), result.ok ? undefined : "rgba(155,22,22,.85)");
}
async function rescheduleAppointment(code) {
  rescheduleCode = code; rescheduleSelectedDate = null; rescheduleSelectedSlot = null;
  rescheduleService = (MOD.visits || []).find((q) => q.q === code)?.service || (typeof queueData !== "undefined" && queueData.find((q) => q.q === code)?.service) || "GENERAL";
  rescheduleCalMonth = new Date().getMonth(); rescheduleCalYear = new Date().getFullYear();
  rescheduleAvailability = { bookedTimes: [], myAppointment: null, slots: [] };
  const cur = (MOD.visits || []).find((x) => x.q === code) || {};
  openAppModal({ title: "Reschedule appointment", subtitle: `${cur.serviceLabel || cur.service || code}${cur.dateLabel ? ` \u00b7 currently ${cur.dateLabel}${cur.time ? ", " + cur.time : ""}` : ""}`, icon: "fa-clock-rotate-left", wide: true, content: `
    <div class="dm-resched">
      <div><h3 class="bk-h">New Date</h3><div id="rescheduleCalendar" class="bk-cal"></div></div>
      <div><h3 class="bk-h">New Time</h3><div id="rescheduleDateLabel" class="bk-hint">Select a date first.</div><div id="rescheduleTimeSlots" class="bk-slots"></div></div>
    </div>
    <div class="app-modal-actions">
      <button type="button" class="bk-btn bk-btn-out bk-btn-sm" onclick="closeAppModal()">Cancel</button>
      <button type="button" id="reschedSaveBtn" class="bk-btn bk-btn-fill bk-btn-sm" onclick="confirmRescheduleAppointment()">Save new schedule</button>
    </div>` });
  buildRescheduleCalendar();
}
async function confirmRescheduleAppointment() {
  if (!rescheduleSelectedDate || !rescheduleSelectedSlot) return showToast("Select both a new date and time.", "rgba(180,130,0,.85)");
  const dateLabel = rescheduleDateLabel(rescheduleSelectedDate);
  const saveBtn = document.getElementById("reschedSaveBtn"); if (saveBtn) saveBtn.disabled = true;
  const result = await api(`/api/queue/${encodeURIComponent(rescheduleCode)}/reschedule`, { method: "POST", body: { dateLabel, time: rescheduleSelectedSlot } });
  if (result.ok) { closeAppModal(); await refreshStudentVisitViews(); }
  else if (saveBtn) saveBtn.disabled = false;
  showToast(result.ok ? "Appointment rescheduled." : (result.error || "Could not reschedule appointment."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

function startLiveUpdates() {
  if (!session || liveEventSource || !window.EventSource) return;
  liveEventSource = new EventSource("/api/events");
  liveEventSource.addEventListener("refresh", refreshLiveData);
  liveEventSource.addEventListener("connected", refreshLiveData);
  liveEventSource.onerror = () => {  };
}
async function refreshLiveData() {
  if (!session || Date.now() - liveRefreshAt < 2500) return;
  liveRefreshAt = Date.now();
  const page = document.querySelector(".page.active")?.id;
  await loadNotifs(); updateBellBadge();
  if (page === "page-admin") {
    await Promise.all([loadQueueData(), loadAdminActivity(), loadPendingAccounts(), loadAuditLog(), loadEmailLog()]);
    renderAdminPage();
  } else if (page === "page-appointments") {
    await Promise.all([loadQueueData(), loadModule("requests"), loadModule("idapps"), loadModule("events2"), loadModule("referrals")]);
    renderAdminAppointments();
  } else if (page === "page-student") {
    await Promise.all([loadModule("requests"), loadModule("idapps"), loadModule("events2"), loadModule("referrals")]);
    renderStudentPage();
  } else if (page === "page-appointment") {
    await renderMyAppointments();
  } else if (page === "page-myrequests") {
    await renderMyRequests();
  } else if (page === "page-scanner") {
    await loadScannerQueue();
  }
}

function restoreBackup() {
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Backup restore is restricted to Super Admin.", "rgba(139,26,26,.9)"); return; }
  openAppModal({ title: "Full Database Restore", subtitle: "This replaces all STARS records using a version 2 backup. This cannot be undone.", icon: "fa-triangle-exclamation", content: `<div class="app-row"><div><div class="app-row-title" style="color:#991b1b;">Danger: all current records will be replaced</div><div class="app-row-meta">Users, appointments, complaints, settings, modules, notifications, and logs will be restored from the selected backup.</div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="pickBackupFile()"><i class="fa-solid fa-file-arrow-up"></i> Choose full backup</button></div>` });
}
function pickBackupFile() {
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Backup restore is restricted to Super Admin.", "rgba(139,26,26,.9)"); return; }
  const picker = document.createElement("input"); picker.type = "file"; picker.accept = ".json,application/json";
  picker.onchange = () => { const file = picker.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = async () => {
    try {
      const backup = JSON.parse(String(reader.result));
      if (backup.version !== 2) return showToast("Use a full version 2 STARS backup file.", "rgba(155,22,22,.85)");
      const confirmation = prompt("This permanently replaces ALL current data. Type RESTORE ALL DATA to continue:", "");
      if (confirmation !== "RESTORE ALL DATA") return showToast("Restore cancelled — confirmation did not match.", "rgba(180,130,0,.85)");
      const result = await api("/api/backup", { method: "POST", body: { backup, confirmation } });
      if (result.ok) { closeAppModal(); showToast(`Full backup restored: ${result.data.restored.users} users and ${result.data.restored.appointments} appointments.`); setTimeout(() => window.location.reload(), 900); }
      else showToast(result.error || "Could not restore backup.", "rgba(155,22,22,.85)");
    } catch { showToast("The selected file is not a valid STARS full backup.", "rgba(155,22,22,.85)"); }
  }; reader.readAsText(file); };
  picker.click();
}

// ═══════════════════════════════════════════════════════════════════════
// Feature Extensions: CSAT Ratings, Calendar Export, Walk-In Queue,
// Batch Staff Actions, and Date-Range Analytics / CSV Exports
// ═══════════════════════════════════════════════════════════════════════

var MY_FEEDBACK = {};
var MY_FEEDBACK_LOADED = false;
var _csatSelectedRating = 0;

function setMyFeedbackList(items) {
  MY_FEEDBACK = {};
  (items || []).forEach((fb) => {
    if (fb && fb.requestId) MY_FEEDBACK[fb.requestId] = fb;
  });
  MY_FEEDBACK_LOADED = true;
}

async function ensureMyFeedbackLoaded() {
  if (!session || session.role !== "student" || MY_FEEDBACK_LOADED) return;
  MY_FEEDBACK_LOADED = true;
  const res = await api("/api/feedback");
  if (res.ok && Array.isArray(res.data?.items)) {
    setMyFeedbackList(res.data.items);
    const active = document.querySelector(".page.active")?.id;
    if (active === "page-requests") renderServiceRequests();
    else if (active === "page-idapp") renderIdApp();
    else if (active === "page-appointment") renderMyAppointments();
    else if (active === "page-helpdesk") renderHelpdesk();
  }
}

function csatActionHtml(requestId, serviceLabel) {
  const existing = MY_FEEDBACK[requestId];
  if (existing) {
    return `<span class="csat-badge" title="${esc(existing.comment || "Submitted rating")}"><i class="fa-solid fa-star"></i>${existing.rating}/5 Rated</span>`;
  }
  return `<button type="button" onclick="openFeedbackModal('${esc(requestId)}','${esc(serviceLabel || "SSO Service")}')" class="btn-gold" style="padding:5px 10px;font-size:11px;"><i class="fa-solid fa-star" style="margin-right:4px;"></i>Rate Service</button>`;
}

const CSAT_LABELS = {
  1: "Poor — Needs major improvement",
  2: "Fair — Below expectations",
  3: "Good — Met expectations",
  4: "Very Good — Smooth & helpful",
  5: "Excellent — Outstanding service!",
};

function openFeedbackModal(requestId, serviceLabel) {
  _csatSelectedRating = 5;
  openAppModal({
    title: "Rate Your SSO Service Experience",
    subtitle: `${serviceLabel || "SSO Service"} · ${requestId}`,
    icon: "fa-star",
    content: `
      <div style="display:grid;gap:14px;">
        <div style="text-align:center;padding:8px 0;">
          <div style="font-size:12px;font-weight:700;color:rgba(30,5,5,.7);margin-bottom:8px;">How satisfied were you with this service?</div>
          <div id="csatStarPicker" class="csat-stars">
            ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="csat-star active" data-star="${n}" onclick="setCsatRating(${n})" aria-label="${n} star${n === 1 ? "" : "s"}"><i class="fa-solid fa-star"></i></button>`).join("")}
          </div>
          <div id="csatStarLabel" style="font-size:12px;font-weight:800;color:#8B1A1A;margin-top:8px;">${esc(CSAT_LABELS[5])}</div>
        </div>
        <div>
          <span class="input-label">Comments or Suggestions <span style="font-weight:400;color:rgba(30,5,5,.5);">(optional)</span></span>
          <textarea id="csatCommentInput" class="glass-input" rows="3" maxlength="500" placeholder="Share what went well or how we can serve students better…"></textarea>
        </div>
        <div class="app-modal-actions">
          <button type="button" class="btn-soft" onclick="closeAppModal()">Cancel</button>
          <button id="csatSubmitBtn" type="button" class="btn-maroon" onclick="submitServiceFeedback('${esc(requestId)}')"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Rating</button>
        </div>
      </div>`,
  });
}

function setCsatRating(n) {
  _csatSelectedRating = Math.min(5, Math.max(1, Number(n) || 5));
  document.querySelectorAll("#csatStarPicker .csat-star").forEach((btn) => {
    const val = Number(btn.getAttribute("data-star") || 0);
    btn.classList.toggle("active", val <= _csatSelectedRating);
  });
  const lbl = document.getElementById("csatStarLabel");
  if (lbl) lbl.textContent = CSAT_LABELS[_csatSelectedRating] || "";
}

async function submitServiceFeedback(requestId) {
  const btn = document.getElementById("csatSubmitBtn");
  const comment = (document.getElementById("csatCommentInput")?.value || "").trim();
  if (btn) btn.disabled = true;
  const res = await api("/api/feedback", {
    method: "POST",
    body: { requestId, rating: _csatSelectedRating, comment },
  });
  if (btn) btn.disabled = false;
  if (!res.ok) {
    showToast(`❌ ${res.error || "Could not submit feedback."}`, "rgba(155,22,22,.85)");
    return;
  }
  if (res.data?.feedback) MY_FEEDBACK[requestId] = res.data.feedback;
  closeAppModal();
  showToast("⭐ Thank you for your feedback!");
  const active = document.querySelector(".page.active")?.id;
  if (active === "page-appointment") await renderMyAppointments();
  else if (active === "page-requests") renderServiceRequests();
  else if (active === "page-idapp") renderIdApp();
  else if (active === "page-helpdesk") renderHelpdesk();
  else if (active === "page-student") await renderStudentPage();
}

// ── One-Tap Calendar Export (.ics & Google Calendar) ───────────────────

function downloadAppointmentIcs(code) {
  window.open(`/api/queue/${encodeURIComponent(code)}/ics`, "_blank");
}

function openGoogleCalendarForAppointment(code) {
  const a = (MOD.visits || []).find((x) => x.q === code) || (queueData || []).find((x) => x.q === code);
  if (!a) {
    downloadAppointmentIcs(code);
    return;
  }
  let start = a.startsAt ? new Date(a.startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) {
    const parsed = new Date(`${a.dateLabel} ${a.time}`);
    start = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
  const end = new Date(start.getTime() + 20 * 60000);
  const toUtc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const title = `PUP San Pedro SSO — ${a.serviceLabel || a.service || "Appointment"} (${a.q})`;
  const details = [
    `Appointment Code: ${a.q}`,
    `Service: ${a.serviceLabel || a.service || "SSO Visit"}`,
    `Schedule: ${a.dateLabel} at ${a.time} (PHT)`,
    a.purpose ? `Purpose: ${a.purpose}` : "",
    "Present your STARS offline QR pass or appointment code at the SSO Service Desk.",
  ].filter(Boolean).join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${toUtc(start)}/${toUtc(end)}`,
    location: "Student Services Office, PUP San Pedro Campus",
    details,
  });
  window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, "_blank", "noopener");
}

// ── Staff-Assisted Walk-In / Express Queue Entry ───────────────────────

var _walkInSearchTimer = null;

function openWalkInModal() {
  if (!session || !["admin", "super_admin", "scanner"].includes(session.role)) {
    showToast("⚠️ Staff access required.", "rgba(155,22,22,.85)");
    return;
  }
  const services = [
    { key: "GENERAL", label: "General SSO Visit" },
    { key: "ID_NEW", label: "ID Application — New" },
    { key: "ID_LOST", label: "ID Application — Lost" },
    { key: "AUTH", label: "Authentication" },
    { key: "EXCUSE", label: "Excuse Slip" },
    { key: "EVENT", label: "Event Request" },
    { key: "PSYCH", label: "Psychological Intervention" },
  ];
  openAppModal({
    title: "Staff-Assisted Walk-In Pass",
    subtitle: "Issue an express queue ticket right from the Service Desk",
    icon: "fa-person-walking",
    wide: true,
    content: `
      <div style="display:grid;gap:12px;">
        <div>
          <span class="input-label">Search Student (Directory or Masterlist)</span>
          <div style="position:relative;">
            <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:rgba(30,5,5,.45);font-size:12px;"></i>
            <input id="walkInSearchInput" class="glass-input" style="padding-left:34px;" placeholder="Type student number (e.g. 2024-00123-SP-0) or name…" oninput="debouncedWalkInSearch(this.value)">
          </div>
          <div id="walkInMatches" class="walkin-results"></div>
        </div>
        <div class="app-modal-grid">
          <div class="app-field">
            <label>Student Number *</label>
            <input id="walkInSn" class="glass-input" placeholder="2024-00123-SP-0">
          </div>
          <div class="app-field">
            <label>Full Name *</label>
            <input id="walkInName" class="glass-input" placeholder="Juan dela Cruz">
          </div>
          <div class="app-field">
            <label>Service Lane *</label>
            <select id="walkInService" class="glass-input">
              ${services.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join("")}
            </select>
          </div>
          <div class="app-field">
            <label>Purpose (optional)</label>
            <input id="walkInPurpose" class="glass-input" placeholder="e.g. Document inquiry / Urgent pickup">
          </div>
          <div class="app-field full">
            <label>Notes (optional)</label>
            <input id="walkInNotes" class="glass-input" placeholder="Desk notes…">
          </div>
        </div>
        <label style="display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:#1a0505;cursor:pointer;">
          <input id="walkInAutoCheckIn" type="checkbox" checked style="accent-color:#8B1A1A;width:16px;height:16px;"> Check in student immediately (ready to serve)
        </label>
        <div id="walkInFeedback" style="display:none;"></div>
        <div class="app-modal-actions">
          <button type="button" class="btn-soft" onclick="closeAppModal()">Close</button>
          <button id="walkInSubmitBtn" type="button" class="btn-maroon" onclick="submitWalkInQueue()"><i class="fa-solid fa-ticket" style="margin-right:6px;"></i>Issue Walk-In Pass</button>
        </div>
      </div>`,
  });
}

function debouncedWalkInSearch(val) {
  if (_walkInSearchTimer) clearTimeout(_walkInSearchTimer);
  const q = (val || "").trim();
  const box = document.getElementById("walkInMatches");
  if (!q || q.length < 2) {
    if (box) box.innerHTML = "";
    return;
  }
  _walkInSearchTimer = setTimeout(async () => {
    const res = await api(`/api/queue/walkin?q=${encodeURIComponent(q)}`);
    const target = document.getElementById("walkInMatches");
    if (!target) return;
    if (!res.ok || !res.data?.matches?.length) {
      target.innerHTML = `<div style="font-size:11px;color:rgba(30,5,5,.55);padding:4px 2px;">No matching student found — you can still enter Student Number &amp; Name manually below.</div>`;
      return;
    }
    target.innerHTML = res.data.matches.map((m) => `
      <button type="button" class="walkin-match" onclick="pickWalkInStudent('${esc(m.studentId)}','${esc(m.name)}')">
        <div>
          <div style="font-size:12px;font-weight:800;color:#1a0505;">${esc(m.name || "Unnamed")} <span style="font-family:monospace;font-size:11px;color:#8B1A1A;">${esc(m.studentId)}</span></div>
          <div style="font-size:10px;color:rgba(30,5,5,.6);">${esc([m.course, m.year, m.email].filter(Boolean).join(" · ") || "Masterlist entry")}</div>
        </div>
        <span class="badge ${m.registered ? "badge-approved" : "badge-pending"}" style="font-size:9px;">${m.registered ? "Registered" : "Masterlist"}</span>
      </button>`).join("");
  }, 220);
}

function pickWalkInStudent(sn, name) {
  const snEl = document.getElementById("walkInSn");
  const nameEl = document.getElementById("walkInName");
  const box = document.getElementById("walkInMatches");
  if (snEl) snEl.value = sn;
  if (nameEl) nameEl.value = name;
  if (box) box.innerHTML = "";
}

async function submitWalkInQueue() {
  const studentId = (document.getElementById("walkInSn")?.value || "").trim();
  const name = (document.getElementById("walkInName")?.value || "").trim();
  const service = document.getElementById("walkInService")?.value || "GENERAL";
  const purpose = (document.getElementById("walkInPurpose")?.value || "").trim();
  const notes = (document.getElementById("walkInNotes")?.value || "").trim();
  const autoCheckIn = !!document.getElementById("walkInAutoCheckIn")?.checked;
  const fb = document.getElementById("walkInFeedback");
  const btn = document.getElementById("walkInSubmitBtn");

  if (!studentId) {
    showToast("⚠️ Please enter or select a student number.", "rgba(180,130,0,.9)");
    return;
  }
  if (btn) btn.disabled = true;
  const res = await api("/api/queue/walkin", {
    method: "POST",
    body: { studentId, name, service, purpose, notes, autoCheckIn },
  });
  if (btn) btn.disabled = false;

  if (!res.ok) {
    const existing = res.data?.existing;
    if (fb) {
      fb.style.display = "block";
      fb.innerHTML = `<div class="info-box" style="border-color:rgba(220,38,38,.35);background:rgba(239,68,68,.08);color:#991b1b;">
        <b>${esc(res.error || "Could not issue walk-in pass.")}</b>
        ${existing ? `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <span>Existing: <b>${esc(existing.q)}</b> (${esc(existing.serviceLabel)} · ${esc(existing.time)} · ${esc(existing.displayStatus)})</span>
          ${["BOOKED", "RESCHEDULED"].includes(existing.status) ? `<button type="button" class="btn-maroon" style="padding:5px 10px;font-size:11px;" onclick="closeAppModal();queueStatus('${esc(existing.q)}','checkin')">Check In Now</button>` : ""}
        </div>` : ""}
      </div>`;
    } else {
      showToast(`❌ ${res.error || "Could not issue walk-in pass."}`, "rgba(155,22,22,.85)");
    }
    return;
  }

  const appt = res.data.appointment;
  showToast(`✅ Walk-in pass ${appt.q} issued for ${appt.name}!`);
  if (fb) {
    fb.style.display = "block";
    fb.innerHTML = `<div class="glass-card" style="padding:14px;border:1px solid rgba(21,128,61,.35);background:rgba(22,163,74,.08);">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <div style="font-size:18px;font-weight:900;color:#15803d;">${esc(appt.q)} — ${esc(appt.displayStatus)}</div>
          <div style="font-size:12px;color:#1a0505;font-weight:700;">${esc(appt.name)} (${esc(appt.studentId)})</div>
          <div style="font-size:11px;color:rgba(30,5,5,.65);">${esc(appt.serviceLabel)} · ${esc(appt.dateLabel)} · ${esc(appt.time)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:11px;" onclick="printAppointmentQr('${esc(appt.q)}')"><i class="fa-solid fa-print" style="margin-right:4px;"></i>Print Slip</button>
          <button type="button" class="btn-maroon" style="padding:6px 12px;font-size:11px;" onclick="closeAppModal();queueStatus('${esc(appt.q)}','serve')"><i class="fa-solid fa-check-double" style="margin-right:4px;"></i>Mark Served</button>
        </div>
      </div>
    </div>`;
  }
  const active = document.querySelector(".page.active")?.id;
  if (active === "page-scanner") await loadScannerQueue();
  else if (active === "page-appointments") { await loadQueueData(); renderAdminAppointments(); }
  else if (active === "page-admin") { await loadQueueData(); renderAdminPage(); }
}

// ── Batch Staff Actions ────────────────────────────────────────────────

var BATCH_SEL = {
  accounts: new Set(),
  pendingAppts: new Set(),
  requests: new Set(),
  idapps: new Set(),
};

function toggleBatchItem(group, id, checked) {
  if (!BATCH_SEL[group]) return;
  if (checked) BATCH_SEL[group].add(id);
  else BATCH_SEL[group].delete(id);
  if (group === "accounts") renderAcctApprovals();
  else if (group === "pendingAppts") renderAdminApptPending();
  else if (group === "requests") renderServiceRequests();
  else if (group === "idapps") {
    const active = document.querySelector(".page.active")?.id;
    if (active === "page-requests") renderServiceRequests();
    else renderIdApp();
  }
}

function toggleBatchSelectAll(group, checked) {
  if (!BATCH_SEL[group]) return;
  BATCH_SEL[group].clear();
  if (checked) {
    if (group === "accounts") {
      (PENDING_ACCOUNTS || []).forEach((u) => BATCH_SEL.accounts.add(u.id));
    } else if (group === "pendingAppts") {
      const q = (adminApptSearch || "").trim().toLowerCase();
      (queueData || [])
        .filter((a) => a.status === "PENDING_APPROVAL")
        .filter((a) => !q || a.q.toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.studentId || "").toLowerCase().includes(q))
        .forEach((a) => BATCH_SEL.pendingAppts.add(a.q));
    } else if (group === "idapps") {
      (MOD.idapps || [])
        .filter((a) => ["Approved", "Processing", "Ready for Claiming"].includes(a.status))
        .filter((a) => matchQ(idaAdminQ, [a.name, a.sn, a.id, a.type, a.status]))
        .forEach((a) => BATCH_SEL.idapps.add(a.id));
    }
  }
  if (group === "accounts") renderAcctApprovals();
  else if (group === "pendingAppts") renderAdminApptPending();
  else if (group === "idapps") renderIdApp();
}

async function batchApproveAccounts(approve, allPending) {
  const ids = allPending
    ? (PENDING_ACCOUNTS || []).map((u) => u.id)
    : [...BATCH_SEL.accounts];
  if (!ids.length) return showToast("⚠️ Select at least one pending account.", "rgba(180,130,0,.9)");
  const verb = approve ? "approve" : "reject and delete";
  if (!confirm(`${approve ? "Approve" : "Reject"} ${ids.length} pending student account${ids.length === 1 ? "" : "s"}? This will ${verb} them and notify each student.`)) return;
  const res = await api("/api/users/batch-approve", { method: "POST", body: { studentIds: ids, approve } });
  if (!res.ok) {
    showToast(`❌ ${res.error || "Batch account action failed."}`, "rgba(155,22,22,.85)");
    return;
  }
  BATCH_SEL.accounts.clear();
  showToast(`✅ ${res.data.processed} account${res.data.processed === 1 ? "" : "s"} ${approve ? "approved" : "rejected"}${res.data.skipped ? ` (${res.data.skipped} skipped)` : ""}.`);
  await Promise.all([loadPendingAccounts(), loadAuditLog()]);
  renderAcctApprovals();
  renderAuditLog();
}

async function batchPendingAppointments(action, allPending) {
  const q = (adminApptSearch || "").trim().toLowerCase();
  const codes = allPending
    ? (queueData || [])
        .filter((a) => a.status === "PENDING_APPROVAL")
        .filter((a) => !q || a.q.toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.studentId || "").toLowerCase().includes(q))
        .map((a) => a.q)
    : [...BATCH_SEL.pendingAppts];
  if (!codes.length) return showToast("⚠️ Select at least one pending appointment.", "rgba(180,130,0,.9)");
  let reason = "";
  if (action === "reject") {
    const input = prompt(`Reject ${codes.length} pending booking${codes.length === 1 ? "" : "s"}? Optional reason sent to students:`, "");
    if (input === null) return;
    reason = input.trim();
  } else if (!confirm(`Approve ${codes.length} pending appointment${codes.length === 1 ? "" : "s"} and email QR passes to students?`)) {
    return;
  }
  const res = await api("/api/queue/batch-status", { method: "POST", body: { codes, action, reason } });
  if (!res.ok) {
    showToast(`❌ ${res.error || "Batch action failed."}`, "rgba(155,22,22,.85)");
    return;
  }
  BATCH_SEL.pendingAppts.clear();
  showToast(`✅ ${res.data.processed} appointment${res.data.processed === 1 ? "" : "s"} ${action === "approve" ? "approved" : "rejected"}${res.data.skipped ? ` (${res.data.skipped} skipped)` : ""}.`);
  await Promise.all([loadQueueData(), loadModule("requests"), loadModule("events2"), loadModule("referrals")]);
  renderAdminAppointments();
}

function openBatchPickupModal(kind) {
  const ids = kind === "idapps" ? [...BATCH_SEL.idapps] : [...BATCH_SEL.requests];
  if (!ids.length) return showToast("⚠️ Select at least one eligible record first.", "rgba(180,130,0,.9)");
  const label = kind === "idapps" ? "ID Applications" : "Service Requests";
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  openAppModal({
    title: `Batch Schedule Pickup (${ids.length})`,
    subtitle: `${label} · ${ids.length} selected record${ids.length === 1 ? "" : "s"}`,
    icon: "fa-boxes-packing",
    content: `
      <div style="display:grid;gap:12px;">
        <div class="info-box" style="font-size:11px;padding:10px 12px;">
          <i class="fa-solid fa-circle-info" style="color:#D4A017;margin-right:5px;"></i>
          Every selected student will receive a scheduled pickup notification, synced queue appointment, offline QR pass, and <code>.ics</code> calendar invite.
        </div>
        <div class="app-modal-grid">
          <div class="app-field">
            <label>Pickup Date *</label>
            <input id="batchPickupDate" type="date" class="glass-input" value="${esc(todayIso)}">
          </div>
          <div class="app-field">
            <label>Pickup Time *</label>
            <input id="batchPickupTime" type="time" class="glass-input" value="09:00">
          </div>
          <div class="app-field full">
            <label>Note / Claiming Instructions (optional)</label>
            <input id="batchPickupNote" class="glass-input" placeholder="e.g. Bring valid student ID and claim stub at Window 2">
          </div>
        </div>
        <div class="app-modal-actions">
          <button type="button" class="btn-soft" onclick="closeAppModal()">Cancel</button>
          <button id="batchPickupSubmitBtn" type="button" class="btn-maroon" onclick="submitBatchPickup('${kind}')"><i class="fa-solid fa-calendar-check" style="margin-right:6px;"></i>Schedule ${ids.length} Pickup${ids.length === 1 ? "" : "s"}</button>
        </div>
      </div>`,
  });
}

async function submitBatchPickup(kind) {
  const ids = kind === "idapps" ? [...BATCH_SEL.idapps] : [...BATCH_SEL.requests];
  const dateIso = document.getElementById("batchPickupDate")?.value || "";
  const time24 = document.getElementById("batchPickupTime")?.value || "";
  const pickupNote = (document.getElementById("batchPickupNote")?.value || "").trim();
  const pickupDate = toDateLabel(dateIso);
  const pickupTime = toTimeLabel(time24);
  if (!pickupDate || !pickupTime) {
    showToast("⚠️ Please select both a pickup date and time.", "rgba(180,130,0,.9)");
    return;
  }
  const btn = document.getElementById("batchPickupSubmitBtn");
  if (btn) btn.disabled = true;
  const res = await api("/api/modules/batch-pickup", {
    method: "POST",
    body: { kind, ids, pickupDate, pickupTime, pickupNote },
  });
  if (btn) btn.disabled = false;
  if (!res.ok) {
    showToast(`❌ ${res.error || "Batch pickup scheduling failed."}`, "rgba(155,22,22,.85)");
    return;
  }
  if (kind === "idapps") BATCH_SEL.idapps.clear();
  else BATCH_SEL.requests.clear();
  closeAppModal();
  showToast(`✅ Scheduled ${res.data.processed} pickup${res.data.processed === 1 ? "" : "s"} for ${pickupDate} at ${pickupTime}${res.data.skipped ? ` (${res.data.skipped} skipped)` : ""}.`);
  await Promise.all([loadModule("requests"), loadModule("idapps"), loadQueueData()]);
  const active = document.querySelector(".page.active")?.id;
  if (active === "page-requests") renderServiceRequests();
  else if (active === "page-idapp") renderIdApp();
  else if (active === "page-appointments") renderAdminAppointments();
}

// ── Date-Range Analytics & Complete CSV Exports ────────────────────────

var ANALYTICS_RANGE = { from: "", to: "", preset: "all" };

function manilaIsoOffset(daysDelta) {
  const d = new Date(Date.now() + daysDelta * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

function setAnalyticsPreset(preset) {
  const today = manilaIsoOffset(0);
  ANALYTICS_RANGE.preset = preset;
  if (preset === "all") {
    ANALYTICS_RANGE.from = "";
    ANALYTICS_RANGE.to = "";
  } else if (preset === "7d") {
    ANALYTICS_RANGE.from = manilaIsoOffset(-6);
    ANALYTICS_RANGE.to = today;
  } else if (preset === "30d") {
    ANALYTICS_RANGE.from = manilaIsoOffset(-29);
    ANALYTICS_RANGE.to = today;
  } else if (preset === "month") {
    ANALYTICS_RANGE.from = `${today.slice(0, 7)}-01`;
    ANALYTICS_RANGE.to = today;
  } else if (preset === "year") {
    ANALYTICS_RANGE.from = `${today.slice(0, 4)}-01-01`;
    ANALYTICS_RANGE.to = today;
  }
  loadSystemPage();
}

function applyCustomAnalyticsRange() {
  const from = (document.getElementById("analyticsFrom")?.value || "").trim();
  const to = (document.getElementById("analyticsTo")?.value || "").trim();
  if (from && to && from > to) {
    showToast("⚠️ 'From' date cannot be after 'To' date.", "rgba(180,130,0,.9)");
    return;
  }
  ANALYTICS_RANGE.from = from;
  ANALYTICS_RANGE.to = to;
  ANALYTICS_RANGE.preset = !from && !to ? "all" : "custom";
  loadSystemPage();
}

function analyticsExportUrl(type) {
  const qs = new URLSearchParams({ type });
  if (ANALYTICS_RANGE.from) qs.set("from", ANALYTICS_RANGE.from);
  if (ANALYTICS_RANGE.to) qs.set("to", ANALYTICS_RANGE.to);
  return `/api/reports/export?${qs.toString()}`;
}
