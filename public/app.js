


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
async function loadNotifs() { const r = await api("/api/notifications"); NOTIFS = r.ok ? r.data : []; }
async function loadPendingAccounts() { if (!isSuperAdmin()) { PENDING_ACCOUNTS = []; return; } const r = await api("/api/users/pending"); PENDING_ACCOUNTS = r.ok ? r.data : []; }
async function loadModule(key) { const r = await api(`/api/modules/${key}`); MOD[key] = r.ok ? r.data : []; }
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

async function restoreSession() {
  const r = await api("/api/auth/me");
  if (r.ok && r.data && r.data.user) {
    session = r.data.user;
    startLiveUpdates();
    await goTo((session.role === "admin" || session.role === "super_admin") ? "page-admin" : session.role === "scanner" ? "page-scanner" : "page-student");
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
  if (el) { el.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:5px;"></i>${msg}`; el.style.display = "block"; }
}
function clearRegError() { const el = document.getElementById("regError"); if (el) el.style.display = "none"; }

async function handleRegister() {
  const submitButton = document.getElementById("registerSubmitBtn");
  if (submitButton?.disabled) return;
  clearRegError();
  const first = document.getElementById("regFirst").value.trim();
  const last = document.getElementById("regLast").value.trim();
  const sn = document.getElementById("regStudNum").value.trim();
  const email = document.getElementById("regEmail").value.trim();
  const pass = document.getElementById("regPass").value;
  const course = document.getElementById("regCourse").value;
  const year = document.getElementById("regYear").value;

  if (!first || !last || !sn || !email || !pass) {
    showRegError("Please complete all fields before creating your account.");
    return;
  }
  if (pass.length < 6) {
    showRegError("Password must be at least 6 characters.");
    return;
  }

  if (submitButton) { submitButton.disabled = true; submitButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px;"></i>CREATING ACCOUNT…'; }
  const { ok, data } = await api("/api/auth/register", { method: "POST", body: { first, last, sn, email, password: pass, course, year } });
  if (!ok) {
    if (submitButton) { submitButton.disabled = false; submitButton.innerHTML = '<i class="fa-solid fa-user-plus" style="margin-right:8px;"></i>CREATE ACCOUNT'; }
    showRegError((data && data.error) || "Could not create your account.");
    return;
  }

  showToast("✅ Account created! It will be reviewed by the SSO — you can sign in once approved.");
  ["regFirst", "regLast", "regStudNum", "regEmail", "regPass"].forEach((id) => { const e = document.getElementById(id); if (e) e.value = ""; });
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

function clearRegisterForm() {
  ["regFirst", "regLast", "regStudNum", "regEmail", "regPass"].forEach((id) => {
    const field = document.getElementById(id);
    if (field) { field.value = ""; field.style.borderColor = ""; }
  });
  ["regCourse", "regYear"].forEach((id) => {
    const field = document.getElementById(id);
    if (field) field.selectedIndex = 0;
  });
  clearRegError();
  const helper = document.getElementById("studNumHelper");
  if (helper) helper.innerHTML = '<i class="fa-solid fa-circle-info" style="margin-right:3px;"></i>Format: 2024-00000-SP-0';
  checkStrength("");
  const button = document.getElementById("registerSubmitBtn");
  if (button) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-user-plus" style="margin-right:8px;"></i>CREATE ACCOUNT'; }
}


async function goTo(pageId) {
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
      showToast("\u26a0\ufe0f Masterlist Manager is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (pageId === "page-system" && !isSuperAdmin()) {
      showToast("\u26a0\ufe0f Insights & System is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (pageId === "page-accounts" && !isSuperAdmin()) {
      showToast("\u26a0\ufe0f Accounts & Access is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (session.role === "student" && (pageId === "page-admin" || pageId === "page-manage" || pageId === "page-appointments")) {
      showToast("⚠️ Access denied.", "rgba(139,26,26,.9)"); return;
    }
    if ((session.role === "admin" || session.role === "super_admin") && (pageId === "page-student" || pageId === "page-appointment" || pageId === "page-appointment-book" || pageId === "page-tickets")) {
      showToast("⚠️ Access denied.", "rgba(139,26,26,.9)"); return;
    }
  }
  if (document.querySelector(".page.active")?.id === "page-admin" && pageId !== "page-admin") {
    if (donutChart) { try { donutChart.destroy(); } catch (e) {} donutChart = null; }
    if (barChartInst) { try { barChartInst.destroy(); } catch (e) {} barChartInst = null; }
  }
  prevPage = document.querySelector(".page.active")?.id;
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

  const noNav = ["page-login", "page-register"];
  document.getElementById("mainNav").style.display = noNav.includes(pageId) ? "none" : "block";
  if (noNav.includes(pageId)) closeMobileMenu();
  if (pageId === "page-student") { await loadModule("requests"); renderStudentPage(); }
  if (pageId === "page-admin") {
    await Promise.all([loadQueueData(), loadAuditLog(), loadEmailLog(), loadEmailStatus(), loadPendingAccounts(), refreshMasterlistStatus(), loadAdminActivity()]);
    renderAdminPage();
  }
  if (pageId === "page-appointments") { await Promise.all([loadQueueData(), loadModule("requests"), loadModule("idapps")]); renderAdminAppointments(); }
  const _bp = document.getElementById("bellPanel"); if (_bp) _bp.style.display = "none";
  if (pageId === "page-appointment") renderMyAppointments();
  if (pageId === "page-appointment-book") { buildServiceChips(); buildCalendar(); }
  if (pageId === "page-scanner") loadScannerQueue();
  if (pageId === "page-manage") renderManageHub();
  if (pageId === "page-masterlist") await loadMasterlistPage();
  if (pageId === "page-accounts") await loadAccountsPage();
  if (pageId === "page-system") await loadSystemPage();
  if (pageId === "page-settings") renderSettingsPage();
  if (pageId === "page-account") renderAccountPage();
  if (pageId === "page-referral") { await loadModule("referrals"); renderReferral(); }
  if (pageId === "page-idapp") { await loadModule("idapps"); renderIdApp(); }
  if (pageId === "page-bulletin") { await loadModule("bulletins"); renderBulletin(); }
  if (pageId === "page-helpdesk") { await Promise.all([loadModule("tickets"), loadModule("faqs")]); renderHelpdesk(); }
  if (pageId === "page-tickets") { await loadModule("tickets"); renderTicketsPage(); }
  if (pageId === "page-faq") { await Promise.all([loadModule("faqs"), loadFaqCategories(), loadCuration()]); renderFaq(); }
  if (pageId === "page-requests") { await loadModule("requests"); if (isAdmin()) await loadModule("idapps"); renderServiceRequests(); }
  if (pageId === "page-complaint") { await loadModule("complaints"); renderComplaint(); }
  if (pageId === "page-forms") { await loadModule("forms"); renderForms(); }
  if (pageId === "page-memo") { await loadModule("memos"); renderMemo(); }
  if (["page-login", "page-register"].includes(pageId)) {
    await Promise.all([refreshMasterlistStatus(), loadRegistrationCourses()]);
  }
  await updateNav(pageId);
}
async function goBack() { await goTo(prevPage || (isAdmin() ? "page-admin" : "page-student")); }


async function updateNav(pageId) {
  if (!session) return;
  await loadNotifs();
  if (!knownNotificationIds.size) knownNotificationIds = new Set(NOTIFS.map((n) => n.id));
  startNotificationPolling();
  startAdminDashboardPolling();
  const role = session.role === "super_admin" ? "admin" : session.role;
  const links = {
    student: [{ label: "Dashboard", icon: "fa-house", page: "page-student" }, { label: "Appointments", icon: "fa-calendar", page: "page-appointment" }],
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
  const ctrl = `<div class="sidebar-divider"></div>
    <button onclick="goTo('page-account')" class="nav-link"><i class="fa-solid fa-gear"></i><span>Settings</span></button>
    <div class="sidebar-user"><div class="sidebar-user-icon"><i class="fa-solid ${iconMap[role]}"></i></div><span>${session.name.split(" ")[0]}</span></div>
    <button onclick="signOut()" class="nav-link sidebar-logout"><i class="fa-solid fa-right-from-bracket"></i><span>Logout</span></button>`;
  document.getElementById("desktopNavLinks").innerHTML = navItems + ctrl;
  updateBellBadge();
  document.getElementById("mobileMenuLinks").innerHTML =
    mobileItems +
    `<div style="height:1px;background:rgba(255,255,255,.14);margin:10px 0;"></div>` +
    `<button onclick="goTo('page-account');closeMobileMenu();" class="nav-link" style="justify-content:flex-start;"><i class="fa-solid fa-gear" style="font-size:11px;color:#F5C518;"></i>Settings</button>` +
    `<button onclick="signOut()" class="nav-link" style="color:rgba(239,68,68,.7);justify-content:flex-start;margin-top:4px;"><i class="fa-solid fa-right-from-bracket"></i>Logout</button>`;
}
function pwField(label, id, extra = "") {
  return `<div class="app-field ${extra}"><label for="${id}">${esc(label)}</label><div style="position:relative;"><input id="${id}" type="password" class="glass-input" style="padding-right:38px;"><button type="button" onclick="togglePass('${id}',this)" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(30,5,5,.55);cursor:pointer;font-size:13px;" aria-label="Toggle"><i class="fa-solid fa-eye"></i></button></div></div>`;
}
async function renderAccountPage() {
  const box = document.getElementById("accountBody");
  if (!box || !session) return;
  const u = session;
  const roleLabel = (u.role || "").split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const infoRows = [
    { label: "Name", value: u.name || "" },
    { label: "Email", value: u.email || "" },
    ...(u.role === "student" ? [{ label: "Student Number", value: u.id || "" }] : []),
    { label: "Role", value: roleLabel },
    ...(u.course ? [{ label: "Course", value: u.course }] : []),
    ...(u.year ? [{ label: "Year Level", value: u.year }] : []),
  ];
  let profileCard = "";
  if (u.role === "student") {
    const current = await api("/api/profile");
    const pending = current.ok && current.data.pending;
    const pu = (current.ok && current.data.user) || u;
    profileCard = `
    <div class="glass-card" style="padding:22px;margin-bottom:16px;">
      <div style="font-size:15px;font-weight:800;color:#1a0505;margin-bottom:4px;"><i class="fa-solid fa-user-pen" style="color:#D4A017;margin-right:8px;"></i>Edit Profile</div>
      <div style="font-size:11px;color:rgba(30,5,5,.62);margin-bottom:12px;">Changes are reviewed by Student Services before they are applied.</div>
      ${pending
        ? `<div class="info-box" style="font-size:12px;">Your profile update is already awaiting staff verification.</div>`
        : `<div style="display:grid;gap:12px;">
          <div><span class="input-label">Full name</span><input id="profileName" class="glass-input" value="${esc(pu.name || "")}"></div>
          <div><span class="input-label">Email</span><input id="profileEmail" class="glass-input" value="${esc(pu.email || "")}"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div><span class="input-label">Course</span><input id="profileCourse" class="glass-input" value="${esc(pu.course || "")}"></div>
            <div><span class="input-label">Year level</span><input id="profileYear" class="glass-input" value="${esc(pu.year || "")}"></div>
          </div>
          <div><button onclick="saveProfileEdit()" class="btn-maroon" style="padding:11px 22px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit for review</button></div>
        </div>`}
    </div>`;
  }
  box.innerHTML = `
    <div class="glass-card" style="padding:22px;margin-bottom:16px;">
      <div style="font-size:15px;font-weight:800;color:#1a0505;margin-bottom:12px;"><i class="fa-solid fa-id-badge" style="color:#D4A017;margin-right:8px;"></i>Account Information</div>
      ${infoRows.map((r) => `<div class="detail-row"><span class="detail-label">${esc(r.label)}</span><span class="detail-value">${esc(r.value)}</span></div>`).join("")}
    </div>
    ${profileCard}
    <div class="glass-card" style="padding:22px;margin-bottom:16px;">
      <div style="font-size:15px;font-weight:800;color:#1a0505;margin-bottom:4px;"><i class="fa-solid fa-key" style="color:#D4A017;margin-right:8px;"></i>Change Password</div>
      <div style="font-size:11px;color:rgba(30,5,5,.62);margin-bottom:12px;">Choose a new password of at least 6 characters.</div>
      <div style="display:grid;gap:12px;max-width:520px;">
        ${pwField("Current password", "cpCurrent")}${pwField("New password", "cpNew")}${pwField("Confirm new password", "cpConfirm")}
        <div><button onclick="submitChangePassword()" class="btn-maroon" style="padding:11px 22px;">Update password</button>
        <span id="pwMsg" style="font-size:12px;color:rgba(30,5,5,.6);margin-left:10px;"></span></div>
      </div>
    </div>`;
}
async function submitChangePassword() {
  const currentPassword = document.getElementById("cpCurrent")?.value;
  const newPassword = document.getElementById("cpNew")?.value;
  const confirmPassword = document.getElementById("cpConfirm")?.value;
  const msg = document.getElementById("pwMsg");
  if (!currentPassword || !newPassword) { if (msg) msg.textContent = "Enter your current and new password."; return; }
  if (newPassword !== confirmPassword) { if (msg) msg.textContent = "New passwords do not match."; return; }
  const result = await api("/api/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
  if (msg) msg.textContent = result.ok ? "Password updated." : (result.error || "Could not update password.");
  if (result.ok) { document.getElementById("cpCurrent").value = ""; document.getElementById("cpNew").value = ""; document.getElementById("cpConfirm").value = ""; }
  showToast(result.ok ? "Password updated." : (result.error || "Could not update password."), result.ok ? undefined : "rgba(155,22,22,.85)");
}
function toggleMobileMenu() { document.getElementById("mobileMenu").classList.toggle("open"); document.getElementById("mobileMenuBackdrop").classList.toggle("open"); }
function closeMobileMenu() { document.getElementById("mobileMenu").classList.remove("open"); document.getElementById("mobileMenuBackdrop").classList.remove("open"); }
async function signOut() {
  await api("/api/auth/logout", { method: "POST" });
  if (liveEventSource) { liveEventSource.close(); liveEventSource = null; }
  session = null;
  await goTo("page-login");
  showToast("Signed out successfully.");
}


async function renderStudentPage() {
  if (!session || session.role !== "student") return;
  document.getElementById("studentWelcomeName").textContent = session.name;

  const hist = await api("/api/queue?mine=1&history=1");
  const visits = hist.ok ? hist.data : [];
  const approved = visits.filter(isApprovedVisit);
  const pickups = studentPickups();
  document.getElementById("kpiTotal").textContent = visits.length;
  document.getElementById("kpiPending").textContent = approved.length + pickups.length;
  document.getElementById("kpiReady").textContent = visits.filter((a) => a.status === "SERVED").length;
  renderDashboardAppointments(visits);
  renderStudentAppointment();
  renderStudentRequestCard(visits);
}

// Visit routing (student dashboard): booked but not yet approved visits live
// under My Requests; approved (checked-in / in-progress) visits and scheduled
// pickups live under My Appointments.
function isAwaitingVisit(a) { return ["BOOKED", "RESCHEDULED", "PENDING", "PENDING_APPROVAL"].includes(a.status); }
function isApprovedVisit(a) { return ["CHECKED_IN"].includes(a.status); }
function studentPickups() {
  if (!session) return [];
  return (MOD.requests || []).filter((r) => r.sn === session.id && r.status === "Pickup Scheduled");
}
function isTerminalReferral(s) { return /^(completed|rejected|cancelled|no.?show)$/i.test((s || "").trim()); }
function isTerminalIdApp(s) { return /^(claimed|completed|rejected|cancelled)$/i.test((s || "").trim()); }
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

function renderDashboardAppointments(visits) {
  const box = document.getElementById("dashboardAppointments");
  if (!box) return;
  const approved = (visits || []).filter(isApprovedVisit).slice(0, 5);
  const pickups = studentPickups().slice(0, 5);
  const rows = [
    ...approved.map((a) => `<tr>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${esc(a.q)}</span></td>
      <td style="font-size:12px;white-space:nowrap;">${esc(a.dateLabel)} · ${esc(a.time)}</td>
      <td style="font-size:12px;">${esc(a.serviceLabel || a.service || "")}</td>
      <td>${apptStatusPill(a.status)}</td>
    </tr>`),
    ...pickups.map((r) => `<tr>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${esc(r.id)}</span></td>
      <td style="font-size:12px;white-space:nowrap;">${esc(r.pickupDate)} · ${esc(r.pickupTime)}</td>
      <td style="font-size:12px;">${esc(reqServiceLabel(r.service))} — Pickup</td>
      <td>${pill(r.status)}</td>
    </tr>`),
  ];
  if (!rows.length) {
    box.innerHTML = `<div style="text-align:center;font-size:12px;color:rgba(30,5,5,.55);padding:14px 0;">No approved visits yet — pending bookings live under My Requests.<br><button onclick="goTo('page-appointment-book')" class="btn-gold" style="margin-top:10px;padding:8px 18px;font-size:12px;"><i class="fa-solid fa-calendar-plus" style="margin-right:6px;"></i>Book now</button></div>`;
    return;
  }
  box.innerHTML = `<div style="overflow-x:auto;"><table class="glass-table" style="min-width:520px;"><thead><tr><th>Code</th><th>Date &amp; Time</th><th>Service</th><th>Status</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}


const REQ_TERMINAL_RE = /^(rejected|completed|cancelled|claimed|no.?show)$/i;
function renderStudentRequestCard(visits) {
  const el = document.getElementById("studentRequestCard");
  if (!el || !session) return;
  const mine = (MOD.requests || []).filter((r) => r.sn === session.id).slice().reverse();
  const open = mine.filter((r) => !REQ_TERMINAL_RE.test(r.status || ""));
  const awaiting = (visits || []).filter(isAwaitingVisit);
  if (!mine.length && !awaiting.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  const reqRows = (open.length ? open : mine).slice(0, 5).map((r) => `<tr><td><span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:99px;background:rgba(37,99,235,.10);color:#1d4ed8;">Request</span></td><td style="font-weight:700;">${esc(reqServiceLabel(r.service))}</td><td style="font-size:11px;font-family:monospace;">${esc(r.id)}</td><td>${pill(r.status)}</td><td style="font-size:11px;">${r.pickupDate ? `Pickup: <b>${esc(r.pickupDate)} ${esc(r.pickupTime)}</b>` : r.appointmentCode ? `Visit: <b>${esc(r.appointmentCode)}</b> · ${esc(r.dateLabel)}` : "—"}</td></tr>`).join("");
  const visitRows = awaiting.slice(0, 5).map((a) => `<tr><td><span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:99px;background:rgba(180,130,0,.14);color:#a16207;">Visit</span></td><td style="font-weight:700;">${esc(a.serviceLabel || a.service || "")}</td><td style="font-size:11px;font-family:monospace;">${esc(a.q)}</td><td>${apptStatusPill(a.status)}</td><td style="font-size:11px;">${esc(a.dateLabel)} · ${esc(a.time)}</td></tr>`).join("");
  el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;"><div style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-file-circle-check" style="color:#D4A017;margin-right:8px;"></i>My Requests</div><button onclick="goTo('page-appointment-book')" class="btn-maroon" style="padding:8px 12px;font-size:11px;"><i class="fa-solid fa-plus" style="margin-right:5px;"></i>New Request</button></div><div style="overflow-x:auto;"><table class="glass-table" style="min-width:560px;"><thead><tr><th>Type</th><th>Service</th><th>Ref</th><th>Status</th><th>Pickup / Visit</th></tr></thead><tbody>${visitRows}${reqRows || `<tr><td colspan="5" style="text-align:center;color:rgba(30,5,5,.56);padding:12px;">No open requests.</td></tr>`}</tbody></table></div>`;
}

async function renderStudentAppointment() {
  const card = document.getElementById("studentAppointmentCard");
  if (!card) return;
  const head = `<div class="input-label" style="margin-bottom:12px;"><i class="fa-solid fa-calendar-check" style="color:#D4A017;margin-right:5px;"></i>Next Appointment</div>`;
  const bookBtn = `<button onclick="goTo('page-appointment-book')" class="btn-ghost" style="width:100%;margin-top:8px;padding:10px;"><i class="fa-solid fa-calendar-plus" style="margin-right:6px;"></i>Book Appointment</button>`;
  const result = await api("/api/queue?mine=1&history=1");
  const visits = result.ok ? result.data : [];
  const appt = visits.filter(isApprovedVisit)[0];
  if (appt) {
    card.innerHTML = `${head}<div style="background:rgba(139,26,26,.5);border:1px solid rgba(245,197,24,.25);border-radius:14px;padding:16px;text-align:center;"><div style="font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(245,197,24,.7);">Appointment Number</div><div style="font-size:32px;font-weight:900;color:#fff;line-height:1.2;">${esc(appt.q)}</div><div style="font-size:12px;color:#fff;margin-top:5px;">${esc(appt.dateLabel)} · ${esc(appt.time)}</div><div style="font-size:11px;color:#F5C518;margin-top:4px;">${esc(appt.serviceLabel || appt.service || "")}${appt.linkedId ? ` · ${esc(appt.linkedId)}` : ""} · ${esc((appt.displayStatus || appt.status || "").replace(/_/g, " "))}</div></div><button onclick="viewMyAppointment('${esc(appt.q)}')" class="btn-ghost" style="width:100%;margin-top:10px;padding:8px;font-size:11px;">View details</button>`;
    return;
  }
  const pickup = studentPickups()[0];
  if (pickup) {
    card.innerHTML = `${head}<div style="background:rgba(139,26,26,.5);border:1px solid rgba(245,197,24,.25);border-radius:14px;padding:16px;text-align:center;"><div style="font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(245,197,24,.7);">Scheduled Pickup</div><div style="font-size:22px;font-weight:900;color:#fff;line-height:1.3;">${esc(pickup.pickupDate)}<br>${esc(pickup.pickupTime)}</div><div style="font-size:11px;color:#F5C518;margin-top:4px;">${esc(reqServiceLabel(pickup.service))} · ${esc(pickup.id)}</div></div><button onclick="viewMyRequest('request','${esc(pickup.id)}')" class="btn-ghost" style="width:100%;margin-top:10px;padding:8px;font-size:11px;">View request</button>`;
    return;
  }
  card.innerHTML = `${head}<div style="font-size:12px;color:rgba(30,5,5,.65);text-align:center;padding:12px 0;">No approved visit yet — pending bookings are listed under My Requests.</div>${bookBtn}`;
}

function apptStatusPill(status) {
  const map = { PENDING_APPROVAL: "badge-pending", BOOKED: "badge-pending", RESCHEDULED: "badge-approved", CHECKED_IN: "badge-approved", IN_PROGRESS: "badge-approved", SERVED: "badge-completed", CANCELLED: "badge-rejected", NO_SHOW: "badge-rejected" };
  return `<span class="badge ${map[status] || "badge-pending"}">${esc((status || "BOOKED").replace(/_/g, " "))}</span>`;
}
async function renderMyAppointments() {
  const box = document.getElementById("myAppointmentsList");
  if (!box) return;
  box.innerHTML = `<div style="text-align:center;font-size:12px;color:rgba(30,5,5,.55);padding:24px;">Loading appointments…</div>`;
  const [result, reqRes, refRes, idaRes] = await Promise.all([
    api("/api/queue?mine=1&history=1"),
    api("/api/modules/requests"),
    api("/api/modules/referrals"),
    api("/api/modules/idapps"),
  ]);
  const list = result.ok ? result.data : [];
  MOD.visits = list;
  if (reqRes.ok) MOD.requests = reqRes.data;
  if (refRes.ok) MOD.referrals = refRes.data;
  if (idaRes.ok) MOD.idapps = idaRes.data;
  const sid = (session && session.id) || "";
  const myPickups = studentPickups();
  const awaiting = list.filter(isAwaitingVisit);
  const approved = list.filter(isApprovedVisit);
  const past = list.filter((a) => !isAwaitingVisit(a) && !isApprovedVisit(a) && a.status !== "PENDING_APPROVAL");
  const openServiceReqs = (MOD.requests || []).filter((r) => r.sn === sid && !REQ_TERMINAL_RE.test(r.status || ""));
  const openReferrals = (MOD.referrals || []).filter((r) => r.sn === sid && !isTerminalReferral(r.status));
  const openIdApps = (MOD.idapps || []).filter((a) => a.sn === sid && !isTerminalIdApp(a.status));
  const visitRow = (a, withActions) => `<tr>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${esc(a.q)}</span></td>
      <td style="font-size:12px;white-space:nowrap;">${esc(a.dateLabel)} · ${esc(a.time)}</td>
      <td style="font-size:12px;">${esc(a.serviceLabel || a.service || "")}${a.purpose ? `<div style="font-size:11px;color:rgba(30,5,5,.6);">${esc(a.purpose)}${a.copies ? ` ×${a.copies}` : ""}</div>` : ""}</td>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${a.linkedId ? esc(a.linkedId) : "—"}</span></td>
      <td>${apptStatusPill(a.status)}${apptMiniStep(a)}</td>
      <td style="text-align:right;">${withActions ? (a.status === "PENDING_APPROVAL"
        ? `<div style="display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:center;">
          <span style="font-size:10px;color:#a16207;font-weight:700;">Awaiting SSO approval</span>
          <button onclick="viewMyAppointment('${esc(a.q)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">View</button>
          <button onclick="cancelAppointment('${esc(a.q)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;color:#b91c1c;">Cancel</button>
        </div>`
        : `<div style="display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
        <button onclick="viewMyAppointment('${esc(a.q)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">View</button>
        ${(a.reschedulesLeft ?? 1) > 0
          ? `<button onclick="rescheduleAppointment('${esc(a.q)}')" title="${a.reschedulesLeft} reschedule${a.reschedulesLeft === 1 ? "" : "s"} left" class="btn-ghost" style="padding:6px 10px;font-size:11px;">Reschedule</button>`
          : `<button disabled title="Reschedule limit reached — cancel and book a new appointment instead" class="btn-ghost" style="padding:6px 10px;font-size:11px;opacity:.45;cursor:not-allowed;">Reschedule</button>`}
        <button onclick="cancelAppointment('${esc(a.q)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;color:#b91c1c;">Cancel</button>
      </div>`) : `<button onclick="viewMyAppointment('${esc(a.q)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">View</button>`}</td>
    </tr>`;
  const pickupRow = (r) => `<tr>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${esc(r.id)}</span></td>
      <td style="font-size:12px;white-space:nowrap;">${esc(r.pickupDate)} · ${esc(r.pickupTime)}</td>
      <td style="font-size:12px;">${esc(reqServiceLabel(r.service))} — Pickup${r.pickupNote ? `<div style="font-size:11px;color:rgba(30,5,5,.6);">${esc(r.pickupNote)}</div>` : ""}</td>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">—</span></td>
      <td>${pill(r.status)}</td>
      <td style="text-align:right;"><button onclick="viewMyRequest('request','${esc(r.id)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">View</button></td>
    </tr>`;
  const openReqRow = (id, when, service, linked, status, kind) => `<tr>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${esc(id)}</span></td>
      <td style="font-size:12px;white-space:nowrap;">${esc(when)}</td>
      <td style="font-size:12px;">${esc(service)}</td>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${linked ? esc(linked) : "—"}</span></td>
      <td>${pill(status)}</td>
      <td style="text-align:right;"><button onclick="viewMyRequest('${kind}','${esc(id)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">View</button></td>
    </tr>`;
  const pastRow = (a) => `<tr>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${esc(a.q)}</span></td>
      <td style="font-size:12px;white-space:nowrap;">${esc(a.dateLabel)} · ${esc(a.time)}</td>
      <td style="font-size:12px;">${esc(a.serviceLabel || a.service || "")}</td>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${a.linkedId ? esc(a.linkedId) : "—"}</span></td>
      <td>${apptStatusPill(a.status)}</td>
      <td style="text-align:right;"><button onclick="viewMyAppointment('${esc(a.q)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">View</button></td>
    </tr>`;
  const table = (title, icon, count, rows) => `
    <div class="glass-card" style="padding:0;margin-bottom:16px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px 12px;">
        <div style="font-size:14px;font-weight:800;color:#1a0505;"><i class="${icon}" style="color:#D4A017;margin-right:8px;"></i>${title}</div>
        <span style="font-size:11px;font-weight:800;color:#8B1A1A;background:rgba(139,26,26,.08);border:1px solid rgba(139,26,26,.15);border-radius:999px;padding:3px 12px;">${count}</span>
      </div>
      <div style="overflow-x:auto;padding:0 18px 18px;"><table class="glass-table" style="min-width:640px;"><thead><tr><th>Code</th><th>Date &amp; Time</th><th>Service</th><th>Linked Ref</th><th>Status</th><th style="text-align:right;">Action</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  const upcomingRows = approved.map((a) => visitRow(a, false)).join("") + myPickups.map(pickupRow).join("");
  const awaitingReqRows =
    openServiceReqs.map((r) => openReqRow(r.id, r.ts, reqServiceLabel(r.service), r.appointmentCode, r.status, "request")).join("")
    + openReferrals.map((r) => openReqRow(r.id, r.ts, `Referral — ${r.category}`, r.appointmentCode, r.status, "referral")).join("")
    + openIdApps.map((a) => openReqRow(a.id, a.ts, a.type, null, a.status, "idapp")).join("");
  const awaitingCount = awaiting.length + openServiceReqs.length + openReferrals.length + openIdApps.length;
  box.innerHTML = `
    ${awaitingCount ? table("Awaiting Review", "fa-solid fa-hourglass-half", `${awaitingCount} pending`, awaiting.map((a) => visitRow(a, true)).join("") + awaitingReqRows) + `<div style="font-size:11px;color:rgba(30,5,5,.58);margin:-8px 2px 16px;">Booked visits and open requests wait here until the SSO acts on them.</div>` : ""}
    ${upcomingRows ? table("Upcoming Visits", "fa-solid fa-calendar-day", `${approved.length + myPickups.length} active`, upcomingRows) : `<div class="glass-card" style="padding:26px;text-align:center;margin-bottom:14px;"><div style="font-size:13px;color:rgba(30,5,5,.65);margin-bottom:12px;">No upcoming appointments.</div><button onclick="goTo('page-appointment-book')" class="btn-gold" style="padding:10px 20px;"><i class="fa-solid fa-calendar-plus" style="margin-right:6px;"></i>Book your first visit</button></div>`}
    ${past.length ? table("Booking History", "fa-solid fa-clock-rotate-left", `${past.length} past`, past.map(pastRow).join("")) : ""}`;
}

// ── Student read-only appointment viewer ─────────────────────────
// My Appointments "View" buttons open details + live status in a modal.
// Read-only: reschedule / cancel stay on the table rows, everything esc()'d.
async function viewMyAppointment(code) {
  let a = (MOD.visits || []).find((x) => x.q === code);
  if (!a) {
    // Dashboard cards don't share the My Appointments cache — fetch on demand.
    const res = await api("/api/queue?mine=1&history=1");
    if (res.ok) MOD.visits = res.data;
    a = (MOD.visits || []).find((x) => x.q === code);
  }
  if (!a) { showToast("❌ Appointment not found.", "rgba(155,22,22,.85)"); return; }
  const display = esc((a.displayStatus || a.status || "").replace(/_/g, " "));
  openAppModal({ title: `${esc(a.q)} — ${esc(a.serviceLabel || a.service || "Visit")}`, subtitle: `${esc(a.dateLabel || "")} · ${esc(a.time || "")}`, icon: "fa-calendar-days", content: `
    <div style="display:grid;gap:12px;">
      <div class="glass-card" style="padding:14px;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">${apptStatusPill(a.status)}
          <span style="font-size:11px;color:rgba(30,5,5,.6);">${display}</span>
          ${a.linkedId ? `<span style="font-size:11px;">Linked ref: <b>${esc(a.linkedId)}</b></span>` : ""}
          ${a.bookedBy ? `<span style="font-size:11px;">Booked by: <b>${esc(a.bookedBy)}</b></span>` : ""}
          ${(a.reschedulesLeft ?? 1) <= 0 && !["SERVED", "CANCELLED", "NO_SHOW"].includes(a.status) ? `<span style="font-size:11px;color:#a16207;">Reschedule limit reached</span>` : ""}
        </div>
        ${a.purpose ? `<div style="font-size:12px;color:rgba(30,5,5,.8);margin-top:6px;">Purpose: <b>${esc(a.purpose)}</b>${a.copies ? ` ×${a.copies}` : ""}</div>` : ""}
        ${a.notes ? `<div style="font-size:12px;color:rgba(30,5,5,.65);margin-top:4px;font-style:italic;">“${esc(a.notes)}”</div>` : ""}
        ${a.cancelReason ? `<div style="font-size:11px;color:rgba(30,5,5,.65);margin-top:4px;">Cancel reason: ${esc(a.cancelReason)}</div>` : ""}
      </div>
      ${apptStepperHtml(a)}
      <div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button></div>
    </div>` });
}

// ── Student read-only request viewer ─────────────────────────────
// My Appointments "View" buttons open details + live status in a modal —
// no navigation to the legacy request pages. Read-only: no admin actions,
// no remarks editing, everything esc()'d.
function viewMyRequest(kind, id) {
  let item = null;
  if (kind === "referral") item = (MOD.referrals || []).find((x) => x.id === id);
  else if (kind === "idapp") item = (MOD.idapps || []).find((x) => x.id === id);
  else item = (MOD.requests || []).find((x) => x.id === id);
  if (!item) { showToast("❌ Record not found.", "rgba(155,22,22,.85)"); return; }
  const history = Array.isArray(item.history) && item.history.length
    ? `<div style="font-size:10px;color:rgba(30,5,5,.55);font-family:monospace;">${item.history.map((h) => `${esc(h.ts)} — ${esc(h.status)} by ${esc(h.by)}${h.note ? ": " + esc(h.note) : ""}`).join("<br>")}</div>`
    : "";
  const apptLine = item.appointmentCode
    ? `<div style="font-size:11px;margin-top:6px;">Visit: <b>${esc(item.appointmentCode)}</b>${item.dateLabel ? ` · ${esc(item.dateLabel)}` : ""}${item.time ? ` ${esc(item.time)}` : ""}${item.appointmentDate ? ` · ${esc(item.appointmentDate)}` : ""}${item.appointmentTime ? ` ${esc(item.appointmentTime)}` : ""}</div>`
    : "";
  const pickupLine = item.pickupDate
    ? `<div style="font-size:11px;color:#15803d;margin-top:6px;">Pickup: <b>${esc(item.pickupDate)} ${esc(item.pickupTime || "")}</b>${item.pickupNote ? ` — ${esc(item.pickupNote)}` : ""}</div>`
    : "";
  const remarksLine = item.remarks
    ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>Staff remarks:</b> ${esc(item.remarks)}</div>`
    : "";
  let title = `${esc(item.id)}`;
  let subtitle = "";
  let bodyTop = "";
  if (kind === "referral") {
    title = `Referral — ${esc(item.id)}`;
    subtitle = `${esc(item.category || "")}${item.ts ? ` · filed ${esc(item.ts)}` : ""}`;
    bodyTop = `
      ${item.details ? `<div style="font-size:12px;color:rgba(30,5,5,.8);white-space:pre-wrap;">${esc(item.details)}</div>` : ""}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:center;">${pill(item.status)}</div>`;
  } else if (kind === "idapp") {
    title = `ID Application — ${esc(item.id)}`;
    subtitle = `${esc(item.type || "")}${item.ts ? ` · filed ${esc(item.ts)}` : ""}`;
    bodyTop = `
      ${item.reason ? `<div style="font-size:12px;color:rgba(30,5,5,.8);white-space:pre-wrap;">${esc(item.reason)}</div>` : ""}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:center;">${pill(item.status)}
        ${item.orUrl ? fileLink(item.orName, item.orUrl, "OR receipt") : ""}
        ${item.affidavitUrl ? fileLink(item.affidavitName, item.affidavitUrl, "Affidavit of Loss") : ""}
      </div>
      ${item.pickedUpAt ? `<div style="font-size:11px;color:#15803d;margin-top:6px;">Claimed</div>` : ""}`;
  } else {
    title = `${esc(reqServiceLabel(item.service))} — ${esc(item.id)}`;
    subtitle = item.ts ? `filed ${esc(item.ts)}` : "";
    bodyTop = `
      ${item.subject ? `<div style="font-size:13px;font-weight:800;color:#1a0505;">${esc(item.subject)}${item.copies > 1 ? ` ×${item.copies}` : ""}</div>` : ""}
      ${item.details ? `<div style="font-size:12px;color:rgba(30,5,5,.8);margin-top:6px;white-space:pre-wrap;">${esc(item.details)}</div>` : ""}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:center;">${pill(item.status)}
        ${item.docUrl ? fileLink(item.docName, item.docUrl, "Supporting document") : ""}
      </div>`;
  }
  openAppModal({ title, subtitle, icon: "fa-file-circle-check", content: `
    <div style="display:grid;gap:12px;">
      <div class="glass-card" style="padding:14px;">${bodyTop}${apptLine}${pickupLine}${remarksLine}</div>
      ${wfStepperHtml(kind === "request" ? "request" : kind, item)}
      ${history}
      <div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button></div>
    </div>` });
}

function renderAdminPage() {
  renderAdminKPIs();
  renderAdminActivity();
  renderAdminTable();
  renderQueue();
  renderAuditLog();
  renderCharts();
  updateMasterlistStatus();
  renderEmailOutbox();
  renderAcctApprovals();
}
function renderAdminActivity() {
  const el = document.getElementById("adminActivity");
  if (!el || !ADMIN_ACTIVITY) return;
  const items = [
    ["fa-id-card", ADMIN_ACTIVITY.pendingIdApps, "Pending ID apps"],
    ["fa-calendar-clock", ADMIN_ACTIVITY.waitingAppointments, "Waiting appointments"],
    ["fa-shield-heart", ADMIN_ACTIVITY.openComplaints, "Open complaints"],
    ["fa-envelope-circle-check", ADMIN_ACTIVITY.emailFailures, "Email failures"],
  ];
  el.style.display = "block";
  el.innerHTML = `<div style="font-size:12px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-bolt" style="color:#D4A017;margin-right:6px;"></i>Staff Activity</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">${items.map(([icon, count, label]) => `<div style="display:flex;align-items:center;gap:8px;font-size:12px;"><i class="fa-solid ${icon}" style="color:#8B1A1A;"></i><b style="font-size:18px;">${count}</b><span style="color:rgba(30,5,5,.65);">${label}</span></div>`).join("")}</div>`;
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

function renderAdminTable() {
  const q = (document.getElementById("adminSearch")?.value || "").toLowerCase();
  const filter = document.getElementById("adminStatusFilter")?.value || "";
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
    const matchStatus = !filter || a.status === filter;
    const matchSvc = !svcF || (a.serviceLabel || a.service) === svcF;
    const matchQ = !q || a.name.toLowerCase().includes(q) || a.studentId.toLowerCase().includes(q) || a.q.toLowerCase().includes(q) || (a.serviceLabel || "").toLowerCase().includes(q);
    return matchStatus && matchSvc && matchQ;
  });
  const filterKey = `${q}|${filter}|${svcF}|${sortMode}`;
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
    if (done) {
      actions = `<span style="font-size:11px;font-weight:700;color:rgba(30,5,5,.68);display:inline-flex;align-items:center;gap:4px;"><i class="fa-solid fa-check-double"></i>Served</span>`;
    } else if (a.status === "CANCELLED" || a.status === "NO_SHOW") {
      actions = apptStatusPill(a.status);
    } else if (a.status === "PENDING_APPROVAL") {
      actions = pendingApptActions(a.q);
    } else {
      // Day-of steps live in the manage modal (stepper + step actions).
      actions = `<button onclick="openApptModal('${a.q}')" class="btn-maroon" style="padding:5px 12px;font-size:11px;border-radius:9px;">Manage</button>`;
    }
    return `<tr>
      <td><div style="font-weight:700;font-size:13px;color:#1a0505;">${esc(a.name)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(a.studentId)} · ${esc(a.q)}</div></td>
      <td style="font-size:13px;color:#1a0505;">${esc(a.serviceLabel || a.service || "")}${a.purpose ? `<div style="font-size:11px;color:rgba(30,5,5,.6);">${esc(a.purpose)}${a.copies ? ` ×${a.copies}` : ""}</div>` : ""}${a.notes ? `<div style="font-size:11px;color:rgba(30,5,5,.55);font-style:italic;">${esc(a.notes)}</div>` : ""}</td>
      <td style="font-size:12px;color:rgba(30,5,5,.68);">${esc(a.dateLabel)} · ${esc(a.time)}</td>
      <td>${apptStatusPill(a.status)}${apptMiniStep(a)}</td>
      <td style="text-align:right;">${actions}</td>
    </tr>`;
  }).join("");
  renderTablePagination(pagination, adminRequestPage, totalPages, filtered.length, "setAdminRequestPage");
}

function renderTablePagination(container, page, totalPages, totalCount, fnName, perPage = REQUESTS_PER_PAGE) {
  if (!container) return;
  if (!totalCount || totalPages <= 1) {
    container.innerHTML = totalCount
      ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:11px;color:rgba(30,5,5,.58);"><span>Showing ${totalCount} of ${totalCount}</span></div>`
      : "";
    return;
  }
  const start = (page - 1) * perPage;
  container.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:11px;color:rgba(30,5,5,.58);"><span>Showing ${start + 1}-${Math.min(start + perPage, totalCount)} of ${totalCount}</span><div style="display:flex;align-items:center;gap:8px;"><button class="btn-ghost" ${page <= 1 ? "disabled" : ""} onclick="${fnName}(${page - 1})" style="padding:6px 10px;font-size:11px;">‹ Previous</button><b style="color:#8B1A1A;">${page} / ${totalPages}</b><button class="btn-ghost" ${page >= totalPages ? "disabled" : ""} onclick="${fnName}(${page + 1})" style="padding:6px 10px;font-size:11px;">Next ›</button></div></div>`;
}

function setAdminRequestPage(page) {
  adminRequestPage = Math.max(1, page);
  renderAdminTable();
}

async function loadScannerQueue() {
  const box = document.getElementById("scannerQueueList");
  if (!box) return;
  box.innerHTML = `<div style="text-align:center;font-size:12px;color:rgba(30,5,5,.55);padding:16px;">Loading today's appointments…</div>`;
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const dateInput = document.getElementById("scannerDate");
  const date = dateInput?.value || today;
  const result = await api(`/api/queue/manifest?date=${encodeURIComponent(date)}`);
  const list = result.ok ? result.data.appointments : [];
  const active = list.filter((a) => ["BOOKED", "RESCHEDULED", "CHECKED_IN"].includes(a.status));
  const done = list.filter((a) => !["BOOKED", "RESCHEDULED", "CHECKED_IN"].includes(a.status));
  const item = (a) => `
    <div class="queue-item${["BOOKED", "RESCHEDULED", "CHECKED_IN"].includes(a.status) ? " qi-active" : ""}">
      <div>
        <div style="font-size:16px;font-weight:900;color:#1a0505;">${esc(a.q)}</div>
        <div style="font-size:11px;font-weight:700;color:rgba(30,5,5,.58);margin-top:2px;">${esc(a.name)} · ${esc(a.time)}</div>
        <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:1px;">${esc(a.serviceLabel || a.service || "")}${a.purpose ? ` · ${esc(a.purpose)}` : ""}${a.notes ? ` · ${esc(a.notes)}` : ""}</div>
      </div>
      ${["BOOKED", "RESCHEDULED", "CHECKED_IN"].includes(a.status)
        ? `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">${a.status === "CHECKED_IN" ? `<button onclick="queueStatus('${a.q}','serve')" class="btn-maroon" style="padding:7px 15px;font-size:12px;border-radius:10px;">Complete</button>` : `<button onclick="queueStatus('${a.q}','checkin')" class="btn-ghost" style="padding:7px 12px;font-size:12px;border-radius:10px;">Check-in</button><button onclick="queueStatus('${a.q}','serve')" class="btn-maroon" style="padding:7px 15px;font-size:12px;border-radius:10px;">Serve</button>`}</div>`
        : apptStatusPill(a.status)}
    </div>`;
  box.innerHTML = `
    <div style="font-size:10px;font-weight:800;letter-spacing:.07em;color:rgba(30,5,5,.62);text-transform:uppercase;margin:0 0 7px;">Waiting (${active.length})</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">${active.length ? active.map(item).join("") : `<div class="empty-state" style="padding:20px;">No waiting appointments for ${esc(date)}.</div>`}</div>
    ${done.length ? `<div style="font-size:10px;font-weight:800;letter-spacing:.07em;color:rgba(30,5,5,.62);text-transform:uppercase;margin:0 0 7px;">Done (${done.length})</div><div style="display:flex;flex-direction:column;gap:8px;">${done.map(item).join("")}</div>` : ""}`;
}
function renderQueue() {
  const servedCount = queueData.filter((q) => q.served).length;
  const qs = (document.getElementById("queueSearch")?.value || "").trim().toLowerCase();
  const list = queueData.filter((q) => !qs || q.q.toLowerCase().includes(qs) || q.name.toLowerCase().includes(qs) || q.studentId.toLowerCase().includes(qs));
  const waiting = list.filter((q) => !q.served);
  const served = list.filter((q) => q.served);
  const pendingCount = queueData.filter((q) => q.status === "PENDING_APPROVAL").length;
  const pendingHint = pendingCount ? ` · ${pendingCount} awaiting approval` : "";
  document.getElementById("queueMeta").textContent = qs
    ? `${list.length} of ${queueData.length} appointments match "${qs}"${pendingHint}`
    : `${queueData.length} appointments today · ${servedCount} served${pendingHint}`;
  const item = (q) => `
    <div class="queue-item${q.served ? "" : " qi-active"}">
      <div>
        <div style="font-size:18px;font-weight:900;color:${q.served ? "rgba(30,5,5,.42)" : "#1a0505"};">${q.q}</div>
        <div style="font-size:10px;font-weight:700;color:rgba(30,5,5,.55);margin-top:1px;">${q.studentId.slice(0, 12)}… · ${q.time} · ${esc(q.serviceLabel || q.service || "General")}${q.linkedId ? ` · ${esc(q.linkedId)}` : ""}</div>
        ${q.status && q.status !== "BOOKED" && !q.served ? `<div style="font-size:10px;font-weight:800;color:#8B1A1A;margin-top:2px;">${esc((q.displayStatus || q.status || "").replace(/_/g, " "))}</div>` : ""}
      </div>
      ${q.served
        ? `<span style="font-size:11px;font-weight:700;color:rgba(30,5,5,.68);display:flex;align-items:center;gap:4px;"><i class="fa-solid fa-check-double"></i>Served</span>`
        : q.status === "PENDING_APPROVAL"
          ? pendingApptActions(q.q)
          : `<div style="display:flex;gap:6px;"><button onclick="queueStatus('${q.q}','checkin')" class="btn-ghost" style="padding:6px 12px;font-size:12px;border-radius:10px;">Check-in</button><button onclick="serveQueue('${q.q}')" class="btn-maroon" style="padding:6px 14px;font-size:12px;border-radius:10px;">Serve</button></div>`}
    </div>`;
  document.getElementById("queueList").innerHTML = waiting.length
    ? waiting.map(item).join("")
    : '<div style="text-align:center;font-size:12px;color:rgba(30,5,5,.5);padding:14px;">No waiting appointments.</div>';
  const servedPanel = document.getElementById("servedQueuePanel");
  const servedList = document.getElementById("servedQueueList");
  document.getElementById("servedQueueCount").textContent = served.length ? `${served.length}` : "";
  servedList.innerHTML = served.length ? served.map(item).join("") : '<div style="font-size:11px;color:rgba(30,5,5,.5);padding:7px 0;">No served appointments.</div>';
  servedPanel.style.display = served.length ? "block" : "none";
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
        <div style="font-size:16px;font-weight:900;color:${q.served ? "rgba(30,5,5,.52)" : "#1a0505"};">${q.q}</div>
        <div style="font-size:11px;font-weight:700;color:rgba(30,5,5,.58);margin-top:2px;">${q.name} · ${q.studentId} · ${q.time}</div>
        <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:1px;">${esc(q.serviceLabel || q.service || "General")}${q.linkedId ? ` · ${esc(q.linkedId)}` : ""}${q.status && q.status !== "BOOKED" && !q.served ? ` · ${esc((q.displayStatus || q.status || "").replace(/_/g, " "))}` : ""}</div>
      </div>
      ${q.served
        ? '<span style="font-size:12px;font-weight:800;color:#15803d;"><i class="fa-solid fa-check-double" style="margin-right:4px;"></i>Served</span>'
        : q.status === "PENDING_APPROVAL"
          ? pendingApptActions(q.q)
          : `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;"><button onclick="queueStatus('${q.q}','checkin')" class="btn-ghost" style="padding:7px 12px;font-size:12px;border-radius:10px;">Check-in</button><button onclick="serveQueue('${q.q}')" class="btn-maroon" style="padding:7px 15px;font-size:12px;border-radius:10px;">Serve</button><button onclick="queueStatus('${q.q}','noshow')" class="btn-ghost" style="padding:7px 12px;font-size:12px;border-radius:10px;">No-show</button></div>`}
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
  if (calBtn) calBtn.className = adminApptView === "calendar" ? "btn-maroon" : "btn-ghost";
  if (listBtn) listBtn.className = adminApptView === "list" ? "btn-maroon" : "btn-ghost";
  const calWrap = document.getElementById("adminApptCalendarWrap");
  const listWrap = document.getElementById("adminApptListWrap");
  if (calWrap) calWrap.style.display = adminApptView === "calendar" ? "" : "none";
  if (listWrap) listWrap.style.display = adminApptView === "list" ? "" : "none";
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
function renderAdminApptPending() {
  const wrap = document.getElementById("adminApptPendingWrap");
  if (!wrap) return;
  const q = (adminApptSearch || "").trim().toLowerCase();
  const items = [...queueData]
    .filter((a) => a.status === "PENDING_APPROVAL")
    .filter((a) => !q || a.q.toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.studentId || "").toLowerCase().includes(q))
    .sort((a, b) => new Date(a.startsAt || 0) - new Date(b.startsAt || 0));
  if (!items.length || (adminApptStatus && adminApptStatus !== "PENDING_APPROVAL")) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  document.getElementById("adminApptPendingMeta").textContent = `${items.length} awaiting your approval — oldest first`;
  document.getElementById("adminApptPendingTable").innerHTML = items.map((a) => `<tr>
    <td><div style="font-weight:700;font-size:13px;color:#1a0505;">${esc(a.q)}</div><div style="font-size:11px;color:rgba(30,5,5,.6);">${esc(a.serviceLabel || a.service || "")}${a.linkedId ? ` · ${esc(a.linkedId)}` : ""}</div></td>
    <td><div style="font-size:13px;font-weight:700;color:#1a0505;">${esc(a.name)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(a.studentId)}</div></td>
    <td style="font-size:12px;color:rgba(30,5,5,.68);">${esc(a.dateLabel)} · ${esc(a.time)}</td>
    <td style="text-align:right;">${pendingApptActions(a.q)}</td>
  </tr>`).join("");
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
  let html = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;"><button type="button" class="btn-ghost" onclick="changeAdminApptMonth(-1)" style="width:32px;height:32px;padding:0;border-radius:10px;" aria-label="Previous month"><i class="fa-solid fa-chevron-left"></i></button><div style="text-align:center;font-size:15px;font-weight:900;color:#4a1515;">${esc(monthName)}</div><button type="button" class="btn-ghost" onclick="changeAdminApptMonth(1)" style="width:32px;height:32px;padding:0;border-radius:10px;" aria-label="Next month"><i class="fa-solid fa-chevron-right"></i></button></div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;margin-bottom:4px;">
    ${days.map((d) => `<div style="font-size:10px;font-weight:700;color:rgba(30,5,5,.55);padding:4px 0;">${d}</div>`).join("")}
  </div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;gap:2px;">`;
  for (let i = 0; i < first; i++) html += "<div></div>";
  for (let d = 1; d <= total; d++) {
    const label = adminApptDateLabel(adminApptYear, adminApptMonth, d);
    const n = counts[label] || 0;
    const isSel = adminApptDate === label;
    html += `<div onclick="selectAdminApptDate('${esc(label)}')" class="cal-day-avail${isSel ? " selected" : ""}" style="position:relative;">${d}${n ? `<span style="position:absolute;bottom:3px;left:50%;transform:translateX(-50%);font-size:8px;font-weight:800;background:${isSel ? "#fff" : "#8B1A1A"};color:${isSel ? "#8B1A1A" : "#fff"};border-radius:99px;padding:0 5px;line-height:1.5;">${n}</span>` : ""}</div>`;
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
        ${a.served ? "" : `<div style="margin-top:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${apptStatusPill(a.status)}${apptMiniStep(a)}</div>`}
      </div>
      ${a.served
        ? '<span style="font-size:12px;font-weight:800;color:#15803d;"><i class="fa-solid fa-check-double" style="margin-right:4px;"></i>Served</span>'
        : a.status === "PENDING_APPROVAL"
          ? pendingApptActions(a.q)
          : a.status === "CANCELLED" || a.status === "NO_SHOW"
            ? apptStatusPill(a.status)
            : `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;"><button onclick="openApptModal('${a.q}')" class="btn-maroon" style="padding:7px 14px;font-size:12px;border-radius:10px;">Manage</button></div>`}
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
    if (done) {
      actions = `<span style="font-size:11px;font-weight:700;color:rgba(30,5,5,.68);display:inline-flex;align-items:center;gap:4px;"><i class="fa-solid fa-check-double"></i>Served</span>`;
    } else if (a.status === "CANCELLED" || a.status === "NO_SHOW") {
      actions = apptStatusPill(a.status);
    } else if (a.status === "PENDING_APPROVAL") {
      actions = pendingApptActions(a.q);
    } else {
      // Day-of steps live in the manage modal (stepper + step actions).
      actions = `<button onclick="openApptModal('${a.q}')" class="btn-maroon" style="padding:5px 12px;font-size:11px;border-radius:9px;">Manage</button>`;
    }
    return `<tr>
      <td><div style="font-weight:700;font-size:13px;color:#1a0505;">${esc(a.q)}</div><div style="font-size:11px;color:rgba(30,5,5,.6);">${esc(a.serviceLabel || a.service || "")}</div></td>
      <td><div style="font-size:13px;font-weight:700;color:#1a0505;">${esc(a.name)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(a.studentId)}</div></td>
      <td style="font-size:12px;color:rgba(30,5,5,.68);">${esc(a.dateLabel)} · ${esc(a.time)}</td>
      <td>${apptStatusPill(a.status)}${apptMiniStep(a)}</td>
      <td style="text-align:right;">${actions}</td>
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
    <td style="text-align:right;"><button onclick="${p.kind === "idapps" ? "openIdAppModal" : "openRequestModal"}('${esc(p.id)}')" class="btn-maroon" style="padding:6px 12px;font-size:11px;">Manage</button></td>
  </tr>`).join("");
}

/** Action buttons for a booking awaiting SSO approval (admin only). */
function pendingApptActions(q) {
  if (!isAdmin()) return `<span style="font-size:11px;font-weight:700;color:#a16207;">Awaiting approval</span>`;
  return `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
    <button onclick="queueStatus('${q}','approve')" class="btn-maroon" style="padding:5px 12px;font-size:11px;border-radius:9px;">Approve</button>
    <button onclick="queueStatus('${q}','reject')" class="btn-ghost" style="padding:5px 12px;font-size:11px;border-radius:9px;">Reject</button>
    <button onclick="openApptModal('${q}')" class="btn-ghost" style="padding:5px 12px;font-size:11px;border-radius:9px;">Manage</button>
  </div>`;
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
/** Step-action buttons for the manage modal (staff roles only). */
function apptAdminActionsHtml(a) {
  const q = esc(a.q);
  const stage = apptStage(a);
  if (a.status === "PENDING_APPROVAL") {
    return `<button class="btn-maroon" onclick="apptAdvance('${q}','approve')">Approve booking</button>`
      + `<button class="btn-ghost" onclick="apptAdvance('${q}','reject')">Reject</button>`;
  }
  if (stage === 1) {
    return `<button class="btn-maroon" onclick="apptAdvance('${q}','checkin')">Check in</button>`
      + `<button class="btn-ghost" onclick="apptAdvance('${q}','noshow')">No-show</button>`
      + `<button class="btn-ghost" style="color:#b91c1c;" onclick="apptAdvance('${q}','cancel')">Cancel visit</button>`;
  }
  if (stage === 2) {
    return `<button class="btn-maroon" onclick="apptAdvance('${q}','serve')">Complete visit</button>`
      + `<button class="btn-ghost" onclick="apptAdvance('${q}','noshow')">No-show</button>`
      + `<button class="btn-ghost" style="color:#b91c1c;" onclick="apptAdvance('${q}','cancel')">Cancel visit</button>`;
  }
  return "";
}
/** Dispatcher behind appointment workflow buttons (reads modal reason box). */
async function apptAdvance(q, action) {
  const reasonEl = document.getElementById("apptReason-" + q);
  const reason = reasonEl ? reasonEl.value.trim() : "";
  if ((action === "reject" || action === "cancel") && !reason) {
    if (!confirm(`${action === "reject" ? "Reject" : "Cancel"} booking ${q} without a reason? The student will be notified.`)) return;
  }
  return queueStatus(q, action, reason || undefined);
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
      ${!terminal && needsReason ? `<div class="app-field"><label>Reason (sent to the student on reject / cancel)</label><input id="apptReason-${esc(a.q)}" class="glass-input" placeholder="e.g. Slot moved for a campus event…"></div>` : ""}
      ${modalActionsHtml(apptAdminActionsHtml(a))}
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

async function queueStatus(qNum, action, reason) {
  if (action === "approve" || action === "reject") {
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
  if (document.getElementById("apptReason-" + qNum)) closeAppModal();
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
  const color = { INFO: "#4ade80", WARN: "#facc15", ERROR: "#f87171" };
  document.getElementById("auditLog").innerHTML =
    [...auditLogs].reverse().map((l) => `<div><span style="color:${color[l.type] || "#fff"};">[${l.type}]</span> ${l.ts} — ${l.msg}</div>`).join("");
}


function buildCalendar() {
  const container = document.getElementById("calendar");
  const year = appointmentCalendarYear, month = appointmentCalendarMonth;
  const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const first = new Date(year, month, 1).getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const calendarMonth = new Date(year, month, 1);
  const atStart = year === appointmentCalendarStart.getFullYear() && month === appointmentCalendarStart.getMonth();
  const maxMonth = new Date(appointmentCalendarStart.getFullYear(), appointmentCalendarStart.getMonth() + 1, 1);
  const atEnd = year === maxMonth.getFullYear() && month === maxMonth.getMonth();
  let html = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;"><button type="button" class="btn-ghost" onclick="changeAppointmentMonth(-1)" ${atStart ? "disabled" : ""} style="width:32px;height:32px;padding:0;border-radius:10px;" aria-label="Previous month"><i class="fa-solid fa-chevron-left"></i></button><div style="text-align:center;font-size:15px;font-weight:900;color:#4a1515;letter-spacing:.01em;">${calendarMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div><button type="button" class="btn-ghost" onclick="changeAppointmentMonth(1)" ${atEnd ? "disabled" : ""} style="width:32px;height:32px;padding:0;border-radius:10px;" aria-label="Next month"><i class="fa-solid fa-chevron-right"></i></button></div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;margin-bottom:4px;">
    ${days.map((d) => `<div style="font-size:10px;font-weight:700;color:rgba(30,5,5,.55);padding:4px 0;">${d}</div>`).join("")}
  </div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;gap:2px;">`;
  for (let i = 0; i < first; i++) html += "<div></div>";
  for (let d = 1; d <= total; d++) {
    const date = new Date(year, month, d), avail = date >= today && date.getDay() !== 0 && date.getDay() !== 6, past = !avail, isSel = selectedDate === d;
    if (past) html += `<div class="cal-day-past">${d}</div>`;
    else if (avail) html += `<div onclick="selectDate(${d})" class="cal-day-avail${isSel ? " selected" : ""}">${d}<span class="gold-dot" style="${isSel ? "background:#fff;" : ""}"></span></div>`;
    else html += `<div class="cal-day-na">${d}</div>`;
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
  document.getElementById("selectedDateLabel").textContent = "Select a date to view available business-hours time slots.";
  document.getElementById("timeSlots").innerHTML = "";
  document.getElementById("confirmCard").style.display = "none";
  buildCalendar();
}
function apptServiceLabel(key) { return APPT_SERVICE_LABELS[key] || key; }
function buildServiceChips() {
  const box = document.getElementById("apptServiceChips");
  if (!box) return;
  if (presetAppointmentService) {
    const pre = presetAppointmentService === "ID_NEW" || presetAppointmentService === "ID_LOST" ? "ID" : presetAppointmentService;
    if (APPT_SERVICES.some((s) => s.key === pre)) { appointmentService = pre; }
    presetAppointmentService = null;
  }
  if (!APPT_SERVICES.some((s) => s.key === appointmentService)) { appointmentService = ""; }
  box.innerHTML = `
    <div style="display:grid;gap:10px;">
      <div><span class="input-label">Service <span style="color:#f87171;">*</span></span>
        <select id="apptService" class="glass-input" onchange="setAppointmentService(this.value)">
          <option value=""${appointmentService ? "" : " selected"}>Choose a service…</option>
          ${APPT_SERVICES.map((s) => `<option value="${s.key}"${appointmentService === s.key ? " selected" : ""}>${s.label}</option>`).join("")}
        </select></div>
    </div>`;
  renderBookingServiceUI();
}
function bookingServiceDef() { return APPT_SERVICES.find((s) => s.key === appointmentService) || null; }
/**
 * Show only what the selected service needs: date + time slots for
 * appointment-based services, an inline request form for request-based ones.
 * Everything stays hidden until a service is chosen.
 */
function renderBookingServiceUI() {
  const def = bookingServiceDef();
  const wrap = document.getElementById("bookScheduleWrap");
  const formBox = document.getElementById("apptRequestForm");
  const notesBox = document.getElementById("apptNotes");
  selectedDate = null; selectedSlot = null;
  appointmentAvailability = { bookedTimes: [], myAppointment: null, slots: [] };
  apptNotesText = "";
  if (notesBox) notesBox.value = "";
  if (!def) {
    if (wrap) wrap.style.display = "none";
    if (formBox) { formBox.style.display = "none"; formBox.innerHTML = ""; }
    return;
  }
  if (def.schedule) {
    if (formBox) { formBox.style.display = "none"; formBox.innerHTML = ""; }
    if (wrap) wrap.style.display = "";
    buildCalendar();
    const label = document.getElementById("selectedDateLabel");
    if (label) label.textContent = "Select a date to view available business-hours time slots.";
    document.getElementById("timeSlots").innerHTML = "";
    document.getElementById("confirmCard").style.display = "none";
    return;
  }
  if (wrap) wrap.style.display = "none";
  if (formBox) {
    formBox.style.display = "";
    formBox.innerHTML = appointmentService === "ID" ? bookIdFormHtml() : bookReqFormHtml(appointmentService);
    if (appointmentService === "ID") toggleBidAffidavit();
  }
}
// ── Inline request forms on the booking page (flow spec §2) ──
function bookReqFormHtml(svc) {
  const label = apptServiceLabel(svc);
  return `<div style="border-top:1px solid rgba(139,26,26,.10);padding-top:12px;display:grid;gap:10px;">
    <div style="font-size:12px;color:rgba(30,5,5,.65);"><b>${esc(label)}</b> is filed as a request — no visit to book. The SSO schedules your pickup when it's ready.</div>
    <div><span class="input-label">Subject / Document <span style="color:#f87171;">*</span></span>
      <input id="breqSubject" class="glass-input" placeholder="e.g. TOR authentication, 2 copies"></div>
    <div><span class="input-label">Reason / Details <span style="color:#f87171;">*</span></span>
      <textarea id="breqDetails" class="glass-input" rows="3" placeholder="Provide the details of your request…"></textarea></div>
    <div><span class="input-label">Copies needed</span>
      <input id="breqCopies" class="glass-input" type="number" min="1" max="10" value="1"></div>
    <div><button onclick="bookReqSubmit('${svc}')" class="btn-gold" style="padding:11px 18px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Request</button></div>
  </div>`;
}
async function bookReqSubmit(svc) {
  const service = svc === "AUTH" ? "AUTHENTICATION" : "EXCUSE_SLIP";
  const subject = document.getElementById("breqSubject").value.trim();
  const details = document.getElementById("breqDetails").value.trim();
  const copies = Math.max(1, Math.min(10, Number(document.getElementById("breqCopies")?.value) || 1));
  if (!details) { showToast("⚠️ Please provide the reason/details.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/requests", { method: "POST", body: { service, subject, details, copies } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Request submitted — the SSO will notify you.");
  goTo("page-appointment");
}
function bookIdFormHtml() {
  return `<div style="border-top:1px solid rgba(139,26,26,.10);padding-top:12px;display:grid;gap:10px;">
    <div style="font-size:12px;color:rgba(30,5,5,.65);"><b>ID Application</b> is filed as a request — no visit to book. The SSO schedules your ID pickup when it's ready.</div>
    <div><span class="input-label">Application Type</span>
      <select id="bidType" class="glass-input" onchange="toggleBidAffidavit()"><option>New ID</option><option>ID Replacement — Lost</option><option>ID Replacement — Damaged</option></select></div>
    <div><span class="input-label">Reason / Details</span>
      <textarea id="bidReason" class="glass-input" rows="3" placeholder="e.g., Lost my ID on campus last week…"></textarea></div>
    <div id="bidAffidavitField" style="display:none;"><span class="input-label">Affidavit of Loss — required for a lost ID</span>
      <input id="bidAffidavit" type="file" accept=".jpg,.jpeg,.png,.pdf" class="glass-input" style="padding:9px;">
      <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Upload the signed Affidavit of Loss (JPG, PNG, or PDF, max 1.5 MB).</div></div>
    <div><button onclick="bookIdSubmit()" class="btn-gold" style="padding:11px 18px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Application</button></div>
  </div>`;
}
function toggleBidAffidavit() {
  const typeEl = document.getElementById("bidType");
  if (!typeEl) return;
  const isLost = typeEl.value === "ID Replacement — Lost";
  const aff = document.getElementById("bidAffidavitField");
  if (aff) aff.style.display = isLost ? "block" : "none";
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
 * which renders date + slots or the inline request form depending on service. */
function bookFor(service) {
  presetAppointmentService = service;
  goTo("page-appointment-book");
}
const APPT_CLOSED_RE = /^(rejected|cancelled|disapproved|closed|resolved|completed|claimed|no.?show)$/i;
function apptBookBtn(service, status) {
  if (!service || APPT_CLOSED_RE.test(status || "")) return "";
  return `<button onclick="bookFor('${service}')" class="btn-gold" style="padding:6px 12px;font-size:11px;border-radius:10px;"><i class="fa-solid fa-calendar-plus" style="margin-right:5px;"></i>Book</button>`;
}
async function setAppointmentService(svc) {
  appointmentService = svc;
  apptNotesText = "";
  buildServiceChips();
}
async function selectDate(d) {
  selectedDate = d; selectedSlot = null;
  document.getElementById("selectedDateLabel").textContent = `June ${d}, 2026 — loading availability…`;
  document.getElementById("confirmCard").style.display = "none";
  buildCalendar();
  const { ok, data } = await api(`/api/queue?date=${encodeURIComponent(appointmentDateLabel(d))}&service=${encodeURIComponent(appointmentService)}`);
  appointmentAvailability = ok ? data : { bookedTimes: [], myAppointment: null, slots: [] };
  document.getElementById("selectedDateLabel").textContent = appointmentAvailability.myAppointment
    ? appointmentAvailability.myAppointment.status === "PENDING_APPROVAL"
      ? `Awaiting SSO approval — ${appointmentAvailability.myAppointment.code} at ${appointmentAvailability.myAppointment.time} on this date.`
      : `You already booked ${appointmentAvailability.myAppointment.code} at ${appointmentAvailability.myAppointment.time} on this date.`
    : `June ${d}, 2026 — select an available business-hours time slot:`;
  buildSlots();
  if (!appointmentAvailability.myAppointment) document.getElementById("selectedDateLabel").textContent = `${appointmentDateLabel(d)} — ${apptServiceLabel(appointmentService)} · select an available time slot:`;
  if (appointmentAvailability.holiday) document.getElementById("selectedDateLabel").textContent = `SSO closed — ${appointmentAvailability.holiday.name || appointmentAvailability.holiday.date}.`;
}
function buildSlots() {
  const fallbackTimes = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];
  const slots = (appointmentAvailability.slots && appointmentAvailability.slots.length)
    ? appointmentAvailability.slots
    : fallbackTimes.map((t) => ({ time: t, remaining: (appointmentAvailability.bookedTimes || []).includes(t) ? 0 : 1, blocked: false }));
  const hasOwnBooking = !!appointmentAvailability.myAppointment;
  document.getElementById("timeSlots").innerHTML = slots.map((s) => {
    const full = s.remaining <= 0, isSel = selectedSlot === s.time;
    const sub = s.blocked ? (s.blockedReason || "Closed") : full ? "Full" : s.remaining > 1 ? `${s.remaining} left` : "1 left";
    return `<button ${full || hasOwnBooking ? "disabled" : ""} onclick="${full || hasOwnBooking ? "" : "selectSlot('" + s.time + "')"}" class="slot-btn${isSel ? " selected" : ""}">${full ? `<s>${s.time}</s>` : s.time} <small>${hasOwnBooking ? "Booked" : sub}</small></button>`;
  }).join("");
}
async function selectSlot(t) {
  selectedSlot = t; buildSlots();
  document.getElementById("confirmCard").style.display = "block";
  document.getElementById("apptDateLabel").textContent = `June ${selectedDate}, 2026 · ${t}`;
  const { ok, data } = await api("/api/queue?count=1");
  document.getElementById("queueNum").textContent = String((ok ? data.count : 0) + 1).padStart(3, "0");
  document.getElementById("apptDateLabel").textContent = `${appointmentDateLabel(selectedDate)} · ${t}`;
}
async function bookAppointment() {
  if (!selectedDate || !selectedSlot) return;
  if (APPT_REQUEST_ONLY[appointmentService]) { showToast("⚠️ This service is filed as a request — it can't be booked here.", "rgba(180,130,0,.85)"); renderBookingServiceUI(); return; }
  const dateLabel = appointmentDateLabel(selectedDate);
  if (!confirm(`Confirm booking — ${apptServiceLabel(appointmentService)} on ${dateLabel} at ${selectedSlot}?\nThe SSO will review it and notify you once approved.`)) return;
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
  const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const first = new Date(year, month, 1).getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let html = `<div style="text-align:center;margin-bottom:12px;font-size:13px;font-weight:800;color:#2a1010;">${new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;margin-bottom:4px;">
    ${days.map((d) => `<div style="font-size:10px;font-weight:700;color:rgba(30,5,5,.55);padding:4px 0;">${d}</div>`).join("")}
  </div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;gap:2px;">`;
  for (let i = 0; i < first; i++) html += "<div></div>";
  for (let d = 1; d <= total; d++) {
    const date = new Date(year, month, d), avail = date >= today && date.getDay() !== 0 && date.getDay() !== 6, past = !avail, isSel = rescheduleSelectedDate === d;
    if (past) html += `<div class="cal-day-past">${d}</div>`;
    else if (avail) html += `<div onclick="selectRescheduleDate(${d})" class="cal-day-avail${isSel ? " selected" : ""}">${d}<span class="gold-dot" style="${isSel ? "background:#fff;" : ""}"></span></div>`;
    else html += `<div class="cal-day-na">${d}</div>`;
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
  if (label) label.textContent = `${rescheduleDateLabel(d)} — select an available business-hours time slot:`;
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
    const sub = isOwnSlot ? "(current)" : s.blocked ? (s.blockedReason || "Closed") : s.remaining <= 0 ? "Booked" : s.remaining > 1 ? `${s.remaining} left` : "1 left";
    return `<button ${isTaken ? "disabled" : ""} onclick="${isTaken ? "" : "selectRescheduleSlot('" + s.time + "')"}" class="slot-btn${isSel ? " selected" : ""}">${isTaken ? `<s>${s.time}</s>` : s.time} <small>${sub}</small></button>`;
  }).join("");
}
function selectRescheduleSlot(t) {
  rescheduleSelectedSlot = t;
  buildRescheduleSlots();
}


function togglePass(id, btn) { const el = document.getElementById(id); el.type = el.type === "password" ? "text" : "password"; btn.querySelector("i").className = el.type === "password" ? "fa-solid fa-eye" : "fa-solid fa-eye-slash"; }
function validateStudNum(el) { const valid = /^\d{4}-\d{5}-SP-\d$/.test(el.value); const h = document.getElementById("studNumHelper"); if (el.value.length > 3) { el.style.borderColor = valid ? "rgba(34,197,94,.5)" : "rgba(239,68,68,.5)"; h.innerHTML = valid ? '<i class="fa-solid fa-circle-check" style="color:#4ade80;margin-right:3px;"></i><span style="color:#4ade80;">Valid format</span>' : '<i class="fa-solid fa-triangle-exclamation" style="color:#f87171;margin-right:3px;"></i><span style="color:#f87171;">Format: 2024-00000-SP-0</span>'; } }
function checkStrength(val) { const bars = [1, 2, 3, 4].map((i) => document.getElementById("s" + i)); const label = document.getElementById("strengthLabel"); let score = 0; if (val.length >= 8) score++; if (/[A-Z]/.test(val)) score++; if (/[0-9]/.test(val)) score++; if (/[^A-Za-z0-9]/.test(val)) score++; const colors = ["rgba(239,68,68,.8)", "rgba(249,115,22,.8)", "rgba(245,197,24,.8)", "rgba(34,197,94,.8)"]; const labels = ["Weak", "Fair", "Good", "Strong"]; bars.forEach((b, i) => (b.style.background = i < score ? colors[score - 1] : "rgba(139,26,26,.1)")); label.textContent = val.length ? labels[score - 1] || "Weak" : "Password strength"; label.style.color = val.length ? colors[score - 1] : "rgba(30,5,5,.55)"; }
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

function showToast(msg, bg) { const t = document.createElement("div"); t.className = "toast"; t.style.background = bg || "rgba(139,26,26,.85)"; t.style.pointerEvents = "auto"; t.innerHTML = msg; document.getElementById("toastContainer").appendChild(t); setTimeout(() => { t.style.transition = ".3s"; t.style.opacity = "0"; t.style.transform = "translateY(8px)"; setTimeout(() => t.remove(), 300); }, 3200); }


const APP_VERSION = "3.2.1-nextjs";

function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fnow() { return new Date().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }); }
function isAdmin() { return session && (session.role === "admin" || session.role === "super_admin"); }
function isSuperAdmin() { return session && session.role === "super_admin"; }
function pill(status) {
  const s = (status || "").toLowerCase();
  let bg = "rgba(180,130,0,.14)", fg = "#a16207", bd = "rgba(180,130,0,.3)";
  if (/(approved|completed|resolved|published|answered|ready|verified|claimed|sent)/.test(s)) { bg = "rgba(22,163,74,.12)"; fg = "#15803d"; bd = "rgba(22,163,74,.3)"; }
  else if (/(review|investigation|ongoing|processing|open)/.test(s)) { bg = "rgba(37,99,235,.10)"; fg = "#1d4ed8"; bd = "rgba(37,99,235,.3)"; }
  else if (/(rejected|dismissed|failed)/.test(s)) { bg = "rgba(220,38,38,.10)"; fg = "#b91c1c"; bd = "rgba(220,38,38,.3)"; }
  else if (/(closed|archived)/.test(s)) { bg = "rgba(107,114,128,.12)"; fg = "#4b5563"; bd = "rgba(107,114,128,.3)"; }
  else if (/revision/.test(s)) { bg = "rgba(234,88,12,.12)"; fg = "#c2410c"; bd = "rgba(234,88,12,.3)"; }
  return `<span style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:99px;background:${bg};color:${fg};border:1px solid ${bd};white-space:nowrap;">${esc(status)}</span>`;
}
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
/** Admin step-action buttons for a modal. Replaces the status dropdown. */
function wfAdminActionsHtml(kind, id, item) {
  const m = wfMeta(kind);
  const cur = (item || {}).status || "";
  const safeId = esc(id);
  if (wfIsTerminal(kind, cur)) {
    const reopen = kind === "complaint" ? `<button class="btn-ghost" onclick="wfAdvance('${kind}','${safeId}','Under Investigation')">Reopen investigation</button>` : "";
    return `${reopen}`;
  }
  const next = wfNext(kind, item);
  const primary = next
    ? `<button class="btn-maroon" onclick="wfAdvance('${kind}','${safeId}','${esc(next)}')">Advance to ${esc(next)}</button>`
    : "";
  const revise = (m.revise && cur !== m.revise)
    ? `<button class="btn-gold" onclick="wfAdvance('${kind}','${safeId}','${esc(m.revise)}')">Request revision</button>`
    : "";
  const terminals = m.bad
    .filter((t) => t !== cur)
    .map((t) => {
      const label = t === "No Show" ? "Mark no-show" : t === "Dismissed" ? "Dismiss complaint" : t;
      return `<button class="btn-ghost" onclick="wfAdvance('${kind}','${safeId}','${esc(t)}')">${esc(label)}</button>`;
    }).join("");
  return `${primary}${revise}${terminals}`;
}
/** Dispatcher behind every workflow button (confirms destructive closes). */
async function wfAdvance(kind, id, target) {
  const m = wfMeta(kind);
  if (m.bad.includes(target) && !confirm(`Set this ${m.label} to "${target}"? The student will be notified.`)) return;
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
  { title: "Appointments", items: [
    { label: "Book Appointment", icon: "fa-calendar-plus", page: "page-appointment-book" },
    { label: "My Appointments", icon: "fa-calendar", page: "page-appointment" },
  ]},
  { title: "Support", items: [
    { label: "Ask for Help", icon: "fa-headset", page: "page-helpdesk" },
    { label: "My Tickets", icon: "fa-ticket", page: "page-tickets" },
    { label: "Complaints", icon: "fa-shield-heart", page: "page-complaint" },
  ]},
  { title: "Resources", items: [
    { label: "Student Bulletin", icon: "fa-bullhorn", page: "page-bulletin" },
    { label: "FAQs", icon: "fa-circle-question", page: "page-faq" },
    { label: "Forms & Downloads", icon: "fa-file-arrow-down", page: "page-forms" },
  ]},
];
// Categorized admin sidebar navigation — single source of truth for the
// desktop sidebar, the mobile menu, and the page-manage directory.
const ADMIN_NAV_SECTIONS = [
  { title: "Requests", items: [
    { label: "All Requests", icon: "fa-inbox", page: "page-requests" },
    { label: "Appointments", icon: "fa-calendar-days", page: "page-appointments" },
    { label: "Referrals", icon: "fa-hand-holding-heart", page: "page-referral" },
  ]},
  { title: "Support", items: [
    { label: "Help Desk", icon: "fa-headset", page: "page-helpdesk" },
    { label: "Complaints", icon: "fa-shield-heart", page: "page-complaint" },
  ]},
  { title: "Content", items: [
    { label: "Bulletins", icon: "fa-bullhorn", page: "page-bulletin" },
    { label: "FAQs", icon: "fa-circle-question", page: "page-faq" },
    { label: "Forms", icon: "fa-file-arrow-down", page: "page-forms" },
  ]},
  { title: "Settings", items: [
    { label: "Masterlist Manager", icon: "fa-users-rectangle", page: "page-masterlist", superOnly: true },
    { label: "Accounts & Access", icon: "fa-users-gear", page: "page-accounts", superOnly: true },
    { label: "Email Blast", icon: "fa-envelopes-bulk", page: "page-memo", superOnly: true },
    { label: "Insights & System", icon: "fa-chart-column", page: "page-system", superOnly: true },
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
      const active = it.page && it.page === pageId ? " active" : "";
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

function downloadBackup() {
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Backup is restricted to Super Admin.", "rgba(139,26,26,.9)"); return; }
  if (!confirm("Download a database backup file? Keep it in a secure location.")) return;
  window.open("/api/backup", "_blank");
}

function closeAppModal() { document.getElementById("appModal")?.remove(); }
function openAppModal({ title, subtitle = "", icon = "fa-circle-info", content = "", wide = false }) {
  closeAppModal();
  const modal = document.createElement("div");
  modal.id = "appModal"; modal.className = "modal-overlay open app-modal";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  modal.innerHTML = `<div class="modal-box" style="max-width:${wide ? "880px" : "680px"};"><div class="app-modal-head"><div><div class="app-modal-title"><i class="fa-solid ${icon}"></i><span>${esc(title)}</span></div>${subtitle ? `<p class="app-modal-subtitle">${esc(subtitle)}</p>` : ""}</div><button class="app-modal-close" onclick="closeAppModal()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="app-modal-body">${content}</div></div>`;
  modal.addEventListener("click", (event) => { if (event.target === modal) closeAppModal(); });
  document.body.appendChild(modal);
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
  const html = `<!doctype html><html><head><title>STARS Analytics Report</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#1a0505}h1{color:#8B1A1A}h2{margin-top:24px;font-size:16px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:8px;text-align:left}th{background:#8B1A1A;color:#fff}.foot{font-size:10px;color:#666;margin-top:24px}@media print{body{padding:0}.noprint{display:none}}</style></head><body><h1>STARS Analytics Report</h1><p>PUP San Pedro Student Services Office</p>${section("Students by Course",data.byCourse)}${section("Students by Year Level",data.byYear)}${section("Appointments by Service",data.services)}${section("Peak Appointment Times",data.peakTimes)}<div class="foot">Generated ${esc(fnow())} · STARS</div><div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div><script>setTimeout(()=>window.print(),300);<\/script></body></html>`;
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

function adminSearchBox(id, varName, renderFn, placeholder, currentVal) {
  return `<div style="position:relative;margin-bottom:12px;">
    <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:rgba(30,5,5,.4);font-size:12px;"></i>
    <input id="${id}" class="glass-input" style="padding-left:34px;" placeholder="${placeholder}" value="${esc(currentVal)}"
      oninput="${varName}=this.value;${renderFn}();(function(){var e=document.getElementById('${id}');if(e){e.focus();e.setSelectionRange(e.value.length,e.value.length);}})();">
  </div>`;
}
function emptyState(msg) { return `<div class="glass-card" style="padding:26px;text-align:center;color:rgba(30,5,5,.5);font-size:12px;"><i class="fa-solid fa-inbox" style="font-size:20px;display:block;margin-bottom:8px;color:rgba(139,26,26,.35);"></i>${esc(msg)}</div>`; }

// ── Shared admin table container + manage-modal pattern ──
// Every admin request list renders inside adminTableShell: titled card,
// count badge, filters, table, pagination. Row actions live in a Manage modal.
function adminTableShell({ icon, title, count, filtersHtml, theadHtml, rowsHtml, emptyHtml, paginationHtml }) {
  return `<div class="glass-card" style="padding:0;overflow:hidden;margin-bottom:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px 12px;border-bottom:1px solid rgba(139,26,26,.10);flex-wrap:wrap;">
      <div style="font-size:14px;font-weight:800;color:#1a0505;"><i class="${icon}" style="color:#D4A017;margin-right:8px;"></i>${title}</div>
      <span style="font-size:11px;font-weight:800;color:#8B1A1A;background:rgba(139,26,26,.08);border:1px solid rgba(139,26,26,.15);border-radius:999px;padding:3px 12px;">${count}</span>
    </div>
    ${filtersHtml ? `<div style="padding:14px 18px 0;">${filtersHtml}</div>` : ""}
    <div style="padding:14px 18px 18px;">${rowsHtml
      ? `<div style="overflow-x:auto;"><table class="glass-table" style="min-width:780px;"><thead><tr>${theadHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>${paginationHtml || ""}`
      : emptyHtml}</div>
  </div>`;
}
function manageBtn(id, fnName) {
  return `<button onclick="${fnName}('${esc(id)}')" class="btn-maroon" style="padding:6px 12px;font-size:11px;">Manage</button>`;
}
function historyHtml(history) {
  if (!history || !history.length) return "";
  return `<div style="margin-top:8px;font-size:10px;color:rgba(30,5,5,.5);font-family:monospace;">${history.map((h) => `${esc(h.ts)} — ${esc(h.status)} by ${esc(h.by)}${h.note ? ": " + esc(h.note) : ""}`).join("<br>")}</div>`;
}
function modalActionsHtml(inner) {
  return `<div class="app-modal-actions" style="justify-content:flex-start;flex-wrap:wrap;">${inner}<button class="btn-soft" onclick="closeAppModal()">Close</button></div>`;
}

const MODULE_REQUESTS_PER_PAGE = 5;
const moduleRequestPages = {};
function getModulePage(key, rows) {
  const totalPages = Math.max(1, Math.ceil(rows.length / MODULE_REQUESTS_PER_PAGE));
  const page = Math.min(Math.max(1, moduleRequestPages[key] || 1), totalPages);
  moduleRequestPages[key] = page;
  const start = (page - 1) * MODULE_REQUESTS_PER_PAGE;
  return { page, totalPages, start, items: rows.slice(start, start + MODULE_REQUESTS_PER_PAGE) };
}
function modulePagination(key, rowCount, renderFn) {
  if (!rowCount) return "";
  const { page, totalPages, start } = getModulePage(key, Array.from({ length: rowCount }));
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:10px 2px 16px;font-size:11px;color:rgba(30,5,5,.58);"><span>Showing ${start + 1}-${Math.min(start + MODULE_REQUESTS_PER_PAGE, rowCount)} of ${rowCount}</span><div style="display:flex;align-items:center;gap:8px;"><button class="btn-ghost" ${page === 1 ? "disabled" : ""} onclick="changeModulePage('${key}',${page - 1},'${renderFn}')" style="padding:6px 10px;font-size:11px;">‹ Previous</button><b style="color:#8B1A1A;">${page} / ${totalPages}</b><button class="btn-ghost" ${page === totalPages ? "disabled" : ""} onclick="changeModulePage('${key}',${page + 1},'${renderFn}')" style="padding:6px 10px;font-size:11px;">Next ›</button></div></div>`;
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
      title: "Referrals & Intervention",
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
      ${modalActionsHtml(wfAdminActionsHtml("referral", r.id, r))}
      ${historyHtml(r.history)}
    </div>` });
}


const ID_STATUSES = ["Pending", "OR Verified", "Needs Revision", "Approved", "Processing", "Ready for Claiming", "Claimed", "Completed", "Rejected", "Cancelled"];
let idaEditingId = null;
function renderIdApp() {
  const el = document.getElementById("idappBody");
  if (isAdmin()) {
    const list = [...MOD.idapps].reverse().filter((a) => matchQ(idaAdminQ, [a.name, a.sn, a.id, a.type, a.status]));
    const rows = getModulePage("idapp-admin", list).items.map((a) => `<tr>
        <td><div style="font-weight:700;font-size:12px;color:#1a0505;">${esc(a.type)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(a.id)}</div></td>
        <td><div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(a.name)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(a.sn)}</div></td>
        <td>${pill(a.status)}</td>
        <td style="font-size:11px;white-space:nowrap;">${a.pickupDate ? `${esc(a.pickupDate)} ${esc(a.pickupTime)}` : "—"}</td>
        <td style="font-size:11px;white-space:nowrap;">${esc(a.ts)}</td>
        <td style="text-align:right;">${manageBtn(a.id, "openIdAppModal")}</td>
      </tr>`).join("");
    el.innerHTML = adminTableShell({
      icon: "fa-solid fa-id-card",
      title: "ID Applications",
      count: `${list.length} total`,
      filtersHtml: adminSearchBox("idaAdminQBox", "idaAdminQ", "renderIdApp", "Search by name or student ID…", idaAdminQ),
      theadHtml: "<th>Application</th><th>Student</th><th>Status</th><th>Pickup</th><th>Filed</th><th style=\"text-align:right;\">Action</th>",
      rowsHtml: rows,
      emptyHtml: emptyState(idaAdminQ ? "No applications match your search." : "No ID applications yet."),
      paginationHtml: modulePagination("idapp-admin", list.length, "renderIdApp"),
    });
  } else {
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
            <input id="idAffidavit" type="file" accept=".jpg,.jpeg,.png,.pdf" class="glass-input" style="padding:9px;">
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
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
            ${a.status === "Needs Revision" ? `<button onclick="idaEditingId='${esc(a.id)}';renderIdApp();window.scrollTo(0,0);" class="btn-maroon" style="padding:6px 10px;font-size:11px;">Revise</button>` : ""}
          </div>
        </div>`).join("") : emptyState("No applications yet.")}
      ${modulePagination("idapp-student", mine.length, "renderIdApp")}
    `;
    enableRequestDropdowns(el);
    toggleAffidavitField();
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
      ${modalActionsHtml(wfAdminActionsHtml("idapp", a.id, a)
        + (canSchedule ? `<button class="btn-gold" onclick="closeAppModal();openPickupModal('idapps','${esc(a.id)}')">Schedule pickup</button>` : "")
        + (canComplete ? `<button class="btn-maroon" onclick="completePickup('idapps','${esc(a.id)}')">Mark claimed</button>` : ""))}
      ${historyHtml(a.history)}
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
  if (reqTitle) reqTitle.textContent = isAdmin() ? "All Requests" : "Authentication, Excuse Slip & Visits";
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
    const pageItems = getModulePage("req-admin", combined).items;
    const grouped = pageItems.some((i) => i.kind === "req") && pageItems.some((i) => i.kind === "ida");
    let lastKind = null;
    const rows = pageItems.map((it) => {
      let head = "";
      if (grouped && it.kind !== lastKind) {
        lastKind = it.kind;
        head = `<tr><td colspan="6" style="font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:rgba(139,26,26,.6);padding:10px 4px 2px;background:transparent;border:none;">${it.kind === "req" ? "Service Requests" : "ID Applications"}</td></tr>`;
      }
      if (it.kind === "ida") {
        const a = it.item;
        const sub = a.pickupDate ? `Pickup: ${a.pickupDate} ${a.pickupTime}` : "—";
        return `${head}<tr>
          <td><div style="font-weight:700;font-size:12px;color:#1a0505;">${esc(a.type)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(a.id)} · ID Application</div></td>
          <td><div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(a.name)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(a.sn)}</div></td>
          <td>${pill(a.status)}</td>
          <td style="font-size:11px;white-space:nowrap;">${esc(sub)}</td>
          <td style="font-size:11px;white-space:nowrap;">${esc(a.ts)}</td>
          <td style="text-align:right;">${manageBtn(a.id, "openIdAppModal")}</td>
        </tr>`;
      }
      const r = it.item;
      const sub = r.pickupDate ? `Pickup: ${r.pickupDate} ${r.pickupTime}` : r.appointmentCode ? `Visit: ${r.appointmentCode}` : "—";
      return `${head}<tr>
        <td><div style="font-weight:700;font-size:12px;color:#1a0505;">${esc(r.subject || reqServiceLabel(r.service))}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(r.id)} · ${esc(reqServiceLabel(r.service))}</div></td>
        <td><div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(r.name)}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(r.sn)}</div></td>
        <td>${pill(r.status)}</td>
        <td style="font-size:11px;white-space:nowrap;">${esc(sub)}</td>
        <td style="font-size:11px;white-space:nowrap;">${esc(r.ts)}</td>
        <td style="text-align:right;"><button onclick="openRequestModal('${esc(r.id)}')" class="btn-maroon" style="padding:6px 12px;font-size:11px;">Manage</button></td>
      </tr>`;
    }).join("");
    const idaTypeOpts = [...new Set(["New ID", "ID Replacement — Lost", "ID Replacement — Damaged", ...((MOD.idapps || []).map((a) => a.type).filter(Boolean))])];
    el.innerHTML = adminTableShell({
      icon: "fa-solid fa-inbox",
      title: "All Requests",
      count: `${combined.length} total`,
      filtersHtml: adminSearchBox("reqAdminQBox", "reqAdminQ", "renderServiceRequests", "Search by name, student ID, or request ID…", q)
        + `<div style="margin-bottom:12px;"><select id="reqAdminSvc" class="glass-input" style="max-width:280px;padding:8px;font-size:12px;" onchange="renderServiceRequests()"><option value="">All types</option><optgroup label="Service Requests">${REQ_SERVICES.map((s) => `<option value="${s.key}"${svcF === s.key ? " selected" : ""}>${s.label}</option>`).join("")}</optgroup><optgroup label="ID Applications">${idaTypeOpts.map((t) => `<option value="ida:${esc(t)}"${svcF === "ida:" + t ? " selected" : ""}>${esc(t)}</option>`).join("")}</optgroup></select></div>`,
      theadHtml: "<th>Request</th><th>Student</th><th>Status</th><th>Pickup / Visit</th><th>Filed</th><th style=\"text-align:right;\">Action</th>",
      rowsHtml: rows,
      emptyHtml: emptyState(q || svcF ? "No requests match your filters." : "No requests yet."),
      paginationHtml: modulePagination("req-admin", combined.length, "renderServiceRequests"),
    });
  } else {
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
            <input id="reqCopies" class="glass-input" type="number" min="1" max="10" value="${editing ? editing.copies : 1}"></div>` : ""}
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
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
            ${r.status === "Needs Revision" ? `<button onclick="reqEditingId='${esc(r.id)}';renderServiceRequests();window.scrollTo(0,0);" class="btn-maroon" style="padding:6px 10px;font-size:11px;">Revise</button>` : ""}
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
  const copies = Math.max(1, Math.min(10, Number(document.getElementById("reqCopies")?.value) || 1));
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
      <div class="app-modal-actions" style="justify-content:flex-start;flex-wrap:wrap;">
        ${wfAdminActionsHtml("request", r.id, r)}
        ${canSchedule ? `<button class="btn-gold" onclick="closeAppModal();openPickupModal('requests','${esc(r.id)}')">Schedule pickup</button>` : ""}
        ${canComplete ? `<button class="btn-maroon" onclick="completePickup('requests','${esc(r.id)}')">Mark picked up</button>` : ""}
        <button class="btn-soft" onclick="closeAppModal()">Close</button>
      </div>
      ${r.history && r.history.length ? `<div style="font-size:10px;color:rgba(30,5,5,.55);font-family:monospace;">${r.history.map((h) => `${esc(h.ts)} — ${esc(h.status)} by ${esc(h.by)}${h.note ? ": " + esc(h.note) : ""}`).join("<br>")}</div>` : ""}
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
async function completePickup(kind, id) {
  if (!confirm("Mark this as picked up / completed?")) return;
  const { ok, error } = await api(pickupApi(kind, id), { method: "POST", body: { action: "complete" } });
  if (!ok) { showToast(`❌ ${error || "Could not complete."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Marked as picked up.");
  closeAppModal();
  await refreshAfterModuleChange(kind);
}


let bulletinEditingId = null;
function renderBulletin() {
  const el = document.getElementById("bulletinBody");
  const now = Date.now();
  const visible = MOD.bulletins.filter((b) => b.status === "Published" && (!b.publishAt || b.publishAt <= now));
  const featured = visible.filter((b) => b.featured);
  const normal = visible.filter((b) => !b.featured);
  const postCard = (b) => `
    <div class="glass-card" style="padding:16px;margin-bottom:10px;${b.featured ? "border:1px solid rgba(245,197,24,.5);" : ""}">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
        <div style="font-size:14px;font-weight:800;color:#1a0505;">${b.featured ? '<i class="fa-solid fa-star" style="color:#C9A227;margin-right:6px;"></i>' : ""}${esc(b.title)}</div>
        ${pill(b.category)}
      </div>
      <div style="font-size:10px;color:rgba(30,5,5,.5);margin:4px 0 8px;">${esc(b.ts)}${b.updatedTs ? " · edited " + esc(b.updatedTs) : ""}</div>
      <div style="font-size:12px;color:rgba(30,5,5,.85);white-space:pre-wrap;">${esc(b.body)}</div>
    </div>`;
  let adminPanel = "";
  if (isAdmin()) {
    adminPanel = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-pen-nib" style="color:#8B1A1A;margin-right:6px;"></i><span id="bulFormTitle">${bulletinEditingId ? "Edit Post" : "Publish New Post"}</span></div>
        <div style="display:grid;gap:10px;">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
            <div><span class="input-label">Title</span><input id="bulTitle" class="glass-input" placeholder="Post title"></div>
            <div><span class="input-label">Category</span><select id="bulCat" class="glass-input"><option>Announcement</option><option>Advisory</option><option>Org Event</option><option>Reminder</option></select></div>
          </div>
          <div><span class="input-label">Content</span><textarea id="bulBody" class="glass-input" rows="4" placeholder="Write the announcement…"></textarea></div>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <label style="font-size:12px;color:#1a0505;display:flex;align-items:center;gap:6px;"><input id="bulFeat" type="checkbox"> Featured</label>
            <div style="display:flex;align-items:center;gap:6px;"><span style="font-size:12px;color:#1a0505;">Schedule:</span><input id="bulSched" type="datetime-local" class="glass-input" style="padding:7px;font-size:12px;max-width:210px;"></div>
          </div>
          <div style="display:flex;gap:8px;">
            <button onclick="bulSave()" class="btn-gold" style="padding:10px 18px;">${bulletinEditingId ? "Save Changes" : "Publish"}</button>
            ${bulletinEditingId ? '<button onclick="bulCancelEdit()" class="btn-ghost" style="padding:10px 14px;">Cancel</button>' : ""}
          </div>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin:14px 0 8px;">All Posts (manage)</div>
      ${MOD.bulletins.length ? [...MOD.bulletins].reverse().map((b) => `
        <div class="glass-card" style="padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;">
          <div style="min-width:200px;flex:1;">
            <div style="font-size:12px;font-weight:800;color:#1a0505;">${b.featured ? "⭐ " : ""}${esc(b.title)}</div>
            <div style="font-size:10px;color:rgba(30,5,5,.5);">${esc(b.category)} · ${esc(b.ts)}${b.publishAt && b.publishAt > now ? " · scheduled " + new Date(b.publishAt).toLocaleString() : ""}</div>
          </div>
          ${pill(b.status)}
          <div style="display:flex;gap:6px;">
            <button onclick="bulEdit('${b.id}')" class="btn-ghost" style="padding:7px 10px;font-size:11px;">Edit</button>
            <button onclick="bulToggleArchive('${b.id}')" class="btn-ghost" style="padding:7px 10px;font-size:11px;">${b.status === "Archived" ? "Unarchive" : "Archive"}</button>
            <button onclick="bulDelete('${b.id}')" class="btn-ghost" style="padding:7px 10px;font-size:11px;color:#b91c1c;">Delete</button>
          </div>
        </div>`).join("") : emptyState("No posts yet.")}
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin:18px 0 8px;">Live Preview (what students see)</div>`;
  }
  el.innerHTML = adminPanel
    + (featured.length ? `<div style="font-size:12px;font-weight:800;color:#C9A227;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Featured</div>${featured.map(postCard).join("")}` : "")
    + (normal.length ? normal.map(postCard).join("") : (featured.length ? "" : emptyState("No announcements right now. Check back soon!")));
}
async function bulSave() {
  const t = document.getElementById("bulTitle").value.trim();
  const c = document.getElementById("bulCat").value;
  const b = document.getElementById("bulBody").value.trim();
  const f = document.getElementById("bulFeat").checked;
  const s = document.getElementById("bulSched").value;
  if (!t || !b) { showToast("⚠️ Title and content are required.", "rgba(180,130,0,.85)"); return; }
  const publishAt = s ? new Date(s).toISOString() : null;
  let res;
  if (bulletinEditingId) {
    res = await api(`/api/modules/bulletins/${encodeURIComponent(bulletinEditingId)}`, { method: "PATCH", body: { title: t, category: c, body: b, featured: f, publishAt } });
    bulletinEditingId = null;
  } else {
    res = await api("/api/modules/bulletins", { method: "POST", body: { title: t, category: c, body: b, featured: f, publishAt } });
  }
  if (!res.ok) { showToast(`❌ ${res.error || "Could not save."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Saved.");
  await loadModule("bulletins"); renderBulletin();
}
function bulEdit(id) {
  const p = MOD.bulletins.find((x) => x.id === id); if (!p) return;
  bulletinEditingId = id; renderBulletin();
  document.getElementById("bulTitle").value = p.title;
  document.getElementById("bulCat").value = p.category;
  document.getElementById("bulBody").value = p.body;
  document.getElementById("bulFeat").checked = !!p.featured;
  if (p.publishAt) document.getElementById("bulSched").value = new Date(p.publishAt).toISOString().slice(0, 16);
  window.scrollTo(0, 0);
}
function bulCancelEdit() { bulletinEditingId = null; renderBulletin(); }
async function bulToggleArchive(id) {
  const { ok, error } = await api(`/api/modules/bulletins/${encodeURIComponent(id)}/archive`, { method: "POST" });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("bulletins"); renderBulletin();
}
async function bulDelete(id) {
  const p = MOD.bulletins.find((x) => x.id === id); if (!p) return;
  if (!confirm("Delete this post permanently?")) return;
  const { ok, error } = await api(`/api/modules/bulletins/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { showToast(`❌ ${error || "Could not delete."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("bulletins"); renderBulletin();
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
// Lifecycle timeline derived from status + msgs (no new data): Opened →
// Answered (any admin reply) → Closed. Shared by student cards + admin modal.
function ticketTimeline(t) {
  const msgs = t.msgs || [];
  const adminMsgs = msgs.filter((m) => m.from === "admin");
  const lastAdmin = adminMsgs[adminMsgs.length - 1];
  const last = msgs[msgs.length - 1];
  const closed = t.status === "Closed";
  const answered = t.status === "Answered" || adminMsgs.length > 0;
  const step = (done, active, icon, label, sub) => `<div style="display:flex;gap:8px;align-items:flex-start;flex:1;min-width:120px;"><div style="width:22px;height:22px;border-radius:50%;display:grid;place-items:center;flex:none;background:${active ? "#8B1A1A" : done ? "rgba(22,163,74,.15)" : "rgba(30,5,5,.08)"};color:${active ? "#F5C518" : done ? "#15803d" : "rgba(30,5,5,.4)"};font-size:10px;"><i class="fa-solid ${icon}"></i></div><div><div style="font-size:11px;font-weight:800;color:#1a0505;">${label}</div>${sub ? `<div style="font-size:10px;color:rgba(30,5,5,.55);">${esc(sub)}</div>` : ""}</div></div>`;
  // Only reached steps are shown — future states stay hidden until they happen.
  const steps = [step(true, !answered && !closed, "fa-circle-dot", "Opened", (msgs[0] && msgs[0].ts) || t.ts || "")];
  if (answered) steps.push(step(true, !closed, "fa-reply", "Answered", lastAdmin ? `${lastAdmin.by || "SSO"} · ${lastAdmin.ts || ""}` : ""));
  if (closed) steps.push(step(true, false, "fa-circle-check", "Closed", (last && last.ts) || ""));
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0;padding:10px 12px;background:rgba(255,255,255,.45);border:1px solid rgba(139,26,26,.08);border-radius:10px;">${steps.join("")}</div>`;
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
function hdThread(t) {
  // Viewer-relative alignment, mirroring the chatbot: own messages right
  // (maroon), other party left (gold) — for both students and staff.
  const mine = isAdmin() ? "admin" : "student";
  return `
    <div style="background:rgba(255,255,255,.55);border:1px solid rgba(139,26,26,.08);border-radius:10px;padding:10px;margin-top:8px;max-height:380px;overflow-y:auto;">
      ${(t.msgs || []).map((m) => `
        <div style="margin-bottom:8px;${m.from === mine ? "text-align:right;" : ""}">
          <div style="display:inline-block;max-width:85%;text-align:left;background:${m.from === mine ? "rgba(139,26,26,.14)" : "rgba(245,197,24,.16)"};border-radius:10px;padding:7px 10px;">
            <div style="font-size:9px;font-weight:800;color:rgba(30,5,5,.5);">${esc(m.by)} · ${esc(m.ts)}</div>
            <div style="font-size:12px;color:#1a0505;white-space:pre-wrap;">${esc(m.text)}</div>
          </div>
        </div>`).join("")}
    </div>`;
}
function hdReplyBox(t, who) {
  return t.status === "Closed" ? "" : `
    <div style="display:flex;gap:8px;margin-top:8px;">
      <input id="hdrep-${t.id}" class="glass-input" style="flex:1;padding:8px;font-size:12px;" placeholder="Type a ${who === "admin" ? "response" : "reply"}… (Enter to send)" onkeydown="if(event.key==='Enter'){event.preventDefault();hdReply('${t.id}', this.parentElement.querySelector('button'))}">
      <button onclick="hdReply('${t.id}', this)" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Send</button>
      ${who === "admin" ? `<button onclick="hdClose('${t.id}')" class="btn-ghost" style="padding:8px 12px;font-size:12px;">Close</button>` : ""}
    </div>`;
}
function renderHelpdesk() {
  const el = document.getElementById("helpdeskBody");
  if (isAdmin()) {
    window.__hdAdminStatus = window.__hdAdminStatus || "all";
    const all = [...MOD.tickets].reverse();
    if (!window.__hdAdminTicket && all.length) window.__hdAdminTicket = all[0].id;
    if (window.__hdAdminTicket && !all.some((t) => t.id === window.__hdAdminTicket)) {
      window.__hdAdminTicket = all.length ? all[0].id : null;
    }
    const fq = (hdAdminQ || "").toLowerCase();
    const fs = window.__hdAdminStatus || "all";
    const visible = all.filter((t) => (fs === "all" || t.status === fs) && (!fq || [t.name, t.sn, t.id, t.subject, t.category].some((x) => (x || "").toLowerCase().includes(fq))));
    const open = window.__hdAdminTicket ? all.find((t) => t.id === window.__hdAdminTicket) : null;
    const countFor = (s) => all.filter((t) => t.status === s).length;
    const statusOpts = ["all", "Open", "Answered", "Closed"].map((s) => `<option value="${s}"${fs === s ? " selected" : ""}>${s === "all" ? "All statuses" : s}</option>`).join("");
    const list = visible.map((t) => {
      const last = t.msgs && t.msgs.length ? t.msgs[t.msgs.length - 1].ts : t.ts;
      const lastMsg = t.msgs && t.msgs.length ? t.msgs[t.msgs.length - 1] : null;
      const active = open && t.id === open.id;
      return `<button onclick="hdAdminTicketDetail('${esc(t.id)}')" style="display:block;width:100%;text-align:left;background:${active ? "rgba(139,26,26,.08)" : "transparent"};border:${active ? "1px solid rgba(139,26,26,.2)" : "1px solid transparent"};border-top:1px solid rgba(139,26,26,.08);padding:10px 8px;cursor:pointer;border-radius:8px;">
      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;">
        <span style="font-size:12px;font-weight:800;color:#1a0505;">${esc(t.subject)}</span>${pill(t.status)}
      </div>
      <div style="font-size:11px;font-weight:700;color:#1a0505;margin-top:4px;">${esc(t.name)}</div>
      <div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${esc(t.sn)} · ${esc(t.id)}</div>
      <div style="font-size:11px;color:rgba(30,5,5,.6);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.category)} · ${esc(last || "")}${lastMsg ? ` · ${esc((lastMsg.by || "") + ": " + (lastMsg.text || "").slice(0, 60))}` : ""}</div>
    </button>`;
    }).join("");
    const panel = open ? (() => {
      const t = open;
      const closed = t.status === "Closed";
      return `
      <div class="glass-card" style="padding:18px;flex:2;min-width:300px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:flex-start;">
          <div style="min-width:200px;flex:1;">
            <div style="font-size:15px;font-weight:900;color:#1a0505;">${esc(t.subject)}</div>
            <div style="font-size:11px;color:rgba(30,5,5,.55);margin-top:2px;">${esc(t.id)} · ${esc(t.category)}</div>
            <div style="font-size:11px;color:rgba(30,5,5,.65);margin-top:4px;"><i class="fa-solid fa-user" style="margin-right:4px;color:#8B1A1A;"></i>${esc(t.name)} · <span style="font-family:monospace;">${esc(t.sn)}</span>${t.chatSessionId ? ' · <span style="font-size:10px;">💬 from chatbot</span>' : ""}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${pill(t.status)}</div>
        </div>
        ${ticketTimeline(t)}
        <div id="tktChatQuote">${t.chatSessionId ? `<div style="font-size:11px;color:rgba(30,5,5,.55);padding:4px 2px;"><i class="fa-solid fa-circle-notch fa-spin" style="margin-right:5px;"></i>Loading chat context…</div>` : ""}</div>
        ${hdThread(t)}
        ${closed
          ? `<div style="font-size:11px;color:#4b5563;background:rgba(107,114,128,.1);border:1px solid rgba(107,114,128,.3);border-radius:10px;padding:8px 10px;margin-top:8px;"><i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>This ticket is closed. The student was notified.</div>`
          : `${hdReplyBox(t, "admin")}<div style="font-size:10px;color:rgba(30,5,5,.5);margin-top:6px;">Replying marks the ticket <b>Answered</b> and emails the student. Closing notifies the student the inquiry is resolved.</div>`}
      </div>`;
    })() : `<div class="glass-card" style="padding:26px;flex:2;min-width:300px;">${emptyState(all.length ? "Select a ticket on the left to view the conversation." : "No tickets yet.")}</div>`;
    el.innerHTML = `
    <div class="glass-card" style="padding:14px 18px;margin-bottom:12px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;">
      <div style="font-size:14px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-headset" style="color:#D4A017;margin-right:8px;"></i>Help Desk Tickets</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;font-size:10px;font-weight:800;">
        <span style="background:rgba(37,99,235,.1);color:#1d4ed8;border:1px solid rgba(37,99,235,.3);border-radius:99px;padding:3px 10px;">Open ${countFor("Open")}</span>
        <span style="background:rgba(22,163,74,.1);color:#15803d;border:1px solid rgba(22,163,74,.3);border-radius:99px;padding:3px 10px;">Answered ${countFor("Answered")}</span>
        <span style="background:rgba(107,114,128,.12);color:#4b5563;border:1px solid rgba(107,114,128,.3);border-radius:99px;padding:3px 10px;">Closed ${countFor("Closed")}</span>
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;">
      <div class="glass-card" style="padding:10px;flex:1;min-width:240px;max-width:340px;">
        <div style="display:grid;gap:8px;padding:4px 2px 8px;">
          <input id="hdAdminQBox" class="glass-input" style="padding:8px 10px;font-size:12px;" placeholder="Search by name, ID, subject…" value="${esc(hdAdminQ || "")}" oninput="hdAdminQ=this.value;renderHelpdesk();var i=document.getElementById('hdAdminQBox');i.focus();i.setSelectionRange(i.value.length,i.value.length);">
          <select class="glass-input" style="padding:8px 10px;font-size:12px;" onchange="window.__hdAdminStatus=this.value;renderHelpdesk()">${statusOpts}</select>
        </div>
        <div style="max-height:560px;overflow-y:auto;">${list || emptyState(visible.length || all.length ? "No tickets match your filter." : "No tickets yet.")}</div>
      </div>
      ${panel}
    </div>`;
    requestAnimationFrame(() => {
      el.querySelectorAll("[style*='max-height:380px']").forEach((b) => { b.scrollTop = b.scrollHeight; });
      if (open && open.chatSessionId) loadTicketChatQuote(open.chatSessionId);
    });
  } else {
    if (!chatbotMessages.length) chatbotMessages = [{ from: "bot", text: "Hi! How can I help you today?", ts: Date.now(), pills: CHATBOT_STARTER_PILLS }];
    const mine = [...MOD.tickets].filter((t) => t.sn === session.id).reverse();
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;max-width:820px;margin:0 auto;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;"><div style="display:flex;align-items:center;gap:10px;"><div style="width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:#8B1A1A;color:#F5C518;"><i class="fa-solid fa-robot"></i></div><div><div style="font-size:15px;font-weight:900;color:#1a0505;">Support Assistant ${mine.length ? `<span style="font-size:10px;font-weight:800;color:#8B1A1A;background:rgba(245,197,24,.25);border:1px solid rgba(212,160,23,.4);border-radius:99px;padding:2px 9px;margin-left:6px;vertical-align:middle;">Tickets ${mine.length}</span>` : ""}</div></div></div><div style="display:flex;gap:6px;"><button onclick="toggleChatSessions()" class="btn-ghost" style="padding:8px 12px;font-size:11px;white-space:nowrap;"><i class="fa-solid fa-clock-rotate-left" style="margin-right:4px;"></i>Past chats</button><button onclick="hdMyTickets()" class="btn-ghost" style="padding:8px 12px;font-size:11px;white-space:nowrap;"><i class="fa-solid fa-ticket" style="margin-right:4px;"></i>My tickets</button></div></div>
        ${chatbotSessionsOpen ? chatbotSessionsHtml() : ""}
        <div id="chatbotMessages" style="height:420px;overflow-y:auto;padding:14px;background:rgba(255,255,255,.48);border:1px solid rgba(139,26,26,.12);border-radius:14px;display:flex;flex-direction:column;gap:10px;">
          ${chatbotMessages.map((m, idx) => `<div style="display:flex;justify-content:${m.from === "user" ? "flex-end" : "flex-start"};"><div style="max-width:82%;padding:10px 12px;border-radius:12px;background:${m.from === "user" ? "rgba(139,26,26,.14)" : "rgba(245,197,24,.16)"};font-size:13px;color:#1a0505;line-height:1.5;white-space:pre-wrap;">${esc(m.text)}${m.ts ? `<div style="font-size:9px;color:rgba(30,5,5,.45);margin-top:4px;">${esc(fmtChatTs(m.ts))}</div>` : ""}${chatbotFeedbackHtml(m, idx)}${chatbotPillsHtml(m, idx)}${chatbotCardsHtml(m)}${chatbotFollowHtml(m, idx)}</div></div>`).join("")}
          ${chatbotTyping ? `<div style="display:flex;justify-content:flex-start;"><div style="padding:10px 14px;border-radius:12px;background:rgba(245,197,24,.16);font-size:13px;color:#1a0505;"><i class="fa-solid fa-ellipsis fa-fade"></i></div></div>` : ""}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;"><input id="chatbotInput" class="glass-input" style="flex:1" placeholder="Ask a question about Student Services…" onkeydown="if(event.key==='Enter')chatbotAsk()"><button onclick="chatbotAsk()" class="btn-maroon" style="padding:10px 16px;"><i class="fa-solid fa-paper-plane"></i> Send</button></div>
      </div>`;
    enableRequestDropdowns(el);
    requestAnimationFrame(() => { const box = document.getElementById("chatbotMessages"); if (box) box.scrollTop = box.scrollHeight; });
  }
}
async function chatbotAsk() {
  const input = document.getElementById("chatbotInput");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  await chatbotSendToServer(question);
}
// F-2 per-answer feedback: one tap votes, re-tap removes (server toggles).
function chatbotFeedbackHtml(m, idx) {
  if (m.from !== "bot" || !m.feedbackId) return "";
  const btn = (v, icon, title) => `<button onclick="chatbotFeedback(${idx},${v})" title="${title}" style="border:none;background:transparent;cursor:pointer;font-size:11px;color:${m.fb === v ? "#8B1A1A" : "rgba(30,5,5,.35)"};padding:2px 5px;"><i class="fa-solid ${icon}"></i></button>`;
  return `<div style="display:flex;gap:2px;margin-top:6px;">${btn(1, "fa-thumbs-up", "Helpful")}${btn(-1, "fa-thumbs-down", "Not helpful")}</div>`;
}
async function chatbotFeedback(idx, value) {
  const m = chatbotMessages[idx];
  if (!m || !m.feedbackId) return;
  const res = await api("/api/assistant/feedback", { method: "POST", body: { chatMessageId: m.feedbackId, value } });
  if (!res.ok) { showToast(`❌ ${res.error || "Could not save feedback."}`, "rgba(155,22,22,.85)"); return; }
  m.fb = res.data && res.data.value ? res.data.value : 0;
  renderHelpdesk();
}
// F-3 follow-up: one muted next-step line + tappable pill under the cards.
function chatbotFollowHtml(m, idx) {
  const f = m.followUp;
  if (!f || !f.prompt) return "";
  const label = (f.pill && f.pill.label) || f.prompt;
  return `<div style="margin-top:8px;font-size:11px;color:rgba(30,5,5,.6);">Next step: <button onclick="chatbotFollowClick(${idx})" class="btn-ghost" style="padding:6px 10px;font-size:11px;">${esc(label)}</button></div>`;
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
// Same message shape as server replies (links/cards/pills arrays, empty
// here) and the same fallback tone — one rendering path, no second bot.
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
    chatbotMessages.push({ from: "bot", text: "I don't have enough information to answer that accurately.\n\nYou can create a support ticket and the appropriate office will be able to assist you.", ts: Date.now(), links: [], cards: [], pills: [], feedbackId: null, fb: 0, followUp: null });
  }
  renderHelpdesk();
}
// Contextual action pills: rendered ONLY under the latest bot message —
// earlier pills vanish on re-render by construction. Legacy per-message
// links render only when a message carries no pills (offline fallback).
function chatbotPillsHtml(m, idx) {
  const isLatest = idx === chatbotMessages.length - 1 && m.from === "bot" && !chatbotTyping;
  const pills = m.pills || [];
  if (isLatest && pills.length) {
    return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">${pills.map((p, i) => `<button onclick="chatbotPillClick(${idx},${i})" class="btn-ghost" style="padding:7px 10px;font-size:11px;">${esc(p.label)}</button>`).join("")}</div>`;
  }
  if (!pills.length) {
    return (m.links || []).map((l) => `<button onclick="goTo('${esc(l.target)}')" class="btn-ghost" style="display:block;margin-top:8px;padding:7px 10px;font-size:11px;text-align:left;">${esc(l.label)} →</button>`).join("");
  }
  return "";
}
function chatbotPillClick(msgIdx, pillIdx) {
  if (chatbotTyping) return;
  const m = chatbotMessages[msgIdx];
  const p = m && m.pills && m.pills[pillIdx];
  if (!p || !p.action) return;
  const a = p.action;
  if (a.type === "navigate") {
    if (!/^page-[a-z0-9-]+$/.test(a.target || "") || !document.getElementById(a.target)) return;
    goTo(a.target);
    return;
  }
  if (a.type === "jump") {
    const el = document.getElementById(a.anchor || "");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (a.type === "ticket") {
    // Session link is preserved from client state (prefill carries content only).
    openTicketDraftModal(a.prefill || null, chatbotSessionId ? { chatSessionId: chatbotSessionId } : {});
    return;
  }
  if (a.type === "tickets") { hdMyTickets(); return; }
  if (a.type === "ask" && (a.prompt || "").trim()) {
    // F-6 tap analytics: the tapped label rides the next POST only.
    pendingViaPill = p.label || "";
    chatbotSendToServer(a.prompt.trim());
  }
}
// Starter set mirrors server STARTER_PILLS (client-side initial message only).
const CHATBOT_STARTER_PILLS = [
  { label: "Book an appointment", action: { type: "navigate", target: "page-appointment" } },
  { label: "Request a document", action: { type: "navigate", target: "page-appointment-book" } },
  { label: "Check a request", action: { type: "ask", prompt: "What's the status of my requests?" } },
  { label: "Report a problem", action: { type: "ticket" } },
];
// Structured answer cards mirroring the text reply (C-3). Server sends
// cards; text stays authoritative, so a missing/empty array renders nothing.
function chatbotCardsHtml(m) {
  return (m.cards || []).map((c) => `
    <div style="margin-top:8px;background:rgba(255,255,255,.6);border:1px solid rgba(139,26,26,.12);border-radius:10px;padding:8px 10px;text-align:left;">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:12px;font-weight:800;color:#1a0505;">${esc(c.title)}</span>${pill(c.status)}
      </div>
      <div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);margin-top:2px;">${esc(c.ref)}</div>
      ${(c.meta || []).map((x) => `<div style="font-size:11px;color:rgba(30,5,5,.7);margin-top:2px;">${esc(x)}</div>`).join("")}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">${c.kind === "ticket" ? `<button onclick="jumpToTicket('${esc(c.ref)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">View ticket</button>` : ""}${c.link ? `<button onclick="goTo('${esc(c.link.target)}')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">${esc(c.link.label)} →</button>` : ""}</div>
    </div>`).join("");
}
async function chatbotSendToServer(question) {
  chatbotEscalationQuestion = "";
  chatbotTicketDraft = null;
  chatbotMessages.push({ from: "user", text: question, ts: Date.now() });
  chatbotTyping = true;
  renderHelpdesk();
  const body = { sessionId: chatbotSessionId, message: question };
  if (pendingViaPill) body.viaPill = pendingViaPill;
  pendingViaPill = "";
  const res = await api("/api/assistant/chat", { method: "POST", body });
  chatbotTyping = false;
  if (!res.ok || !res.data) {
    // F-7 retry: network/rate-limit/server failures keep the typed text in
    // the input (the optimistic bubble is withdrawn) — press Send to retry.
    // Other failures fall back to the local keyword answer as before.
    if (!res.ok && (res.status === 0 || res.status === 429 || res.status >= 500)) {
      const last = chatbotMessages[chatbotMessages.length - 1];
      if (last && last.from === "user" && last.text === question) chatbotMessages.pop();
      const input = document.getElementById("chatbotInput");
      if (input) { input.value = question; input.focus(); }
      showToast("⚠️ Couldn't send — your message is kept above. Press Send to retry.", "rgba(180,130,0,.9)");
      renderHelpdesk();
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
  renderHelpdesk();
}
// F-7 past chats: search, open, rename, and start over (own sessions only).
function chatbotSessionsHtml() {
  const q = (chatbotSessionQ || "").toLowerCase();
  const rows = chatbotSessions.filter((s) => !q || (s.subject || "").toLowerCase().includes(q));
  const fmt = (ts) => { try { return new Date(ts).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } };
  return `<div class="glass-card" style="padding:12px;margin-bottom:12px;">
    <div style="display:flex;gap:8px;margin-bottom:8px;"><input id="chatSessionQ" class="glass-input" style="flex:1;padding:7px 10px;font-size:12px;" placeholder="Search past chats…" value="${esc(chatbotSessionQ || "")}" oninput="chatbotSessionQ=this.value;renderHelpdesk();var i=document.getElementById('chatSessionQ');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length);}"><button onclick="newChatSession()" class="btn-gold" style="padding:7px 12px;font-size:11px;white-space:nowrap;">New chat</button></div>
    <div style="max-height:180px;overflow-y:auto;display:grid;gap:6px;">${rows.map((s) => `
      <div style="display:flex;gap:6px;align-items:center;background:${s.id === chatbotSessionId ? "rgba(139,26,26,.08)" : "rgba(255,255,255,.4)"};border:1px solid rgba(139,26,26,.1);border-radius:8px;padding:7px 10px;">
        <button onclick="openChatSession('${esc(s.id)}')" style="flex:1;text-align:left;border:none;background:transparent;cursor:pointer;min-width:0;"><div style="font-size:12px;font-weight:800;color:#1a0505;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.subject || "Untitled chat")}</div><div style="font-size:10px;color:rgba(30,5,5,.5);">${esc(fmt(s.updatedAt))}${s.messageCount ? ` · ${s.messageCount} msgs` : ""}</div></button>
        <button onclick="renameChatSession('${esc(s.id)}','${esc(s.subject || "")}')" title="Rename" style="border:none;background:transparent;cursor:pointer;color:rgba(30,5,5,.45);font-size:11px;padding:4px;"><i class="fa-solid fa-pen"></i></button>
      </div>`).join("") || `<div style="font-size:11px;color:rgba(30,5,5,.55);padding:6px 2px;">${chatbotSessions.length ? "No chats match." : "No past chats yet."}</div>`}</div>
  </div>`;
}
async function toggleChatSessions() {
  chatbotSessionsOpen = !chatbotSessionsOpen;
  if (chatbotSessionsOpen) await loadChatSessions();
  renderHelpdesk();
}
async function loadChatSessions() {
  const res = await api("/api/assistant/sessions");
  chatbotSessions = res.ok && Array.isArray(res.data) ? res.data : [];
}
async function openChatSession(id) {
  const res = await api(`/api/assistant/sessions/${encodeURIComponent(id)}`);
  if (!res.ok || !res.data) { showToast("❌ Couldn't open that chat.", "rgba(155,22,22,.85)"); return; }
  chatbotMessages = ((res.data.messages || []).map((sm) => ({
    from: sm.role === "assistant" ? "bot" : "user",
    text: sm.text || "",
    ts: sm.createdAt ? new Date(sm.createdAt).getTime() : Date.now(),
    links: [],
    cards: [],
    pills: [],
    feedbackId: sm.role === "assistant" ? sm.id : null,
    fb: sm.feedback && sm.feedback.value ? sm.feedback.value : 0,
    followUp: null,
  })));
  chatbotSessionId = res.data.id || id;
  chatbotSessionsOpen = false;
  renderHelpdesk();
}
function newChatSession() {
  chatbotSessionId = "";
  chatbotMessages = [];
  chatbotSessionsOpen = false;
  renderHelpdesk();
}
function renameChatSession(id, current) {
  openAppModal({ title: "Rename chat", subtitle: "Only you see this name.", icon: "fa-pen", content: `
    <div><span class="input-label">Name</span><input id="chatRenameInput" class="glass-input" maxlength="80" value="${esc(current || "")}"></div>
    <div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button onclick="saveChatSessionName('${esc(id)}')" class="btn-maroon">Save</button></div>` });
}
async function saveChatSessionName(id) {
  const subject = (document.getElementById("chatRenameInput")?.value || "").trim();
  if (!subject) { showToast("⚠️ Please enter a name.", "rgba(180,130,0,.85)"); return; }
  const res = await api(`/api/assistant/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: { subject } });
  if (!res.ok) { showToast(`❌ ${res.error || "Could not rename."}`, "rgba(155,22,22,.85)"); return; }
  closeAppModal();
  await loadChatSessions();
  renderHelpdesk();
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
// Shared ticket draft review (C-4/T-1): one creation path, two doors —
// prefilled from chat escalation, or blank for a manual ticket.
// extra carries {chatSessionId} for chat escalations only.
let pendingTicketExtra = {};
function openTicketDraftModal(prefill, extra) {
  const p = prefill || {};
  pendingTicketExtra = extra || {};
  const cats = ticketCategoryOptions(p.category);
  const catField = cats.length
    ? `<select id="tkdCat" class="glass-input" onchange="document.getElementById('tkdOtherWrap').style.display=this.value==='__other'?'block':'none'">${cats.map((c) => `<option value="${esc(c)}"${c === (p.category || "") ? " selected" : ""}>${esc(c)}</option>`).join("")}<option value="__other">Other…</option></select><div id="tkdOtherWrap" style="display:none;margin-top:8px;"><input id="tkdCatOther" class="glass-input" placeholder="Type a category"></div>`
    : `<input id="tkdCat" class="glass-input" placeholder="e.g. Document Request" value="${esc(p.category || "")}">`;
  openAppModal({ title: pendingTicketExtra.chatSessionId ? "Review support ticket" : "New support ticket", subtitle: pendingTicketExtra.chatSessionId ? "Drafted from this chat · editable" : "Describe your concern for the SSO staff", icon: "fa-ticket", content: `
    <div style="display:grid;gap:10px;">
      <div><span class="input-label">Category</span>${catField}</div>
      <div><span class="input-label">Subject</span><input id="tkdSubj" class="glass-input" placeholder="Short summary" value="${esc(p.subject || "")}"></div>
      <div><span class="input-label">Message</span><textarea id="tkdMsg" class="glass-input" rows="4" placeholder="What happened? Include reference codes (TKT-…, APT-…) when relevant.">${esc(p.message || "")}</textarea></div>
    </div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button onclick="submitTicketDraft()" class="btn-maroon">Submit Ticket</button></div>` });
}
async function submitTicketDraft() {
  let category = (document.getElementById("tkdCat")?.value || "").trim();
  if (category === "__other") category = (document.getElementById("tkdCatOther")?.value || "").trim();
  const body = { category, subject: (document.getElementById("tkdSubj")?.value || "").trim(), message: (document.getElementById("tkdMsg")?.value || "").trim(), ...pendingTicketExtra };
  if (!body.category) { showToast("⚠️ Please choose a category.", "rgba(180,130,0,.85)"); return; }
  if (!body.subject || !body.message) { showToast("⚠️ Subject and message are required.", "rgba(180,130,0,.85)"); return; }
  const res = await api("/api/modules/tickets", { method: "POST", body });
  if (!res.ok) { showToast(`❌ ${res.error || "Could not submit the Help Desk ticket."}`, "rgba(155,22,22,.85)"); return; }
  const ticketId = res.data && res.data.id ? res.data.id : "";
  pendingTicketExtra = {};
  closeAppModal();
  chatbotEscalationQuestion = "";
  chatbotTicketDraft = null;
  if (ticketId) chatbotMessages.push({ from: "bot", text: `Ticket ${ticketId} submitted. An SSO staff member will respond through your ticket.`, ts: Date.now() });
  await loadModule("tickets");
  showToast("✅ Help Desk ticket submitted.");
  renderHelpdesk();
  if (ticketId) jumpToTicket(ticketId);
}
function jumpToTicket(id) {
  window.__hdStudentTicket = id;
  goTo("page-tickets");
}
function hdNewTicket() {
  openTicketDraftModal(null, {});
}
// Student ticket library: list → detail → reply on the dedicated
// page-tickets page, all scoped to own tickets.
function hdMyTickets() {
  window.__hdStudentTicket = null;
  goTo("page-tickets");
}
function renderTicketsPage() {
  const el = document.getElementById("ticketsBody");
  if (!el) return;
  window.__hdTicketFilter = window.__hdTicketFilter || { q: "", status: "all" };
  const mine = [...(MOD.tickets || [])].filter((t) => t.sn === session.id).reverse();
  if (!window.__hdStudentTicket && mine.length) window.__hdStudentTicket = mine[0].id;
  const open = window.__hdStudentTicket ? mine.find((t) => t.id === window.__hdStudentTicket) : null;
  const fq = (window.__hdTicketFilter.q || "").toLowerCase();
  const fs = window.__hdTicketFilter.status || "all";
  const visible = mine.filter((t) => (fs === "all" || t.status === fs) && (!fq || [t.subject, t.id, t.category].some((x) => (x || "").toLowerCase().includes(fq))));
  const statusOpts = ["all", "Open", "Answered", "Closed"].map((s) => `<option value="${s}"${fs === s ? " selected" : ""}>${s === "all" ? "All statuses" : s}</option>`).join("");
  const list = visible.map((t) => {
    const last = t.msgs && t.msgs.length ? t.msgs[t.msgs.length - 1].ts : t.ts;
    const active = open && t.id === open.id;
    return `<button onclick="hdTicketDetail('${esc(t.id)}')" style="display:block;width:100%;text-align:left;background:${active ? "rgba(139,26,26,.08)" : "transparent"};border:none;border-top:1px solid rgba(139,26,26,.08);padding:10px 8px;cursor:pointer;border-radius:8px;">
      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;">
        <span style="font-size:12px;font-weight:800;color:#1a0505;">${esc(t.subject)}</span>${pill(t.status)}
      </div>
      <div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);margin-top:2px;">${esc(t.id)}</div>
      <div style="font-size:11px;color:rgba(30,5,5,.6);margin-top:2px;">${esc(t.category)} · ${esc(last || "")}</div>
    </button>`;
  }).join("");
  const panel = open ? (() => {
    const t = open;
    return `
      <div class="glass-card" style="padding:18px;flex:2;min-width:300px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><div style="font-size:15px;font-weight:900;color:#1a0505;">${esc(t.subject)}</div>
          <div style="font-size:11px;color:rgba(30,5,5,.55);margin-top:2px;">${esc(t.id)} · ${esc(t.category)}</div></div>
          ${pill(t.status)}
        </div>
        ${ticketTimeline(t)}
        ${hdThread(t)}${hdReplyBox(t, "student")}
      </div>`;
  })() : `<div class="glass-card" style="padding:26px;flex:2;min-width:300px;">${emptyState("Select a ticket on the left to view the conversation.")}</div>`;
  el.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:6px;"><button onclick="hdNewTicket()" class="btn-maroon" style="padding:8px 14px;font-size:11px;"><i class="fa-solid fa-plus" style="margin-right:4px;"></i>New ticket</button></div>
    <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;">
      <div class="glass-card" style="padding:10px;flex:1;min-width:240px;max-width:340px;">
        <div style="display:grid;gap:8px;padding:4px 2px 8px;">
          <input id="hdTicketQ" class="glass-input" style="padding:8px 10px;font-size:12px;" placeholder="Search tickets…" value="${esc(window.__hdTicketFilter.q || "")}" oninput="window.__hdTicketFilter.q=this.value;renderTicketsPage();var i=document.getElementById('hdTicketQ');i.focus();i.setSelectionRange(i.value.length,i.value.length);">
          <select id="hdTicketStatus" class="glass-input" style="padding:8px 10px;font-size:12px;" onchange="window.__hdTicketFilter.status=this.value;renderTicketsPage()">${statusOpts}</select>
        </div>
        ${list || emptyState(visible.length || mine.length ? "No tickets match your filter." : "No help desk tickets yet.")}
      </div>
      ${panel}
    </div>`;
  requestAnimationFrame(() => { const box = el.querySelector("[style*='overflow-y:auto']"); if (box) box.scrollTop = box.scrollHeight; });
}
function hdTicketDetail(id) {
  window.__hdStudentTicket = id;
  if (document.querySelector(".page.active")?.id === "page-tickets") renderTicketsPage();
  else goTo("page-tickets");
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
  box.innerHTML = first ? `<div style="font-size:11px;color:rgba(30,5,5,.7);background:rgba(245,197,24,.14);border:1px solid rgba(212,160,23,.35);border-radius:10px;padding:8px 10px;margin:4px 0;"><i class="fa-solid fa-robot" style="color:#8B1A1A;margin-right:5px;"></i>Student originally asked: “${esc(first.text)}”</div>` : "";
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
async function hdClose(id) {
  if (!confirm("Close this ticket? The student will be notified it is resolved.")) return;
  const { ok, error } = await api(`/api/modules/tickets/${encodeURIComponent(id)}/close`, { method: "POST" });
  if (!ok) { showToast(`❌ ${error || "Could not close ticket."}`, "rgba(155,22,22,.85)"); return; }
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
function renderFaq() {
  const el = document.getElementById("faqBody");
  const q = faqQuery.toLowerCase();
  const list = MOD.faqs.filter((f) => !q || f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q) || f.cat.toLowerCase().includes(q));
  const categoryMap = new Map(faqCategories.map((category) => [category.name, category]));
  MOD.faqs.forEach((faq) => { if (!categoryMap.has(faq.cat)) categoryMap.set(faq.cat, { id: "", name: faq.cat }); });
  const allCategories = [...categoryMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const cats = q ? allCategories.filter((category) => list.some((faq) => faq.cat === category.name)) : allCategories;
  let adminForm = "";
  if (isAdmin()) {
    adminForm = `
      <div class="glass-card" style="padding:16px;margin-bottom:14px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-folder-plus" style="color:#8B1A1A;margin-right:6px;"></i>Add FAQ Category</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <input id="faqCategoryName" class="glass-input" style="flex:1;min-width:220px;" placeholder="Category name (e.g., Appointments)">
          <button onclick="faqCategoryAdd()" class="btn-gold" style="padding:10px 16px;">Add Category</button>
        </div>
      </div>`;
    if (assistantCuration.length) {
      adminForm += `
      <div class="glass-card" style="padding:16px;margin-bottom:14px;border-color:rgba(212,160,23,.4);">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:4px;"><i class="fa-solid fa-lightbulb" style="color:#D4A017;margin-right:6px;"></i>Questions needing answers</div>
        <div style="font-size:11px;color:rgba(30,5,5,.6);margin-bottom:10px;">Asked ${assistantCuration.reduce((n, s) => n + s.count, 0)}× with no confident answer. Answer one to add it as a verified FAQ.</div>
        ${assistantCuration.map((s, i) => `
          <div style="display:flex;gap:8px;align-items:flex-start;justify-content:space-between;padding:9px 0;border-top:1px solid rgba(139,26,26,.08);flex-wrap:wrap;">
            <div style="flex:1;min-width:200px;">
              <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(s.question)} <span style="font-size:10px;font-weight:800;color:#fff;background:#8B1A1A;border-radius:8px;padding:1px 7px;margin-left:4px;">${s.count}×</span></div>
              <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:3px;">Suggested: ${esc(s.suggestedCategory || "pick a category")}${s.similarFaq ? ` · Possibly covered by “${esc(s.similarFaq.q)}” (${Math.round(s.similarFaq.similarity * 100)}%)` : ""}</div>
            </div>
            <button onclick="answerCuration(${i})" class="btn-maroon" style="padding:7px 11px;font-size:10px;">Answer as FAQ</button>
          </div>`).join("")}
      </div>`;
    }
  }
  el.innerHTML = adminForm + `
    <div style="position:relative;margin-bottom:14px;">
      <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:rgba(30,5,5,.4);font-size:12px;"></i>
      <input class="glass-input" style="padding-left:34px;" placeholder="Search FAQs…" value="${esc(faqQuery)}" oninput="faqQuery=this.value;renderFaq();this.focus();this.setSelectionRange(this.value.length,this.value.length);">
    </div>
    ${cats.length ? cats.map((category) => { const c = category.name; return `
      <div class="glass-card" style="padding:14px;margin:14px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:${list.some((f) => f.cat === c) ? "10px" : "0"};">
          <div style="font-size:12px;font-weight:800;color:#8B1A1A;text-transform:uppercase;letter-spacing:.05em;">${esc(c)}</div>
          ${isAdmin() ? `<div style="display:flex;gap:6px;align-items:center;"><button onclick="openFaqEntryForm('${esc(c).replace(/'/g, "\\'")}')" class="btn-maroon" style="padding:7px 11px;font-size:10px;"><i class="fa-solid fa-plus" style="margin-right:4px;"></i>Add FAQ</button>${category.id ? `<button onclick="faqCategoryDelete('${category.id}','${esc(c).replace(/'/g, "\\'")}')" class="btn-ghost" style="padding:7px 9px;font-size:10px;color:#b91c1c;">Delete Category</button>` : ""}</div>` : ""}
        </div>
        ${list.filter((f) => f.cat === c).length ? list.filter((f) => f.cat === c).map((f) => `
        <details class="glass-card" style="padding:12px 14px;margin-bottom:8px;">
          <summary style="font-size:13px;font-weight:700;color:#1a0505;cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center;">
            <span>${esc(f.q)}</span>
            ${isAdmin() ? `<button onclick="event.preventDefault();faqDelete('${f.id}')" class="btn-ghost" style="padding:5px 9px;font-size:10px;color:#b91c1c;">Delete</button>` : ""}
          </summary>
          <div style="font-size:12px;color:rgba(30,5,5,.8);margin-top:8px;white-space:pre-wrap;">${esc(f.a)}</div>
        </details>`).join("") : `<div style="font-size:12px;color:rgba(30,5,5,.6);">No FAQs in this category yet. Use Add FAQ to create the first one.</div>`}
      </div>`; }).join("") : emptyState("No FAQ categories yet.")}
  `;
}
async function faqCategoryAdd() {
  const input = document.getElementById("faqCategoryName");
  const name = input?.value.trim();
  if (!name) { showToast("⚠️ Enter a category name first.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/faq-categories", { method: "POST", body: { name } });
  if (!ok) { showToast(`❌ ${error || "Could not add FAQ category."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ FAQ category added.");
  await loadFaqCategories(); renderFaq();
}
async function faqCategoryDelete(id, name) {
  if (!confirm(`Delete the '${name}' category and all FAQs inside it? This cannot be undone.`)) return;
  const { ok, error, data } = await api(`/api/modules/faq-categories/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { showToast(`❌ ${error || "Could not delete FAQ category."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`✅ Category deleted${data?.removedFaqs ? ` with ${data.removedFaqs} FAQ(s)` : ""}.`);
  await Promise.all([loadModule("faqs"), loadFaqCategories()]); renderFaq();
}
function openFaqEntryForm(category, presetQ) {
  faqCategoryForEntry = category;
  openAppModal({ title: "Add FAQ", subtitle: `Category: ${category}`, icon: "fa-circle-question", content: `<div style="display:grid;gap:10px;"><input id="faqQ" class="glass-input" placeholder="Question" value="${esc(presetQ || "")}"><textarea id="faqA" class="glass-input" rows="4" placeholder="Answer"></textarea></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button onclick="faqAdd()" class="btn-gold">Add FAQ</button></div>` });
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
async function faqDelete(id) {
  if (!confirm("Delete this FAQ?")) return;
  const { ok, error } = await api(`/api/modules/faqs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { showToast(`❌ ${error || "Could not delete."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("faqs"); renderFaq();
}




const CMP_STATUSES = ["Submitted", "Under Investigation", "Resolved", "Dismissed"];
function renderComplaint() {
  const el = document.getElementById("complaintBody");
  if (isAdmin()) {
    const list = [...MOD.complaints].reverse().filter((c) => matchQ(cmpAdminQ, [c.name, c.sn, c.id, c.category, c.status]));
    const rows = getModulePage("complaints-admin", list).items.map((c) => `<tr>
        <td><div style="font-weight:700;font-size:12px;color:#1a0505;">${esc(c.id)}</div><div style="font-size:10px;color:rgba(30,5,5,.55);">${esc(c.category)}</div></td>
        <td>${pill(c.status)}</td>
        <td style="font-size:11px;"><i class="fa-solid fa-lock" style="color:#8B1A1A;margin-right:4px;"></i>${esc(c.confidentiality || "Standard")}</td>
        <td style="font-size:11px;">${c.assignedTo ? esc(c.assignedTo) : "—"}</td>
        <td style="font-size:11px;white-space:nowrap;">${esc(c.ts)}</td>
        <td style="text-align:right;">${manageBtn(c.id, "openComplaintModal")}</td>
      </tr>`).join("");
    el.innerHTML = adminTableShell({
      icon: "fa-solid fa-shield-heart",
      title: "Student Complaints",
      count: `${list.length} total`,
      filtersHtml: adminSearchBox("cmpAdminQBox", "cmpAdminQ", "renderComplaint", "Search by name, student ID, or ref code…", cmpAdminQ),
      theadHtml: "<th>Reference</th><th>Status</th><th>Confidentiality</th><th>Assigned</th><th>Filed</th><th style=\"text-align:right;\">Action</th>",
      rowsHtml: rows,
      emptyHtml: emptyState(cmpAdminQ ? "No complaints match your search." : "No complaints filed."),
      paginationHtml: modulePagination("complaints-admin", list.length, "renderComplaint"),
    });
  } else {
    const mine = MOD.complaints.filter((c) => c.sn === session.id).reverse();
    const minePage = getModulePage("complaints-student", mine);
    el.innerHTML = `
      <div class="glass-card" style="padding:14px;margin-bottom:14px;background:rgba(139,26,26,.06);border:1px solid rgba(139,26,26,.15);">
        <div style="font-size:12px;color:#1a0505;"><i class="fa-solid fa-lock" style="color:#8B1A1A;margin-right:6px;"></i><b>Confidentiality notice:</b> Your complaint is visible only to authorized OSS personnel. Your identity will not be disclosed to other parties without your consent.</div>
      </div>
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>File a Complaint</div>
        <div style="display:grid;gap:10px;">
          <div><span class="input-label">Category</span>
            <select id="cmCat" class="glass-input"><option>Facilities</option><option>Staff Conduct</option><option>Academic Concern</option><option>Harassment / Bullying</option><option>Safety &amp; Security</option><option>Others</option></select></div>
          <div><span class="input-label">Confidentiality</span><select id="cmConf" class="glass-input"><option>Standard</option><option>Restricted</option><option>Strictly Confidential</option></select></div>
          <div><span class="input-label">Details</span><textarea id="cmDet" class="glass-input" rows="4" placeholder="Describe what happened, when, and where…"></textarea></div>
          <div><span class="input-label">Supporting document (optional)</span>
            <input id="cmAtt" type="file" accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" class="glass-input" style="padding:9px;"></div>
          <button onclick="cmpSubmit()" class="btn-gold" style="padding:11px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Confidentially</button>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Complaints</div>
      ${mine.length ? minePage.items.map((c) => `
        <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(c.id)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(c.category)} · ${esc(c.ts)}</span></div>
            ${pill(c.status)}
          </div>
          ${wfStepperHtml("complaint", c)}
          ${c.note ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>OSS resolution note:</b> ${esc(c.note)}</div>` : ""}
        </div>`).join("") : emptyState("No complaints filed.")}
      ${modulePagination("complaints-student", mine.length, "renderComplaint")}
    `;
    enableRequestDropdowns(el);
  }
}
async function cmpSubmit() {
  const cat = document.getElementById("cmCat").value;
  const det = document.getElementById("cmDet").value.trim();
  if (!det) { showToast("⚠️ Please describe the complaint.", "rgba(180,130,0,.85)"); return; }
  const attInput = document.getElementById("cmAtt");
  let attName = "", attUrl = "";
  if (attInput.files.length) {
    const uploaded = await uploadFile(attInput);
    if (uploaded === false) return;
    attName = uploaded.fileName || ""; attUrl = uploaded.url || "";
  }
  const confidentiality = document.getElementById("cmConf").value;
  const { ok, error } = await api("/api/modules/complaints", { method: "POST", body: { category: cat, details: det, attName, attUrl, confidentiality } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Complaint filed confidentially.");
  await loadModule("complaints"); renderComplaint();
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
  await loadModule("complaints"); renderComplaint();
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
      ${modalActionsHtml(`<button class="btn-ghost" onclick="cmpUpdate('${esc(c.id)}','${esc(c.status)}')">Save details</button>` + wfAdminActionsHtml("complaint", c.id, c))}
    </div>` });
}


function renderForms() {
  const el = document.getElementById("formsBody");
  let adminForm = "";
  if (isAdmin()) {
    adminForm = `
      <div class="glass-card" style="padding:16px;margin-bottom:14px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-upload" style="color:#8B1A1A;margin-right:6px;"></i>Upload a Form</div>
        <div style="display:grid;gap:8px;">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px;">
            <input id="frmTitle" class="glass-input" placeholder="Form title (e.g., Excuse Slip Request Form)">
            <input id="frmCat" class="glass-input" placeholder="Category (e.g., Documents)">
          </div>
          <input id="frmFile" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" class="glass-input" style="padding:9px;">
          <button onclick="frmUpload()" class="btn-gold" style="padding:10px;">Upload Form</button>
        </div>
      </div>`;
  }
  const cats = [...new Set(MOD.forms.map((f) => f.cat))];
  el.innerHTML = adminForm + (MOD.forms.length ? cats.map((c) => `
    <div style="font-size:12px;font-weight:800;color:#8B1A1A;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px;">${esc(c)}</div>
    ${MOD.forms.filter((f) => f.cat === c).map((f) => `
      <div class="glass-card" style="padding:12px 14px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;">
        <div>
          <div style="font-size:13px;font-weight:700;color:#1a0505;"><i class="fa-solid fa-file-lines" style="color:#8B1A1A;margin-right:6px;"></i>${esc(f.title)}</div>
          <div style="font-size:10px;color:rgba(30,5,5,.5);">${esc(f.fileName)} · uploaded ${esc(f.ts)}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <a href="${f.url}" download="${esc(f.fileName)}" class="btn-maroon" style="padding:8px 14px;font-size:12px;text-decoration:none;"><i class="fa-solid fa-download" style="margin-right:5px;"></i>Download</a>
          ${isAdmin() ? `<button onclick="frmDelete('${f.id}')" class="btn-ghost" style="padding:8px 10px;font-size:12px;color:#b91c1c;">Remove</button>` : ""}
        </div>
      </div>`).join("")}`).join("") : emptyState(isAdmin() ? "No forms uploaded yet — add the first one above." : "No forms available yet. Please check back soon."));
}
async function frmUpload() {
  const t = document.getElementById("frmTitle").value.trim();
  const c = document.getElementById("frmCat").value.trim() || "General";
  const inp = document.getElementById("frmFile");
  if (!t) { showToast("⚠️ Form title is required.", "rgba(180,130,0,.85)"); return; }
  if (!inp.files.length) { showToast("⚠️ Please choose a file.", "rgba(180,130,0,.85)"); return; }
  const uploaded = await uploadFile(inp);
  if (uploaded === false || !uploaded.url) return;
  const { ok, error } = await api("/api/modules/forms", { method: "POST", body: { title: t, cat: c, fileName: uploaded.fileName, url: uploaded.url } });
  if (!ok) { showToast(`❌ ${error || "Could not upload."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Form uploaded.");
  await loadModule("forms"); renderForms();
}
async function frmDelete(id) {
  const f = MOD.forms.find((x) => x.id === id); if (!f) return;
  if (!confirm(`Remove "${f.title}"?`)) return;
  const { ok, error } = await api(`/api/modules/forms/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { showToast(`❌ ${error || "Could not remove."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("forms"); renderForms();
}


function renderMemo() {
  const el = document.getElementById("memoBody");
  const courses = ["BSCS", "BSIT", "BSBA", "BSA", "BEED"];
  const years = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
  el.innerHTML = `
    <div class="glass-card" style="padding:18px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-envelopes-bulk" style="color:#8B1A1A;margin-right:6px;"></i>Compose Memo</div>
      <div style="display:grid;gap:10px;">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
          <div><span class="input-label">Subject</span><input id="memoSubj" class="glass-input" placeholder="e.g., MEMO: Enrollment Schedule for 1st Semester"></div>
          <div><span class="input-label">Recipients</span>
            <select id="memoSource" class="glass-input" onchange="memoRecipientOptions()">
              <option value="REGISTERED">Registered Students</option>
              <option value="MASTERLIST">CSV Masterlist Unregistered</option>
            </select></div>
        </div>
        <div style="padding:11px 12px;border:1px solid rgba(139,26,26,.12);background:rgba(255,255,255,.3);border-radius:12px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;"><div><span class="input-label">Course</span><select id="memoCourse" class="glass-input"><option value="">All courses</option>${courses.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></div><div><span class="input-label">Year Level</span><select id="memoYear" class="glass-input"><option value="">All year levels</option>${years.map((y) => `<option value="${y}">${y}</option>`).join("")}</select></div></div>
          <label id="memoIncludeUnregisteredLabel" style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:#1a0505;cursor:pointer;margin-top:10px;"><input id="memoIncludeUnregistered" type="checkbox" style="accent-color:#8B1A1A;"> Include matching CSV Masterlist unregistered students</label>
          <div style="font-size:10px;color:rgba(30,5,5,.58);margin-top:6px;">Example: choose BSIT + 1st Year, then check the box to also email unregistered BSIT 1st Year students from the CSV masterlist.</div>
        </div>
        <div><span class="input-label">Message</span><textarea id="memoBodyTxt" class="glass-input" rows="5" placeholder="Write the memorandum…"></textarea></div>
        <button onclick="memoSend()" class="btn-gold" style="padding:11px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Send Blast</button>
        <div style="font-size:10px;color:rgba(30,5,5,.55);">For CSV filtering, import a masterlist with <b>Course</b> and <b>Year Level</b> columns. ${EMAIL_CONFIGURED ? '<b style="color:#15803d;">LIVE mode</b> — real emails will be sent.' : '<b style="color:#a16207;">SIMULATED mode</b> — logged to the outbox only (set SMTP_* in .env to send for real).'}</div>
      </div>
    </div>
    <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">Blast History</div>
    ${MOD.memos.length ? [...MOD.memos].reverse().map((m) => `
      <div class="glass-card" style="padding:12px 14px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(m.subject)}</div>
          ${pill(m.mode)}
        </div>
        <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:3px;">${esc(m.audienceLabel)} · ${m.recipients} recipient(s) · ${esc(m.ts)} · by ${esc(m.by)}</div>
      </div>`).join("") : emptyState("No memos sent yet.")}
  `;
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
  const { ok, error } = await api("/api/modules/memos", { method: "POST", body: { subject: subj, body, recipientSource: source, includeUnregistered, course, year, audienceLabel: audLabel } });
  if (!ok) { showToast(`❌ ${error || "Could not send memo."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`📧 Memo ${EMAIL_CONFIGURED ? "sent" : "simulated"}.`);
  await loadModule("memos"); renderMemo();
}
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
  await loadNotifs();
  renderBellPanel();
  positionBellPanel();
  p.style.display = "block";
}
function positionBellPanel() {
  const panel = document.getElementById("bellPanel");
  const toggle = document.querySelector(".page.active #adminBellToggle") || document.querySelector(".page.active #studentBellToggle") || document.getElementById("bellToggle");
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
  if (!pending.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `
    <div class="glass-card" style="overflow:hidden;border:1px solid rgba(245,197,24,.45);">
      <div style="padding:16px 20px;border-bottom:1px solid rgba(139,26,26,.1);display:flex;align-items:center;gap:8px;">
        <span style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-user-clock" style="color:#C8890F;margin-right:8px;"></i>Account Approvals</span>
        <span style="font-size:10px;font-weight:800;background:rgba(245,197,24,.2);border:1px solid rgba(212,160,23,.5);color:#7a4f00;border-radius:99px;padding:3px 9px;">${pending.length} pending</span>
      </div>
      <div style="padding:8px 20px 14px;">
        ${pending.map((u) => `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid rgba(139,26,26,.06);">
            <div>
              <div style="font-size:13px;font-weight:800;color:#1a0505;">${esc(u.name)}</div>
              <div style="font-size:11px;font-family:monospace;color:rgba(30,5,5,.6);">${esc(u.id)} · ${esc(u.email)} · ${esc(u.course || "")} ${esc(u.year || "")}</div>
            </div>
            <div style="display:flex;gap:6px;">
              <button onclick="acctApprove('${esc(u.id)}')" style="background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:#15803d;font-weight:800;padding:7px 14px;border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-check" style="margin-right:4px;"></i>Approve</button>
              <button onclick="acctReject('${esc(u.id)}')" style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#b91c1c;font-weight:800;padding:7px 14px;border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-xmark" style="margin-right:4px;"></i>Reject</button>
            </div>
          </div>`).join("")}
      </div>
    </div>`;
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
    const toggle = document.querySelector(".page.active #adminBellToggle") || document.querySelector(".page.active #studentBellToggle");
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
    if (overlay) overlay.style.display = "none";
  }

window.doForgotPassword = function doForgotPassword() {
  window.location.assign("/forgot-password");
}

})();


async function loadSystemPage() {
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Insights & System is restricted to Super Admin.", "rgba(139,26,26,.9)"); const box0 = document.getElementById("systemBody"); if (box0) box0.innerHTML = `<div class="empty-state" style="padding:24px;">Restricted to Super Admin.</div>`; return; }
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
  const [analytics, faq] = await Promise.all([api("/api/reports/analytics"), api("/api/faq-analytics")]);
  window.__qrsAnalytics = analytics.ok ? analytics.data : null;
  window.__qrsFaqUsage = faq.ok ? faq.data : null;
  window.__qrsSystemLoadedAt = new Date();
  renderSystemPage();
}
function renderSystemPage() {
  const box = document.getElementById("systemBody");
  if (!box) return;
  const a = window.__qrsAnalytics;
  const f = window.__qrsFaqUsage;
  const loadedAt = window.__qrsSystemLoadedAt ? window.__qrsSystemLoadedAt.toLocaleString() : "";
  const sum = (items) => (items || []).reduce((t, x) => t + (Number(x.count) || 0), 0);
  const totalStudents = a ? sum(a.byCourse) : 0;
  const totalAppointments = a ? sum(a.services) : 0;
  const totalQueries = f ? (Number(f.totalQueries) || 0) : 0;
  const asst = a && a.assistant ? a.assistant : null;
  const asstTotal = asst && asst.queries ? (Number(asst.queries.total) || 0) : 0;
  const asstHigh = asst && asst.queries ? (Number(asst.queries.high) || 0) : 0;
  const answerRate = asstTotal ? Math.round((asstHigh / asstTotal) * 100) : 0;
  const palette = ["#8B1A1A", "#D4A017", "#15803d", "#1d4ed8", "#7c3aed", "#0e7490", "#b45309", "#be123c"];
  const barList = (items, opts) => {
    const o = opts || {};
    const list = [...(items || [])].sort((x, y) => (Number(y.count) || 0) - (Number(x.count) || 0));
    if (!list.length) return `<div class="empty-state" style="padding:22px 12px;"><i class="fa-solid fa-chart-column"></i>${esc(o.empty || "No data yet.")}</div>`;
    const max = Math.max(...list.map((x) => Number(x.count) || 0), 1);
    const shown = o.limit ? list.slice(0, o.limit) : list;
    return `<div class="insight-bars">${shown.map((x, i) => {
      const pct = Math.max(4, Math.round(((Number(x.count) || 0) / max) * 100));
      const color = palette[i % palette.length];
      return `<div class="insight-bar-row" title="${esc(x.label)} — ${esc(x.count)}">
        <div class="insight-bar-top"><span class="insight-bar-label">${i < 3 ? `<span class="insight-rank">${i + 1}</span>` : ""}${esc(x.label)}</span><b class="insight-bar-count">${esc(x.count)}</b></div>
        <div class="insight-track"><div class="insight-fill" style="width:${pct}%;background:linear-gradient(90deg,${color},${color}cc);"></div></div>
        ${x.sub ? `<div class="insight-bar-sub">${esc(x.sub)}</div>` : ""}
      </div>`;
    }).join("")}</div>${list.length > shown.length ? `<div class="insight-more">+ ${list.length - shown.length} more — export CSV for the full breakdown</div>` : ""}`;
  };
  const kpi = (accent, icon, label, value, sub) => `<div class="stat-card ${accent}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div class="input-label" style="margin-bottom:0;">${esc(label)}</div>
        <span class="insight-kpi-icon"><i class="fa-solid ${icon}"></i></span>
      </div>
      <div style="font-size:38px;font-weight:900;color:#1a0505;margin:8px 0 2px;line-height:1;">${esc(value)}</div>
      <div style="font-size:11px;color:rgba(30,5,5,.68);">${sub}</div>
    </div>`;
  const sectionHead = (icon, title, sub, actions) => `<div class="insight-head">
      <div class="insight-title-wrap"><span class="insight-icon"><i class="fa-solid ${icon}"></i></span>
        <div><div class="insight-title">${esc(title)}</div><div class="insight-sub">${sub}</div></div>
      </div>
      ${actions ? `<div class="insight-actions">${actions}</div>` : ""}
    </div>`;
  const matches = (f && f.matches) || [];
  const faqBars = matches.map((x) => ({ label: x.question, count: x.count, sub: /unmatched/i.test(x.question || "") ? "No FAQ match — consider adding one" : "Matched FAQ query" }));
  const topUnanswered = (asst && asst.topUnanswered) || [];
  box.innerHTML = `
  <div class="insight-meta">
    <span class="badge badge-ready"><i class="fa-solid fa-lock" style="margin-right:5px;"></i>Super Admin only</span>
    ${loadedAt ? `<span class="insight-updated"><i class="fa-solid fa-rotate-right" style="margin-right:5px;"></i>Updated ${esc(loadedAt)}</span>` : ""}
    <span style="flex:1;"></span>
    <button class="btn-ghost" onclick="loadSystemPage()" style="padding:7px 14px;font-size:12px;"><i class="fa-solid fa-arrows-rotate" style="margin-right:6px;"></i>Refresh</button>
    ${a ? `<button class="btn-maroon" onclick="printAnalyticsReport(window.__qrsAnalytics)" style="padding:7px 14px;font-size:12px;"><i class="fa-solid fa-print" style="margin-right:6px;"></i>Print / PDF</button>` : ""}
  </div>
  <div class="grid-4 insight-kpis">
    ${kpi("ac-maroon", "fa-user-graduate", "Students tracked", totalStudents.toLocaleString(), a ? `${(a.byCourse || []).length} courses represented` : "Analytics unavailable")}
    ${kpi("ac-gold", "fa-calendar-check", "Appointments logged", totalAppointments.toLocaleString(), a ? `${(a.services || []).length} service lanes` : "Analytics unavailable")}
    ${kpi("ac-green", "fa-robot", "Chatbot queries", totalQueries.toLocaleString(), matches.length ? `Top: ${esc(String(matches[0].question).slice(0, 42))}${String(matches[0].question).length > 42 ? "…" : ""}` : "From Student Service Help")}
    ${kpi("ac-blue", "fa-wand-magic-sparkles", "Assistant answer rate", asstTotal ? `${answerRate}%` : "—", asstTotal ? `${asstHigh} of ${asstTotal} high-confidence` : "No assistant traffic yet")}
  </div>
  <div class="glass-card insight-card">
    ${sectionHead("fa-chart-column", "Reports & Analytics", "Service trends at a glance — export an official CSV for records.", `<button class="btn-soft" onclick="window.open('/api/reports/export?type=appointments','_blank')" style="padding:7px 14px;font-size:12px;"><i class="fa-solid fa-file-csv" style="margin-right:6px;"></i>Appointments CSV</button><button class="btn-soft" onclick="window.open('/api/reports/export?type=complaints','_blank')" style="padding:7px 14px;font-size:12px;"><i class="fa-solid fa-file-csv" style="margin-right:6px;"></i>Complaints CSV</button>`)}
    ${a ? `<div class="insight-grid">
      <div class="insight-panel"><div class="insight-panel-title"><i class="fa-solid fa-graduation-cap"></i>Students by course</div>${barList(a.byCourse, { limit: 6, empty: "No students grouped by course yet." })}</div>
      <div class="insight-panel"><div class="insight-panel-title"><i class="fa-solid fa-layer-group"></i>Students by year level</div>${barList(a.byYear, { empty: "No students grouped by year yet." })}</div>
      <div class="insight-panel"><div class="insight-panel-title"><i class="fa-solid fa-concierge-bell"></i>Appointments by service</div>${barList(a.services, { limit: 7, empty: "No appointments recorded yet." })}</div>
      <div class="insight-panel"><div class="insight-panel-title"><i class="fa-solid fa-clock"></i>Peak appointment times</div>${barList(a.peakTimes, { limit: 6, empty: "No peak-time signal yet." })}</div>
    </div>
    <div class="info-box" style="margin-top:14px;"><i class="fa-solid fa-circle-info" style="margin-right:6px;"></i>Bars are ranked by volume. For audits and month-end reports, use the CSV exports above — they carry the complete dataset.</div>`
    : `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i>Could not load analytics. Check your connection, then press Refresh.</div>`}
  </div>
  ${asst ? `<div class="glass-card insight-card">
    ${sectionHead("fa-brain", "Assistant Effectiveness", "How much the chatbot resolves on its own vs escalates to a ticket.", "")}
    <div class="insight-mini-grid">
      <div class="insight-mini"><div class="input-label" style="margin-bottom:0;">High confidence</div><div class="insight-mini-value" style="color:#15803d;">${esc(asst.queries.high)}</div><div class="insight-mini-sub">Auto-answered</div></div>
      <div class="insight-mini"><div class="input-label" style="margin-bottom:0;">Medium</div><div class="insight-mini-value" style="color:#b45309;">${esc(asst.queries.medium)}</div><div class="insight-mini-sub">Clarified first</div></div>
      <div class="insight-mini"><div class="input-label" style="margin-bottom:0;">Low / escalated</div><div class="insight-mini-value" style="color:#991b1b;">${esc(asst.queries.low)}</div><div class="insight-mini-sub">Sent to help desk</div></div>
      <div class="insight-mini"><div class="input-label" style="margin-bottom:0;">Data-grounded answers</div><div class="insight-mini-value" style="color:#1d4ed8;">${esc(asst.dataAnswers)}</div><div class="insight-mini-sub">${esc(asst.ticketsFromChat)} tickets came from chat</div></div>
    </div>
    <div class="insight-panel" style="margin-top:14px;"><div class="insight-panel-title"><i class="fa-solid fa-circle-question"></i>Top unanswered questions <span class="insight-hint">— feed these into new FAQs</span></div>
      ${topUnanswered.length ? `<div class="insight-bars">${topUnanswered.slice(0, 5).map((x) => `<div class="insight-bar-row"><div class="insight-bar-top"><span class="insight-bar-label">${esc(x.question || x.q || "Unknown question")}</span><b class="insight-bar-count">${esc(x.count)}</b></div></div>`).join("")}</div>` : `<div style="font-size:12px;color:rgba(30,5,5,.6);padding:6px 2px;">No unanswered clusters — the knowledge base is covering current demand.</div>`}
    </div>
  </div>` : ""}
  <div class="glass-card insight-card">
    ${sectionHead("fa-comments", "FAQ Chatbot Usage", "What students actually ask in Student Service Help.", f ? `<span class="insight-pill">${esc(totalQueries)} total</span>` : "")}
    ${f ? barList(faqBars, { limit: 8, empty: "No chatbot questions recorded yet." }) : `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i>Could not load FAQ usage.</div>`}
  </div>
  <div class="layout-2c" style="align-items:start;">
    <div class="glass-card insight-card" style="margin-bottom:0;">
      ${sectionHead("fa-paper-plane", "Email Reminders", "Nudge students with visits in the next 24 hours.", "")}
      <ol class="insight-steps">
        <li><b>1.</b> We find appointments in the next 24 hours.</li>
        <li><b>2.</b> Already-reminded visits are skipped automatically.</li>
        <li><b>3.</b> Each student gets one polite email with time &amp; queue code.</li>
      </ol>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;">
        <button class="btn-maroon" onclick="sendRemindersPage()" style="padding:10px 18px;font-size:12px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Send reminders now</button>
        <span class="insight-hint">You will be asked to confirm first.</span>
      </div>
    </div>
    ${isSuperAdmin() ? `<div class="glass-card insight-card insight-danger" style="margin-bottom:0;">
      ${sectionHead("fa-database", "Backup & Restore", "Download a secure JSON snapshot — or restore from a version-2 file.", `<span class="badge badge-rejected">Irreversible</span>`)}
      <div style="font-size:12px;color:rgba(30,5,5,.7);line-height:1.6;">Restoring replaces <b>all</b> records. Download a fresh backup first, and keep backup files private — they contain student data.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        <button class="btn-soft" onclick="downloadBackup()" style="padding:10px 16px;font-size:12px;"><i class="fa-solid fa-download" style="margin-right:6px;"></i>Download backup</button>
        <button class="btn-maroon" onclick="restoreBackup()" style="padding:10px 16px;font-size:12px;background:linear-gradient(135deg,#991b1b,#6B1212);"><i class="fa-solid fa-clock-rotate-left" style="margin-right:6px;"></i>Restore from backup</button>
      </div>
    </div>` : ""}
  </div>`;
}
async function sendRemindersPage() {
  if (!confirm("Email students with appointments within the next 24 hours?")) return;
  const result = await api("/api/reminders", { method: "POST" });
  showToast(result.ok ? `Sent ${result.data.appointmentEmails} appointment reminders.` : (result.error || "Could not send reminders."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

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
        <div><span class="input-label">Seats / slot</span><input id="svcCap-${esc(k)}" class="glass-input" type="number" min="1" max="50" value="${c.capacity}" oninput="sysMarkDirty();sysSyncSvcSummary('${esc(k)}')"></div>
        <div><span class="input-label">Minutes / visit</span><input id="svcDur-${esc(k)}" class="glass-input" type="number" min="5" max="240" value="${c.durationMin}" oninput="sysMarkDirty();sysSyncSvcSummary('${esc(k)}')"></div>
      </div>
      <div style="margin-top:10px;"><span class="input-label">Offered days</span>
        <div class="sys-days" id="svcDayBtns-${esc(k)}">${dayBtns}</div>
        <input id="svcDays-${esc(k)}" type="hidden" value="${esc(days.join(","))}">
        <div class="sys-hint">Tap days to toggle. At least one day keeps the lane bookable.</div>
      </div>
    </div>`;
  }).join("");
  const field = (label, id, value, hint, extra) => `<div class="sys-field"><span class="input-label">${label}</span><input id="${id}" class="glass-input" value="${esc(value)}" oninput="sysMarkDirty()${extra ? ";" + extra : ""}">${hint ? `<div class="sys-hint">${hint}</div>` : ""}</div>`;
  const numField = (label, id, value, hint, min, max, step) => `<div class="sys-field"><span class="input-label">${label}</span><input id="${id}" class="glass-input" type="number" value="${esc(value)}" ${min != null ? `min="${min}"` : ""} ${max != null ? `max="${max}"` : ""} ${step != null ? `step="${step}"` : ""} oninput="sysMarkDirty()${id.startsWith("setAssistant") ? ";sysSyncAsst()" : ""}">${hint ? `<div class="sys-hint">${hint}</div>` : ""}</div>`;
  const hours = (s.businessHours || []).join(", ");
  const holidays = (s.holidays || []).join(", ");
  const courses = (s.courses || DEFAULT_REGISTRATION_COURSES).join(", ");
  const svcCount = svcEntries.length;
  const slotCount = (s.businessHours || []).length;
  box.innerHTML = `
  <div class="insight-meta">
    <span class="badge badge-ready"><i class="fa-solid fa-lock" style="margin-right:5px;"></i>Super Admin only</span>
    <span class="insight-pill"><i class="fa-solid fa-bell-concierge" style="margin-right:5px;"></i>${svcCount} lanes · ${slotCount} daily slots</span>
    <span style="flex:1;"></span>
    <span id="settingsDirtyDot" class="sys-clean"><i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>No unsaved changes</span>
    <button class="btn-maroon sys-save-btn" onclick="saveSettingsPage()" style="padding:8px 18px;font-size:12px;"><i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>Save all</button>
  </div>
  <nav class="sys-nav" aria-label="Settings sections">
    <a href="#setSecSchedule"><i class="fa-solid fa-calendar-day"></i>Schedule</a>
    <a href="#setSecServices"><i class="fa-solid fa-concierge-bell"></i>Services (${svcCount})</a>
    <a href="#setSecAssistant"><i class="fa-solid fa-robot"></i>Assistant</a>
    <a href="#setSecEmail"><i class="fa-solid fa-envelope"></i>Email &amp; Courses</a>
  </nav>
  <div id="setSecSchedule" class="glass-card insight-card sys-anchor">
    <div class="insight-head">
      <div class="insight-title-wrap"><span class="insight-icon"><i class="fa-solid fa-calendar-day"></i></span>
        <div><div class="insight-title">Schedule &amp; Capacity</div><div class="insight-sub">Business hours drive the booking calendar; the per-slot fallback applies where a service has no override.</div></div>
      </div>
      <span class="insight-pill" id="hoursCountPill">${slotCount} slots</span>
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
  <div id="setSecServices" class="glass-card insight-card sys-anchor">
    <div class="insight-head">
      <div class="insight-title-wrap"><span class="insight-icon"><i class="fa-solid fa-sliders"></i></span>
        <div><div class="insight-title">Per-Service Slots</div><div class="insight-sub">Seats, visit length, and offered weekdays per service lane. Changes apply to future bookings.</div></div>
      </div>
      <span class="insight-pill">${svcCount} lanes</span>
    </div>
    ${svcCards ? `<div class="sys-svc-grid">${svcCards}</div>` : `<div class="empty-state" style="padding:22px;"><i class="fa-solid fa-inbox"></i>No service lanes configured.</div>`}
  </div>
  <div id="setSecAssistant" class="glass-card insight-card sys-anchor">
    <div class="insight-head">
      <div class="insight-title-wrap"><span class="insight-icon"><i class="fa-solid fa-robot"></i></span>
        <div><div class="insight-title">AI Assistant</div><div class="insight-sub">Confidence thresholds for chatbot answers. Lower values answer more (risking misses); higher values escalate to tickets more often.</div></div>
      </div>
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
  <div id="setSecEmail" class="glass-card insight-card sys-anchor">
    <div class="insight-head">
      <div class="insight-title-wrap"><span class="insight-icon"><i class="fa-solid fa-envelope"></i></span>
        <div><div class="insight-title">Registration &amp; Email</div><div class="insight-sub">Who can register, and what every outgoing email looks like.</div></div>
      </div>
    </div>
    <div style="display:grid;gap:12px;">
      <div class="sys-field"><span class="input-label">Available registration courses (comma-separated)</span>
        <input id="setCourses" class="glass-input" value="${esc(courses)}" oninput="sysMarkDirty();sysPreviewList('setCourses','coursesPreview',',',null,'course')">
        <div id="coursesPreview" class="sys-chips"></div>
      </div>
      <div class="sys-field"><span class="input-label">Email template</span>
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
  <div class="sys-savebar">
    <span id="settingsDirtyDotBottom" class="sys-clean"><i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>No unsaved changes</span>
    <span id="settingsSaveMsg" class="sys-save-msg"></span>
    <span style="flex:1;"></span>
    <button class="btn-ghost sys-save-btn" onclick="renderSettingsPage()" style="padding:10px 18px;font-size:12px;">Discard</button>
    <button class="btn-maroon sys-save-btn" onclick="saveSettingsPage()" style="padding:10px 22px;font-size:13px;"><i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>Save settings</button>
  </div>`;
  sysPreviewList("setHours", "hoursPreview", ",", "hoursCountPill", "slot");
  sysPreviewList("setHolidays", "holidaysPreview", ",", null, "closed date");
  sysPreviewList("setCourses", "coursesPreview", ",", null, "course");
  svcEntries.forEach(([k]) => sysSyncSvcSummary(k));
  sysSyncAsst();
  sysUpdateEmailPreview();
}
function sysMarkDirty() {
  window.__qrsSettingsDirty = true;
  ["settingsDirtyDot", "settingsDirtyDotBottom"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.className = "sys-dirty"; el.innerHTML = `<i class="fa-solid fa-circle" style="margin-right:5px;font-size:8px;"></i>Unsaved changes`; }
  });
}
function sysMarkClean() {
  window.__qrsSettingsDirty = false;
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
    };
    const result = await api("/api/settings", { method: "PUT", body });
    if (msg) { msg.textContent = result.ok ? "Saved ✓" : (result.error || "Could not save settings."); msg.className = "sys-save-msg" + (result.ok ? " ok" : " err"); }
    showToast(result.ok ? "System settings saved." : (result.error || "Could not save settings."), result.ok ? undefined : "rgba(155,22,22,.85)");
    if (result.ok) { sysMarkClean(); renderSettingsPage(); return; }
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
var mlQuery = "";
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
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Masterlist Manager is restricted to Super Admin.", "rgba(139,26,26,.9)"); const box0 = document.getElementById("masterlistBody"); if (box0) box0.innerHTML = `<div class="empty-state" style="padding:24px;">Restricted to Super Admin.</div>`; return; }
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
function masterlistFilteredList() {
  const all = window.__qrsMasterlist || [];
  const scoped = mlScope ? all.filter((e) => e.schoolYear === mlScope.schoolYear && e.course === mlScope.course && e.year === mlScope.year) : all;
  const q = (mlQuery || "").trim().toLowerCase();
  if (!q) return scoped;
  return scoped.filter((e) => (e.sn || "").toLowerCase().includes(q) || (e.name || "").toLowerCase().includes(q) || (e.email || "").toLowerCase().includes(q) || (e.course || "").toLowerCase().includes(q));
}
function renderMasterlistPage() {
  const box = document.getElementById("masterlistBody");
  if (!box) return;
  const scopeArg = scopeArgOf(mlScope);
  const scopeBanner = mlScope
    ? `<div class="glass-card" style="padding:14px 18px;margin-bottom:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;">
        <div><div style="font-size:14px;font-weight:800;color:#1a0505;">${esc(mlScope.schoolYear)} · ${esc(mlScope.course)} · ${esc(mlScope.year)}</div>
        <div id="mlScopeCount" style="font-size:11px;color:rgba(30,5,5,.6);"></div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-soft" onclick="openAccountsPage('groups')"><i class="fa-solid fa-arrow-left"></i> Groups</button>
          <label class="btn-soft" style="cursor:pointer;"><i class="fa-solid fa-file-import"></i> Import CSV for this group<input type="file" accept=".csv" style="display:none;" onchange="handleGroupCSV(this,'${esc(mlScope.schoolYear)}','${esc(mlScope.course)}','${esc(mlScope.year)}')"></label>
          <button class="btn-soft" onclick="clearMasterlistScope()">View all</button>
        </div>
      </div>`
    : "";
  box.innerHTML = `${scopeBanner}
    <div class="glass-card" style="overflow:hidden;">
      <div style="padding:18px 20px 14px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-users-rectangle" style="color:#D4A017;margin-right:8px;"></i>Students <span id="mlCount" style="font-size:11px;font-weight:700;color:rgba(30,5,5,.55);"></span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <div style="position:relative;">
            <i class="fa-solid fa-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:rgba(30,5,5,.55);font-size:11px;"></i>
            <input id="mlSearch" type="text" placeholder="Search student no., name, or course…" class="glass-input" style="padding-left:30px;padding-top:6px;padding-bottom:6px;font-size:12px;width:230px;" value="${esc(mlQuery)}" oninput="filterMasterlistPage(this.value)"/>
          </div>
          <button class="btn-soft" onclick="downloadMasterlistTemplate()" style="padding:7px 14px;font-size:12px;" title="Download the fill-in CSV sheet"><i class="fa-solid fa-file-arrow-down"></i> Template</button>
          <button class="btn-soft" onclick="openMasterlistBulkAdd()" style="padding:7px 14px;font-size:12px;" title="Add many entries from a filled sheet"><i class="fa-solid fa-file-arrow-up"></i> Bulk add</button>
          <button class="btn-maroon" onclick="openMasterlistEditor(null, ${scopeArg})" style="padding:7px 14px;font-size:12px;"><i class="fa-solid fa-user-plus"></i> Add entry</button>
        </div>
      </div>
      <div id="mlSelectBar" style="display:none;padding:10px 20px;background:rgba(139,26,26,.05);border-top:1px solid rgba(139,26,26,.1);align-items:center;gap:10px;flex-wrap:wrap;">
        <span id="mlSelectCount" style="font-size:12px;font-weight:800;color:#1a0505;"></span>
        <button class="btn-maroon" onclick="openRegisterAccountsModal()" style="padding:6px 14px;font-size:12px;border-radius:10px;"><i class="fa-solid fa-user-check"></i> Register accounts</button>
        <button class="btn-ghost" onclick="clearMlSelection()" style="padding:6px 14px;font-size:12px;border-radius:10px;">Clear</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="glass-table" style="min-width:860px;">
          <thead><tr><th style="width:36px;"><input type="checkbox" id="mlSelectPage" onchange="toggleMlSelectPage(this.checked)" title="Select unregistered rows on this page" style="accent-color:#8B1A1A;cursor:pointer;"></th><th>Student No.</th><th>Name</th><th>Email</th><th>Course / Year</th><th>School Year</th><th>Account</th><th style="text-align:right;">Actions</th></tr></thead>
          <tbody id="masterlistTableBody"></tbody>
        </table>
        <div id="masterlistTableEmpty" class="empty-state" style="display:none;"><i class="fa-solid fa-inbox"></i>No matching entries.</div>
      </div>
      <div id="masterlistPagination" class="table-pagination-bar"></div>
    </div>`;
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
  const countEl = document.getElementById("mlCount");
  if (countEl) countEl.textContent = `— ${list.length} student${list.length === 1 ? "" : "s"}`;
  const scopeCount = document.getElementById("mlScopeCount");
  if (scopeCount) scopeCount.textContent = `${list.length} student${list.length === 1 ? "" : "s"} in this group.`;
  const empty = document.getElementById("masterlistTableEmpty");
  tbody.innerHTML = items.map((e) => `<tr>
      <td>${e.registered ? "" : `<input type="checkbox" ${mlSelected.has(e.sn) ? "checked" : ""} onchange="toggleMlSelect('${esc(e.sn)}', this.checked)" title="Select ${esc(e.sn)}" style="accent-color:#8B1A1A;cursor:pointer;">`}</td>
      <td style="font-weight:800;font-family:monospace;font-size:12px;">${esc(e.sn)}</td>
      <td style="font-weight:700;">${esc(e.name || "—")}</td>
      <td style="font-size:12px;">${esc(e.email || "—")}</td>
      <td style="font-size:12px;">${esc(e.course || "—")}${e.year ? ` · ${esc(e.year)}` : ""}</td>
      <td style="font-size:12px;">${esc(e.schoolYear || "—")}</td>
      <td>${e.registered ? `<span title="${esc(e.account?.name || e.name || "")} · ${esc(e.account?.email || "")}" style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:99px;background:rgba(22,163,74,.12);color:#15803d;white-space:nowrap;"><i class="fa-solid fa-circle-check" style="margin-right:4px;"></i>Registered</span>` : `<span style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:99px;background:rgba(107,114,128,.12);color:#4b5563;white-space:nowrap;">Not registered</span>`}</td>
      <td style="text-align:right;white-space:nowrap;">${e.registered ? "" : `<button class="btn-ghost" style="padding:5px 12px;font-size:11px;border-radius:9px;color:#15803d;" onclick="openRegisterAccountModal('${esc(e.sn)}')">Register</button>`}<button class="btn-ghost" onclick="openMasterlistEditor('${esc(e.sn)}', ${scopeArg})" style="padding:5px 12px;font-size:11px;border-radius:9px;">Edit</button>
      <button class="btn-ghost" style="padding:5px 12px;font-size:11px;border-radius:9px;color:#b91c1c;" onclick="removeMasterlistEntry('${esc(e.sn)}', ${scopeArg})">Remove</button></td>
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
  openAppModal({ title: e ? "Edit Masterlist Entry" : "Add Masterlist Entry", subtitle: e ? "Update this student's masterlist record." : scope ? `Add a student to ${scope.schoolYear} · ${scope.course} · ${scope.year}.` : "Add a single student to the masterlist.", icon: "fa-user-pen", content: `<div class="app-modal-grid">${modalField("Student number", "mlSn", e?.sn || "", "full")}${modalField("Full name", "mlName", e?.name || "")}${modalField("Email", "mlEmail", e?.email || "")}${modalField("Course", "mlCourse", e?.course || scope?.course || "")}${modalField("Year level", "mlYear", e?.year || scope?.year || "")}${schoolYearField("mlSchoolYear", e?.schoolYear || scope?.schoolYear || "")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Back</button><button class="btn-maroon" onclick="saveMasterlistEntry('${e?.sn || ""}', ${scopeArg})">${e ? "Save changes" : "Add entry"}</button></div>` });
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
  openAppModal({ title: "Remove Masterlist Entry", subtitle: `Remove ${sn} from the masterlist? This does not delete any registered account.`, icon: "fa-user-xmark", content: `<div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="confirmRemoveMasterlistEntry('${esc(sn)}', ${scopeArg})">Remove</button></div>` });
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
      <div class="app-modal-grid"><div class="app-field full"><label for="regTempPw">Temporary password</label><div style="display:flex;gap:8px;"><div style="position:relative;flex:1;"><input id="regTempPw" type="password" class="glass-input" style="padding-right:38px;" placeholder="At least 10 characters"><button type="button" onclick="togglePass('regTempPw',this)" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(30,5,5,.55);cursor:pointer;font-size:13px;" aria-label="Toggle"><i class="fa-solid fa-eye"></i></button></div><button type="button" class="btn-soft" onclick="mlGenPassword('regTempPw')" style="padding:8px 14px;font-size:12px;white-space:nowrap;"><i class="fa-solid fa-dice"></i> Generate</button></div><div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Share this with the student — they should change it after signing in. A copy is also emailed to them.</div></div></div>
      <div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Back</button><button class="btn-maroon" onclick="confirmRegisterAccounts(['${esc(e.sn)}'], 'regTempPw')">Register account</button></div>`,
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
      <div class="app-modal-grid"><div class="app-field full"><label for="regTempPwBulk">Temporary password (shared)</label><div style="display:flex;gap:8px;"><div style="position:relative;flex:1;"><input id="regTempPwBulk" type="password" class="glass-input" style="padding-right:38px;" placeholder="At least 10 characters"><button type="button" onclick="togglePass('regTempPwBulk',this)" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(30,5,5,.55);cursor:pointer;font-size:13px;" aria-label="Toggle"><i class="fa-solid fa-eye"></i></button></div><button type="button" class="btn-soft" onclick="mlGenPassword('regTempPwBulk')" style="padding:8px 14px;font-size:12px;white-space:nowrap;"><i class="fa-solid fa-dice"></i> Generate</button></div><div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Share this with the students — a copy is also emailed to each of them.</div></div></div>
      <div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Back</button><button class="btn-maroon" onclick="confirmRegisterAccounts(null, 'regTempPwBulk')">Register ${list.length} account${list.length === 1 ? "" : "s"}</button></div>`,
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
      content: `<div style="font-size:12px;color:rgba(30,5,5,.75);line-height:1.7;">${lines}${skipped.length > 8 ? `<br>…and ${skipped.length - 8} more.` : ""}</div><div class="app-modal-actions"><button class="btn-maroon" onclick="closeAppModal()">Done</button></div>`,
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
  if (!isSuperAdmin()) { showToast("\u26a0\ufe0f Accounts & Access is restricted to Super Admin.", "rgba(139,26,26,.9)"); const box0 = document.getElementById("accountsBody"); if (box0) box0.innerHTML = `<div class="empty-state" style="padding:24px;">Restricted to Super Admin.</div>`; return; }
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
  const tabs = visibleAccountsTabs().map((t) => `<button onclick="setAccountsTab('${t.id}')" class="btn-${accountsTab === t.id ? "maroon" : "ghost"}" style="padding:8px 14px;font-size:12px;"><i class="fa-solid ${t.icon}" style="margin-right:6px;"></i>${esc(t.label)}</button>`).join("");
  box.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">${tabs}</div><div id="accountsTabBody"></div>`;
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
  const rows = list.length ? list.map((p) => `<div class="app-row"><div><div class="app-row-title">${esc(p.name)} <span class="app-row-meta">(${esc(p.studentId)})</span></div><div class="app-row-meta">${esc(p.email)} · ${esc(p.course || "No course")} · ${esc(p.year || "No year level")}</div></div><div style="display:flex;gap:7px"><button class="btn-soft" onclick="resolveProfileChange('${esc(p.id)}','Rejected')">Reject</button><button class="btn-maroon" onclick="resolveProfileChange('${esc(p.id)}','Approved')">Approve</button></div></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No profile updates awaiting review.</span></div>`;
  return `<div class="glass-card" style="padding:22px;"><div style="font-size:15px;font-weight:800;color:#1a0505;margin-bottom:4px;"><i class="fa-solid fa-user-check" style="color:#D4A017;margin-right:8px;"></i>Profile Verification</div><div style="font-size:11px;color:rgba(30,5,5,.62);margin-bottom:12px;">Approve or reject student updates before their profile is changed.</div><div class="app-list">${rows}</div></div>`;
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
  return `<div class="glass-card" style="overflow:hidden;">
    <div style="padding:18px 20px 14px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;">
      <div style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-user-graduate" style="color:#D4A017;margin-right:8px;"></i>Student Accounts <span id="saCount" style="font-size:11px;font-weight:700;color:rgba(30,5,5,.55);"></span></div>
      <div style="position:relative;">
        <i class="fa-solid fa-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:rgba(30,5,5,.55);font-size:11px;"></i>
        <input id="saSearch" type="text" placeholder="Search student no., name, or email…" class="glass-input" style="padding-left:30px;padding-top:6px;padding-bottom:6px;font-size:12px;width:230px;" value="${esc(accountsQuery)}" oninput="filterAccountsStudents(this.value)"/>
      </div>
    </div>
    <div style="overflow-x:auto;"><table class="glass-table" style="min-width:760px;">
      <thead><tr><th>Name</th><th>Student No.</th><th>Email</th><th>Masterlist</th><th>Status</th><th style="text-align:right;">Action</th></tr></thead>
      <tbody id="saTableBody"></tbody>
    </table><div id="saTableEmpty" class="empty-state" style="display:none;"><i class="fa-solid fa-inbox"></i>No matching student accounts.</div></div>
    <div id="saPagination" class="table-pagination-bar"></div>
  </div>`;
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
  if (countEl) countEl.textContent = `— ${list.length} registered student${list.length === 1 ? "" : "s"}`;
  const empty = document.getElementById("saTableEmpty");
  tbody.innerHTML = items.map((u) => `<tr>
      <td style="font-weight:700;">${esc(u.name)}</td>
      <td style="font-family:monospace;font-size:12px;">${esc(u.studentId || "")}</td>
      <td style="font-size:12px;">${esc(u.email)}${u.course ? `<div style="font-size:11px;color:rgba(30,5,5,.55);">${esc(u.course)} ${esc(u.year || "")}</div>` : ""}</td>
      <td>${u.masterlistLinked ? `<span title="${esc(u.masterlist?.course || "")} ${esc(u.masterlist?.year || "")} · ${esc(u.masterlist?.schoolYear || "")}" style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:99px;background:rgba(22,163,74,.12);color:#15803d;white-space:nowrap;"><i class="fa-solid fa-link" style="margin-right:4px;"></i>Linked</span>` : `<span title="No masterlist record for this student number" style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:99px;background:rgba(180,130,0,.12);color:#a16207;white-space:nowrap;">Not listed</span>`}</td>
      <td><span style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:99px;${u.active ? "background:rgba(22,163,74,.12);color:#15803d;" : "background:rgba(220,38,38,.10);color:#b91c1c;"}">${u.active ? "Active" : "On Hold"}</span></td>
      <td style="text-align:right;"><button class="btn-ghost" style="padding:5px 12px;font-size:11px;border-radius:9px;${u.active ? "color:#b91c1c;" : "color:#15803d;"}" onclick="toggleStudentHold('${esc(u.studentId)}', ${!u.active})">${u.active ? "Put on hold" : "Reactivate"}</button></td>
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
  const rows = list.length ? list.map((u) => `<tr>
      <td style="font-weight:700;">${esc(u.name)}</td>
      <td style="font-size:12px;">${esc(u.email)}</td>
      <td>${pill(u.role)}</td>
      <td style="font-size:12px;">${u.active ? "Active" : "Deactivated"}</td>
      <td style="text-align:right;"><button class="btn-ghost" onclick="openStaffEditor('${esc(u.id)}')" style="padding:5px 12px;font-size:11px;border-radius:9px;">Edit</button></td>
    </tr>`).join("") : `<tr><td colspan="5" style="text-align:center;color:rgba(30,5,5,.56);padding:16px;">No staff accounts yet.</td></tr>`;
  return `<div class="glass-card" style="overflow:hidden;">
    <div style="padding:18px 20px 14px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;">
      <div style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-user-shield" style="color:#D4A017;margin-right:8px;"></i>Staff Accounts</div>
      <button class="btn-maroon" onclick="openStaffEditor()" style="padding:7px 14px;font-size:12px;"><i class="fa-solid fa-user-plus"></i> Add staff account</button>
    </div>
    <div style="overflow-x:auto;"><table class="glass-table" style="min-width:640px;">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th style="text-align:right;">Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}
function accountsOrgsHtml() {
  const orgs = window.__qrsOrganizations || [];
  const cards = orgs.length ? orgs.map((org) => {
    const reps = (org.representatives || []).map((rep) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid rgba(139,26,26,.08);font-size:11px;"><span><b>${esc(rep.studentId)}</b> ${rep.active ? "<span style='color:#16803c;'>Active</span>" : "<span style='color:#a11;'>Revoked</span>"}${rep.expiresAt ? ` · until ${new Date(rep.expiresAt).toLocaleDateString()}` : ""}</span><button class="btn-soft" style="padding:3px 8px;font-size:10px;" onclick="setOrganizationRep('${rep.id}',${!rep.active})">${rep.active ? "Revoke" : "Reactivate"}</button></div>`).join("") || `<div style="font-size:11px;color:rgba(30,5,5,.55);padding-top:6px;">No representative assigned.</div>`;
    return `<div class="glass-card" style="padding:16px;margin-bottom:12px;"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;"><div><b style="color:#1a0505;">${esc(org.name)}</b><div style="font-size:11px;color:rgba(30,5,5,.58);margin-top:3px;">Adviser: ${esc(org.adviserName)}${org.schoolYear ? ` · ${esc(org.schoolYear)}` : ""}</div></div><div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn-maroon" style="padding:6px 9px;font-size:11px;" onclick="assignOrganizationRep('${org.id}','${esc(org.name)}')">Assign officer</button><button class="btn-soft" style="padding:6px 9px;font-size:11px;" onclick="setOrganizationActive('${org.id}',${!org.active})">${org.active ? "Deactivate" : "Activate"}</button></div></div><div style="margin-top:8px;">${reps}</div></div>`;
  }).join("") : emptyState("No organizations registered yet.");
  return `<div style="display:flex;justify-content:flex-end;margin-bottom:12px;"><button class="btn-maroon" onclick="createOrganization()" style="padding:8px 14px;font-size:12px;"><i class="fa-solid fa-plus"></i> Register organization</button></div>${cards}`;
}
function accountsGroupsHtml() {
  const list = window.__qrsGroups || [];
  const rows = list.length ? list.map((g) => `<div class="app-row"><div><div class="app-row-title">${esc(g.schoolYear)} · ${esc(g.course)} · ${esc(g.year)}</div><div class="app-row-meta">${g.count} student${g.count === 1 ? "" : "s"} · Owner: ${g.owner ? esc(g.owner.name) : "Unassigned"}</div></div><div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn-soft" onclick="openMasterlistPage({schoolYear:'${esc(g.schoolYear)}',course:'${esc(g.course)}',year:'${esc(g.year)}'})">View students</button><button class="btn-soft" onclick="openGroupOwnerEditor('${esc(g.id || "")}','${esc(g.schoolYear)}','${esc(g.course)}','${esc(g.year)}','${esc(g.owner?.id || "")}')">Assign owner</button></div></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No groups yet.</span></div>`;
  return `<div class="glass-card" style="padding:22px;"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:4px;"><div style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-layer-group" style="color:#D4A017;margin-right:8px;"></i>Masterlist Groups</div><button class="btn-maroon" onclick="addMasterlistGroupPrompt()" style="padding:7px 14px;font-size:12px;"><i class="fa-solid fa-plus"></i> Add group</button></div><div style="font-size:11px;color:rgba(30,5,5,.62);margin-bottom:12px;">Organized by school year, course, and year level, each with an optional owner.</div><div class="app-list">${rows}</div></div>`;
}

async function cancelAppointment(code) {
  openAppModal({ title: "Cancel Appointment", subtitle: `Cancel appointment ${code}? This action follows the cancellation cutoff in System Settings.`, icon: "fa-calendar-xmark", content: `<div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Keep appointment</button><button class="btn-maroon" onclick="confirmCancelAppointment('${esc(code)}')">Cancel appointment</button></div>` });
}
async function confirmCancelAppointment(code) {
  const result = await api(`/api/queue/${encodeURIComponent(code)}/cancel`, { method: "DELETE" });
  if (result.ok) { closeAppModal(); await refreshStudentVisitViews(); }
  showToast(result.ok ? "Appointment cancelled." : (result.error || "Could not cancel appointment."), result.ok ? undefined : "rgba(155,22,22,.85)");
}
async function rescheduleAppointment(code) {
  rescheduleCode = code; rescheduleSelectedDate = null; rescheduleSelectedSlot = null;
  rescheduleService = (typeof queueData !== "undefined" && queueData.find((q) => q.q === code)?.service) || "GENERAL";
  rescheduleCalMonth = new Date().getMonth(); rescheduleCalYear = new Date().getFullYear();
  rescheduleAvailability = { bookedTimes: [], myAppointment: null, slots: [] };
  openAppModal({ title: "Reschedule Appointment", subtitle: "Choose a new date and available business-hours time slot.", icon: "fa-calendar-days", wide: true, content: `<div class="app-modal-grid"><div class="app-field full"><label>New date</label><div style="background:rgba(139,26,26,.05);border-radius:14px;padding:16px;margin-top:6px;"><div id="rescheduleCalendar"></div></div></div><div class="app-field full"><label>New time</label><div id="rescheduleDateLabel" style="font-size:11px;color:rgba(30,5,5,.62);margin:6px 0 10px;">Select a date first.</div><div id="rescheduleTimeSlots" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"></div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="confirmRescheduleAppointment()">Save new schedule</button></div>` });
  buildRescheduleCalendar();
}
async function confirmRescheduleAppointment() {
  if (!rescheduleSelectedDate || !rescheduleSelectedSlot) return showToast("Select both a new date and time.", "rgba(180,130,0,.85)");
  const dateLabel = rescheduleDateLabel(rescheduleSelectedDate);
  const result = await api(`/api/queue/${encodeURIComponent(rescheduleCode)}/reschedule`, { method: "POST", body: { dateLabel, time: rescheduleSelectedSlot } });
  if (result.ok) { closeAppModal(); await refreshStudentVisitViews(); }
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
  } else if (page === "page-student") {
    await loadModule("requests"); renderStudentPage();
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
