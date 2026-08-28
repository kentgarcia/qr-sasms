


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


let DB = [];              // document requests
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
let MOD = { referrals: [], idapps: [], bulletins: [], tickets: [], faqs: [], events2: [], complaints: [], forms: [], memos: [] };
let faqCategories = [];
let ADMIN_ACTIVITY = null;
const REQUESTS_PER_PAGE = 5;
let adminRequestPage = 1;
let studentRequestPage = 1;
let lastAdminTableFilterKey = "";
let lastStudentTableFilterKey = "";
let MY_ORGANIZATIONS = [];

async function loadRequests() { const r = await api("/api/requests"); DB = r.ok ? r.data : []; }
async function loadAdminActivity() { const r = await api("/api/admin/activity"); ADMIN_ACTIVITY = r.ok ? r.data : null; }
async function loadQueueData() { const r = await api("/api/queue"); queueData = r.ok ? r.data : []; }
async function loadAuditLog() { const r = await api("/api/audit"); auditLogs = r.ok ? r.data : []; }
async function loadEmailLog() { const r = await api("/api/emails"); EMAIL_LOG = r.ok ? r.data : []; }
async function loadEmailStatus() { const r = await api("/api/emails/status"); EMAIL_CONFIGURED = r.ok ? !!r.data.configured : false; }
async function loadNotifs() { const r = await api("/api/notifications"); NOTIFS = r.ok ? r.data : []; }
async function loadPendingAccounts() { const r = await api("/api/users/pending"); PENDING_ACCOUNTS = r.ok ? r.data : []; }
async function loadModule(key) { const r = await api(`/api/modules/${key}`); MOD[key] = r.ok ? r.data : []; }
async function loadFaqCategories() { const r = await api("/api/modules/faq-categories"); faqCategories = r.ok ? r.data : []; }
async function loadMyOrganizations() { const r = await api("/api/organizations/mine"); MY_ORGANIZATIONS = r.ok ? r.data : []; }

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

const DOC_LABELS = { gmc: "Excuse Slip", auth: "Authentication", other: "Other" };
const DOC_HELPS = { gmc: "📄 Excuse Slip — Requests for leave of absence or excused from classes. Required for employment, further studies, or government transactions.", auth: "🔏 Authentication — Certifies the authenticity of PUP-issued documents for foreign use or apostille.", other: "📁 Other Documents — Please specify in the additional notes field." };
const DOC_REQUIREMENTS = {
  gmc: ["Valid PUP student ID", "Clear purpose for the request"],
  auth: ["Original or clear copy of the document to authenticate", "Valid PUP student ID"],
  other: ["Valid PUP student ID", "Describe the requested document in Additional Notes"],
};


let session = null; // { id, email, name, role, course, year }
let copies = 1;
let selectedDate = null;
let selectedSlot = null;
const appointmentCalendarStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let appointmentCalendarMonth = appointmentCalendarStart.getMonth();
let appointmentCalendarYear = appointmentCalendarStart.getFullYear();
const appointmentDateLabel = (day) => new Date(appointmentCalendarYear, appointmentCalendarMonth, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
let prevPage = null;
let appointmentAvailability = { bookedTimes: [], myAppointment: null };
let rescheduleCode = null;
let rescheduleSelectedDate = null;
let rescheduleSelectedSlot = null;
let rescheduleCalMonth = new Date().getMonth();
let rescheduleCalYear = new Date().getFullYear();
const rescheduleDateLabel = (day) => new Date(rescheduleCalYear, rescheduleCalMonth, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
let rescheduleAvailability = { bookedTimes: [], myAppointment: null };
let qrRenderedFor = null;
let liveEventSource = null;
let liveRefreshAt = 0;
let qrScanner = null;
let qrScannerRunning = false;
let qrClaimBusy = false;
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
  const publicPages = ["page-login", "page-register"];
  if (!publicPages.includes(pageId) && !session) {
    showToast("⚠️ Please sign in first.", "rgba(139,26,26,.9)");
    pageId = "page-login";
  }
  if (session) {
    if (pageId === "page-memo" && !isSuperAdmin()) {
      showToast("⚠️ Email Blast is restricted to Super Admin.", "rgba(139,26,26,.9)"); return;
    }
    if (session.role === "student" && (pageId === "page-admin" || pageId === "page-manage")) {
      showToast("⚠️ Access denied.", "rgba(139,26,26,.9)"); return;
    }
    if ((session.role === "admin" || session.role === "super_admin") && (pageId === "page-student" || pageId === "page-request" || pageId === "page-appointment" || pageId === "page-services")) {
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
  if (pageId === "page-student") { await Promise.all([loadRequests(), loadModule("events2"), loadMyOrganizations()]); renderStudentPage(); }
  if (pageId === "page-admin") {
    await Promise.all([loadRequests(), loadQueueData(), loadAuditLog(), loadEmailLog(), loadEmailStatus(), loadPendingAccounts(), refreshMasterlistStatus(), loadAdminActivity()]);
    renderAdminPage();
  }
  const _bp = document.getElementById("bellPanel"); if (_bp) _bp.style.display = "none";
  if (pageId === "page-appointment") buildCalendar();
  if (pageId === "page-services") renderServicesHub();
  if (pageId === "page-manage") renderManageHub();
  if (pageId === "page-referral") { await loadModule("referrals"); renderReferral(); }
  if (pageId === "page-idapp") { await loadModule("idapps"); renderIdApp(); }
  if (pageId === "page-bulletin") { await loadModule("bulletins"); renderBulletin(); }
  if (pageId === "page-helpdesk") { await Promise.all([loadModule("tickets"), loadModule("faqs")]); renderHelpdesk(); }
  if (pageId === "page-faq") { await Promise.all([loadModule("faqs"), loadFaqCategories()]); renderFaq(); }
  if (pageId === "page-events2") { await Promise.all([loadModule("events2"), isAdmin() ? Promise.resolve() : loadMyOrganizations()]); renderEvents2(); }
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
    student: [{ label: "Dashboard", icon: "fa-house", page: "page-student" }, { label: "New Request", icon: "fa-plus", page: "page-request" }, { label: "Appointments", icon: "fa-calendar", page: "page-appointment" }, { label: "Services", icon: "fa-table-cells-large", page: "page-services" }],
    admin: [{ label: "Dashboard", icon: "fa-gauge", page: "page-admin" }, { label: "Manage", icon: "fa-table-cells-large", page: "page-manage" }],
    scanner: [{ label: "Scanner", icon: "fa-qrcode", page: "page-scanner" }],
  };
  const iconMap = { student: "fa-user-graduate", admin: "fa-shield-halved", scanner: "fa-qrcode" };
  const items = links[role] || links.student;
  const navItems = items.map((l) => `<button onclick="goTo('${l.page}')" class="nav-link ${pageId === l.page ? "active" : ""}"><i class="fa-solid ${l.icon}"></i><span>${l.label}</span></button>`).join("");
  const ctrl = `<div class="sidebar-divider"></div>
    <button onclick="openSettingsMenu()" class="nav-link"><i class="fa-solid fa-gear"></i><span>Settings</span></button>
    <div class="sidebar-user"><div class="sidebar-user-icon"><i class="fa-solid ${iconMap[role]}"></i></div><span>${session.name.split(" ")[0]}</span></div>
    <button onclick="signOut()" class="nav-link sidebar-logout"><i class="fa-solid fa-right-from-bracket"></i><span>Logout</span></button>`;
  document.getElementById("desktopNavLinks").innerHTML = navItems + ctrl;
  updateBellBadge();
  document.getElementById("mobileMenuLinks").innerHTML =
    items.map((l) => `<button onclick="goTo('${l.page}');closeMobileMenu();" class="nav-link" style="justify-content:flex-start;"><i class="fa-solid ${l.icon}" style="font-size:11px;color:#F5C518;"></i>${l.label}</button>`).join("") +
    `<div style="height:1px;background:rgba(255,255,255,.14);margin:10px 0;"></div>` +
    `<button onclick="openSettingsMenu();closeMobileMenu();" class="nav-link" style="justify-content:flex-start;"><i class="fa-solid fa-gear" style="font-size:11px;color:#F5C518;"></i>Settings</button>` +
    `<button onclick="signOut()" class="nav-link" style="color:rgba(239,68,68,.7);justify-content:flex-start;margin-top:4px;"><i class="fa-solid fa-right-from-bracket"></i>Logout</button>`;
}
async function openSettingsMenu() {
  const items = [
    { label: "Account Information", icon: "fa-id-badge", action: "openAccountInfo()" },
    ...(session?.role === "student" ? [{ label: "Edit Profile", icon: "fa-user-pen", action: "requestProfileEdit()" }] : []),
    { label: "Change Password", icon: "fa-key", action: "openChangePassword()" },
  ];
  openAppModal({ title: "Settings", subtitle: "Manage your account.", icon: "fa-gear", content: `<div class="app-list">${items.map((it) => `<div class="app-row"><div class="app-row-title"><i class="fa-solid ${it.icon}" style="color:#8B1A1A;margin-right:8px;"></i>${esc(it.label)}</div><button class="btn-soft" onclick="${it.action}">Open</button></div>`).join("")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button></div>` });
}
function openAccountInfo() {
  const u = session || {};
  const roleLabel = (u.role || "").split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const rows = [
    { label: "Name", value: u.name || "" },
    { label: "Email", value: u.email || "" },
    ...(u.role === "student" ? [{ label: "Student Number", value: u.id || "" }] : []),
    { label: "Role", value: roleLabel },
    ...(u.course ? [{ label: "Course", value: u.course }] : []),
    ...(u.year ? [{ label: "Year Level", value: u.year }] : []),
  ];
  openAppModal({ title: "Account Information", subtitle: "Your account details on file.", icon: "fa-id-badge", content: `<div class="app-list">${rows.map((r) => `<div class="app-row"><div><div class="app-row-title">${esc(r.label)}</div><div class="app-row-meta">${esc(r.value)}</div></div></div>`).join("")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="openSettingsMenu()">Back</button></div>` });
}
function pwField(label, id, extra = "") {
  return `<div class="app-field ${extra}"><label for="${id}">${esc(label)}</label><div style="position:relative;"><input id="${id}" type="password" class="glass-input" style="padding-right:38px;"><button type="button" onclick="togglePass('${id}',this)" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(30,5,5,.55);cursor:pointer;font-size:13px;" aria-label="Toggle"><i class="fa-solid fa-eye"></i></button></div></div>`;
}
function openChangePassword() {
  openAppModal({ title: "Change Password", subtitle: "Choose a new password of at least 6 characters.", icon: "fa-key", content: `<div class="app-modal-grid">${pwField("Current password", "cpCurrent", "full")}${pwField("New password", "cpNew")}${pwField("Confirm new password", "cpConfirm")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="openSettingsMenu()">Back</button><button class="btn-maroon" onclick="submitChangePassword()">Update password</button></div>` });
}
async function submitChangePassword() {
  const currentPassword = document.getElementById("cpCurrent")?.value;
  const newPassword = document.getElementById("cpNew")?.value;
  const confirmPassword = document.getElementById("cpConfirm")?.value;
  if (!currentPassword || !newPassword) return showToast("Enter your current and new password.", "rgba(180,130,0,.85)");
  if (newPassword !== confirmPassword) return showToast("New passwords do not match.", "rgba(180,130,0,.85)");
  const result = await api("/api/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
  if (result.ok) { showToast("Password updated."); return closeAppModal(); }
  showToast(result.error || "Could not update password.", "rgba(155,22,22,.85)");
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


function renderStudentPage() {
  if (!session || session.role !== "student") return;
  document.getElementById("studentWelcomeName").textContent = session.name;

  const myReqs = DB.filter((r) => r.studentId === session.id).sort((a, b) => b.dateSort - a.dateSort);
  const total = myReqs.length;
  const pending = myReqs.filter((r) => r.status === "Pending").length;
  const ready = myReqs.filter((r) => r.status === "Ready to Claim").length;
  document.getElementById("kpiTotal").textContent = total;
  document.getElementById("kpiPending").textContent = pending;
  document.getElementById("kpiReady").textContent = ready;
  renderStudentAppointment();

  const searchEl = document.getElementById("studentSearch");
  if (searchEl) searchEl.value = "";
  const statusEl = document.getElementById("studentStatusFilter");
  if (statusEl) statusEl.value = "";
  renderStudentTable("");
  renderStudentEventStatus();
}

function renderStudentEventStatus() {
  const el = document.getElementById("studentEventStatusCard");
  if (!el || !session) return;
  const mine = (MOD.events2 || []).filter((event) => event.sn === session.id).slice().reverse();
  const eventPage = getModulePage("student-event-status", mine);
  const canSubmitEvent = MY_ORGANIZATIONS.length > 0;
  if (!canSubmitEvent && !mine.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  const eventButton = canSubmitEvent
    ? `<button onclick="goTo('page-events2')" class="btn-maroon" style="padding:8px 12px;font-size:11px;"><i class="fa-solid fa-plus" style="margin-right:5px;"></i>Event Request</button>`
    : `<span style="font-size:11px;color:rgba(30,5,5,.55);">Representative access is inactive</span>`;
  el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;"><div style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-calendar-star" style="color:#D4A017;margin-right:8px;"></i>My Event Requests</div>${eventButton}</div><div style="overflow-x:auto;"><table class="glass-table" style="min-width:580px;"><thead><tr><th>Event</th><th>Organization</th><th>Date</th><th>Status</th><th style="text-align:right;">Action</th></tr></thead><tbody>${mine.length ? eventPage.items.map((event) => `<tr><td style="font-weight:700;">${esc(event.title)}</td><td>${esc(event.org)}</td><td style="font-size:12px;">${esc(event.date)}</td><td>${pill(event.status)}</td><td style="text-align:right;">${event.status === "Needs Revision" ? `<button onclick="evtEditingId='${esc(event.id)}';goTo('page-events2')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">Revise</button>` : `<button onclick="goTo('page-events2')" class="btn-ghost" style="padding:6px 10px;font-size:11px;">View</button>`}</td></tr>`).join("") : `<tr><td colspan="5" style="text-align:center;color:rgba(30,5,5,.56);padding:16px;">No event requests yet.</td></tr>`}</tbody></table></div>${modulePagination("student-event-status", mine.length, "renderStudentEventStatus")}`;
}

async function renderStudentAppointment() {
  const card = document.getElementById("studentAppointmentCard");
  if (!card) return;
  const result = await api("/api/queue?mine=1");
  const appt = result.ok && result.data[0];
  if (!appt) {
    card.innerHTML = `<div class="input-label" style="margin-bottom:12px;"><i class="fa-solid fa-calendar-check" style="color:#D4A017;margin-right:5px;"></i>Next Appointment</div><div style="font-size:12px;color:rgba(30,5,5,.65);text-align:center;padding:12px 0;">No active appointment.</div><button onclick="goTo('page-appointment')" class="btn-ghost" style="width:100%;margin-top:8px;padding:10px;"><i class="fa-solid fa-calendar-plus" style="margin-right:6px;"></i>Book Appointment</button>`;
    return;
  }
  card.innerHTML = `<div class="input-label" style="margin-bottom:12px;"><i class="fa-solid fa-calendar-check" style="color:#D4A017;margin-right:5px;"></i>Next Appointment</div><div style="background:rgba(139,26,26,.5);border:1px solid rgba(245,197,24,.25);border-radius:14px;padding:16px;text-align:center;"><div style="font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(245,197,24,.7);">Appointment Number</div><div style="font-size:32px;font-weight:900;color:#fff;line-height:1.2;">${esc(appt.q)}</div><div style="font-size:12px;color:#fff;margin-top:5px;">${esc(appt.dateLabel)} · ${esc(appt.time)}</div></div><div style="display:flex;gap:7px;margin-top:10px;"><button onclick="rescheduleAppointment('${esc(appt.q)}')" class="btn-ghost" style="flex:1;padding:8px;font-size:11px;">Reschedule</button><button onclick="cancelAppointment('${esc(appt.q)}')" class="btn-ghost" style="flex:1;padding:8px;font-size:11px;color:#b91c1c;">Cancel</button></div>`;
}

async function cancelAppointment(code) {
  if (!confirm(`Cancel appointment ${code}?`)) return;
  const result = await api(`/api/queue/${encodeURIComponent(code)}/cancel`, { method: "DELETE" });
  showToast(result.ok ? "✅ Appointment cancelled." : `❌ ${result.error || "Could not cancel appointment."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
  if (result.ok) renderStudentAppointment();
}

function renderStudentTable(query = "") {
  if (!session) return;
  const q = (query || "").toLowerCase();
  const statusFilter = document.getElementById("studentStatusFilter")?.value || "";
  const myReqs = DB.filter((r) => r.studentId === session.id).sort((a, b) => b.dateSort - a.dateSort);
  const filtered = myReqs.filter((r) => {
    const matchQuery = !q || r.doc.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.status.toLowerCase().includes(q) || r.purpose.toLowerCase().includes(q);
    return matchQuery && (!statusFilter || r.status === statusFilter);
  });
  const filterKey = `${q}|${statusFilter}`;
  if (filterKey !== lastStudentTableFilterKey) {
    studentRequestPage = 1;
    lastStudentTableFilterKey = filterKey;
  }

  const tbody = document.getElementById("studentTable");
  const empty = document.getElementById("studentTableEmpty");
  const pagination = document.getElementById("studentTablePagination");

  if (filtered.length === 0) { tbody.innerHTML = ""; empty.style.display = "block"; if (pagination) pagination.innerHTML = ""; return; }
  empty.style.display = "none";
  const totalPages = Math.ceil(filtered.length / REQUESTS_PER_PAGE);
  studentRequestPage = Math.min(studentRequestPage, totalPages);
  const pageRows = filtered.slice((studentRequestPage - 1) * REQUESTS_PER_PAGE, studentRequestPage * REQUESTS_PER_PAGE);

  tbody.innerHTML = pageRows.map((r) => {
    const bc = badgeClass(r.status);
    const canQR = r.status === "Ready to Claim";
    let actionBtn;
    if (r.status === "Completed") {
      actionBtn = `<div style="display:inline-flex;gap:6px;">
        <button onclick="printReceipt('${r.id}')" class="btn-maroon" style="padding:6px 12px;font-size:12px;border-radius:10px;"><i class="fa-solid fa-print" style="margin-right:5px;"></i>Receipt</button>
        <button onclick="giveFeedback('${r.id}')" class="btn-gold" style="padding:6px 10px;font-size:11px;border-radius:10px;"><i class="fa-solid fa-star" style="margin-right:4px;"></i>Feedback</button>
        <button onclick="showDetail('${r.id}')" class="btn-ghost" style="padding:6px 10px;font-size:12px;border-radius:10px;"><i class="fa-solid fa-eye"></i></button>
      </div>`;
    } else if (r.status === "Rejected") {
      actionBtn = `<button onclick="reuploadRequest('${r.id}')" class="btn-gold" style="padding:6px 12px;font-size:11px;border-radius:10px;"><i class="fa-solid fa-upload" style="margin-right:5px;"></i>Re-upload</button>`;
    } else {
      actionBtn = canQR
        ? `<button onclick="showQR('${r.id}')" class="btn-maroon" style="padding:6px 14px;font-size:12px;border-radius:10px;"><i class="fa-solid fa-qrcode" style="margin-right:5px;"></i>View QR</button>`
        : `<button onclick="showDetail('${r.id}')" class="btn-ghost" style="padding:6px 14px;font-size:12px;border-radius:10px;"><i class="fa-solid fa-eye" style="margin-right:5px;"></i>Details</button>`;
    }
    return `<tr>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${r.id}</span></td>
      <td style="font-weight:700;color:#1a0505;">${r.doc}</td>
      <td style="font-size:12px;color:rgba(30,5,5,.68);">${r.date}</td>
      <td><span class="badge ${bc}">${r.status}</span></td>
      <td style="text-align:right;">${actionBtn}</td>
    </tr>`;
  }).join("");
  renderTablePagination(pagination, studentRequestPage, totalPages, filtered.length, "setStudentRequestPage");
}

function renderTablePagination(container, currentPage, totalPages, totalRows, goToFunction) {
  if (!container) return;
  if (totalPages <= 1) { container.innerHTML = ""; return; }
  const start = (currentPage - 1) * REQUESTS_PER_PAGE + 1;
  const end = Math.min(currentPage * REQUESTS_PER_PAGE, totalRows);
  container.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 2px 0;font-size:11px;color:rgba(30,5,5,.62);">
    <span>Showing ${start}–${end} of ${totalRows}</span>
    <div style="display:flex;align-items:center;gap:6px;">
      <button onclick="${goToFunction}(${currentPage - 1})" ${currentPage === 1 ? "disabled" : ""} class="btn-ghost" style="padding:5px 10px;font-size:11px;${currentPage === 1 ? "opacity:.45;cursor:not-allowed;" : ""}"><i class="fa-solid fa-chevron-left"></i> Previous</button>
      <span style="font-weight:800;color:#8B1A1A;white-space:nowrap;">${currentPage} / ${totalPages}</span>
      <button onclick="${goToFunction}(${currentPage + 1})" ${currentPage === totalPages ? "disabled" : ""} class="btn-ghost" style="padding:5px 10px;font-size:11px;${currentPage === totalPages ? "opacity:.45;cursor:not-allowed;" : ""}">Next <i class="fa-solid fa-chevron-right"></i></button>
    </div>
  </div>`;
}

function setStudentRequestPage(page) {
  studentRequestPage = Math.max(1, page);
  renderStudentTable(document.getElementById("studentSearch")?.value || "");
}

async function reuploadRequest(id) {
  const picker = document.createElement("input");
  picker.type = "file"; picker.accept = ".jpg,.jpeg,.png,.pdf,.doc,.docx";
  picker.onchange = async () => {
    const uploaded = await uploadFile(picker);
    if (!uploaded?.url) return;
    const { ok, error } = await api(`/api/requests/${encodeURIComponent(id)}/reupload`, { method: "POST", body: { fileName: uploaded.fileName, url: uploaded.url } });
    if (!ok) { showToast(`❌ ${error || "Could not re-upload the file."}`, "rgba(155,22,22,.85)"); return; }
    showToast("✅ Corrected document submitted for review.");
    await loadRequests(); renderStudentTable();
  };
  picker.click();
}

async function giveFeedback(requestId) {
  const rating = prompt("Rate the completed service from 1 to 5:", "5"); if (rating === null) return;
  const comment = prompt("Optional comment:", ""); if (comment === null) return;
  const result = await api("/api/feedback", { method: "POST", body: { requestId, rating: Number(rating), comment } });
  showToast(result.ok ? "✅ Thank you for your feedback." : `❌ ${result.error || "Could not submit feedback."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
}


function showQR(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  const qrModal = document.getElementById("qrModal");
  if (qrModal && qrModal.parentElement !== document.body) document.body.appendChild(qrModal);
  qrModal.classList.add("open");
  document.getElementById("qrDocName").textContent = req.doc;
  document.getElementById("qrRefNo").textContent = `Ref: ${req.id} · ${req.studentName}`;
  if (qrRenderedFor !== reqId) {
    const canvas = document.getElementById("qrCanvas");
    canvas.innerHTML = "";
    if (!req.qrToken) { showToast("Secure QR is available only after the request is marked Ready to Claim.", "rgba(180,130,0,.85)"); return; }
    new QRCode(canvas, { text: req.qrToken, width: 160, height: 160, colorDark: "#8B1A1A", colorLight: "#ffffff" });
    qrRenderedFor = reqId;
  }
}
function closeQR() { document.getElementById("qrModal").classList.remove("open"); }


function showDetail(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  const detailModal = document.getElementById("detailModal");
  if (detailModal && detailModal.parentElement !== document.body) document.body.appendChild(detailModal);
  const bc = badgeClass(req.status);
  document.getElementById("detailContent").innerHTML = `
    <div class="detail-row"><span class="detail-label">Ref No.</span><span class="detail-value" style="font-family:monospace;">${req.id}</span></div>
    <div class="detail-row"><span class="detail-label">Document</span><span class="detail-value">${req.doc}</span></div>
    <div class="detail-row"><span class="detail-label">Purpose</span><span class="detail-value">${req.purpose}</span></div>
    <div class="detail-row"><span class="detail-label">Copies</span><span class="detail-value">${req.copies}</span></div>
    <div class="detail-row"><span class="detail-label">Date Submitted</span><span class="detail-value">${req.date}</span></div>
    <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value"><span class="badge ${bc}">${req.status}</span></span></div>
    ${req.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value" style="font-size:12px;color:rgba(20,4,4,.85);">${req.notes}</span></div>` : ""}
    ${req.reuploadUrl ? `<div class="detail-row"><span class="detail-label">Corrected requirement</span><span class="detail-value">${fileLink(req.reuploadName, req.reuploadUrl, "View uploaded file")}</span></div>` : ""}
    ${["Approved", "Ready to Claim", "Completed"].includes(req.status) ? `<div style="margin-top:12px;"><button onclick="printApproval('${req.id}')" class="btn-ghost" style="width:100%;padding:10px;font-size:13px;"><i class="fa-solid fa-file-signature" style="margin-right:6px;"></i>Print Approval Certificate</button></div>` : ""}
    ${req.status === "Rejected" && req.rejectReason ? `
    <div style="margin-top:10px;background:rgba(220,38,38,.07);border:1px solid rgba(220,38,38,.25);border-radius:10px;padding:10px 12px;">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#b91c1c;margin-bottom:3px;"><i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>Reason for Rejection</div>
      <div style="font-size:12px;color:#7f1d1d;white-space:pre-wrap;">${req.rejectReason}</div>
      <div style="font-size:9px;color:rgba(127,29,29,.6);margin-top:4px;">${req.rejectedAt || ""}${req.rejectedBy ? " · by " + req.rejectedBy : ""}</div>
    </div>` : ""}
    ${req.claimRef ? `
    <div class="detail-row"><span class="detail-label">Claiming Ref.</span><span class="detail-value" style="font-family:monospace;font-weight:800;color:#1e40af;">${req.claimRef}</span></div>
    <div class="detail-row"><span class="detail-label">Claimed On</span><span class="detail-value">${req.claimedAt}</span></div>
    <div class="detail-row"><span class="detail-label">Released By</span><span class="detail-value">${req.claimedBy}</span></div>
    <div style="margin-top:12px;"><button onclick="printReceipt('${req.id}')" class="btn-maroon" style="width:100%;padding:10px;font-size:13px;"><i class="fa-solid fa-print" style="margin-right:6px;"></i>Print Claim Receipt</button></div>` : ""}
  `;
  detailModal.classList.add("open");
}
function closeDetail() { document.getElementById("detailModal").classList.remove("open"); }


function quickRequest(docKey) {
  goTo("page-request");
  setTimeout(() => {
    const sel = document.getElementById("reqDocType");
    sel.value = docKey;
    updateDocHelp(docKey);
  }, 50);
}

async function submitRequest() {
  const docType = document.getElementById("reqDocType").value;
  const purpose = document.getElementById("reqPurpose").value;
  let valid = true;

  document.getElementById("reqDocType").classList.remove("error");
  document.getElementById("reqPurpose").classList.remove("error");
  document.getElementById("reqDocTypeErr").classList.remove("show");
  document.getElementById("reqPurposeErr").classList.remove("show");

  if (!docType) { document.getElementById("reqDocType").classList.add("error"); document.getElementById("reqDocTypeErr").classList.add("show"); valid = false; }
  const requirements = DOC_REQUIREMENTS[docType] || [];
  if (requirements.length && !requirements.every((_, index) => document.getElementById(`reqCheck-${index}`)?.checked)) { showToast("⚠️ Please confirm the document requirements first.", "rgba(180,130,0,.85)"); valid = false; }
  if (!purpose) { document.getElementById("reqPurpose").classList.add("error"); document.getElementById("reqPurposeErr").classList.add("show"); valid = false; }
  if (!valid) return;

  const btn = document.getElementById("submitReqBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Submitting…';

  const notes = document.getElementById("reqNotes").value.trim();
  const { ok, data, error } = await api("/api/requests", { method: "POST", body: { docKey: docType, purpose, copies, notes } });

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="margin-right:8px;"></i>Submit Request';

  if (!ok) { showToast(`❌ ${error || "Could not submit request."}`, "rgba(155,22,22,.85)"); return; }

  await loadRequests();
  const myReqs = DB.filter((r) => r.studentId === session.id);
  document.getElementById("kpiTotal").textContent = myReqs.length;
  document.getElementById("kpiPending").textContent = myReqs.filter((r) => r.status === "Pending").length;
  document.getElementById("kpiReady").textContent = myReqs.filter((r) => r.status === "Ready to Claim").length;

  document.getElementById("reqDocType").value = "";
  document.getElementById("reqPurpose").value = "";
  document.getElementById("reqNotes").value = "";
  document.getElementById("docHelp").style.display = "none";
  copies = 1;
  document.getElementById("copiesVal").textContent = "1";

  showToast(`✅ ${data.id} submitted! Processing in 3–5 days.`);
  setTimeout(() => goTo("page-student"), 900);
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
    ["fa-file-circle-exclamation", ADMIN_ACTIVITY.pendingRequests, "Pending requests"],
    ["fa-calendar-clock", ADMIN_ACTIVITY.waitingAppointments, "Waiting appointments"],
    ["fa-shield-heart", ADMIN_ACTIVITY.openComplaints, "Open complaints"],
    ["fa-envelope-circle-check", ADMIN_ACTIVITY.emailFailures, "Email failures"],
  ];
  el.style.display = "block";
  el.innerHTML = `<div style="font-size:12px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-bolt" style="color:#D4A017;margin-right:6px;"></i>Staff Activity</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">${items.map(([icon, count, label]) => `<div style="display:flex;align-items:center;gap:8px;font-size:12px;"><i class="fa-solid ${icon}" style="color:#8B1A1A;"></i><b style="font-size:18px;">${count}</b><span style="color:rgba(30,5,5,.65);">${label}</span></div>`).join("")}</div>`;
}

function renderAdminKPIs() {
  const total = DB.length;
  const pending = DB.filter((r) => r.status === "Pending").length;
  const approved = DB.filter((r) => r.status === "Approved" || r.status === "Ready to Claim" || r.status === "Completed").length;
  const rejected = DB.filter((r) => r.status === "Rejected").length;
  const clearRate = total > 0 ? Math.round((approved / total) * 100) : 0;

  document.getElementById("adminKpiTotal").textContent = total;
  document.getElementById("adminKpiPending").textContent = pending;
  document.getElementById("adminKpiApproved").textContent = approved;
  document.getElementById("adminKpiRejected").textContent = rejected;
  document.getElementById("adminKpiClearance").textContent = clearRate + "% clearance rate";
  document.getElementById("clearanceBadge").textContent = clearRate + "% Clearance";
  document.getElementById("legendApproved").textContent = approved;
  document.getElementById("legendPending").textContent = pending;
  document.getElementById("legendRejected").textContent = rejected;
}

function renderAdminTable() {
  const q = (document.getElementById("adminSearch")?.value || "").toLowerCase();
  const filter = document.getElementById("adminStatusFilter")?.value || "";
  const docSel = document.getElementById("adminDocFilter");
  let docF = "";
  if (docSel) {
    docF = docSel.value;
    const docs = [...new Set(DB.map((r) => r.doc))].sort();
    docSel.innerHTML = '<option value="">All Documents</option>' + docs.map((d) => `<option value="${d}" ${d === docF ? "selected" : ""}>${d}</option>`).join("");
    if (docF && !docs.includes(docF)) docF = "";
  }
  const sortMode = document.getElementById("adminSort")?.value || "new";
  const sorted = [...DB].sort((a, b) => {
    if (sortMode === "old") return a.dateSort - b.dateSort;
    if (sortMode === "doc") return a.doc.localeCompare(b.doc) || b.dateSort - a.dateSort;
    if (sortMode === "stu") return a.studentName.localeCompare(b.studentName) || b.dateSort - a.dateSort;
    return b.dateSort - a.dateSort;
  });
  const filtered = sorted.filter((r) => {
    const matchStatus = !filter || r.status === filter;
    const matchDoc = !docF || r.doc === docF;
    const matchQ = !q || r.studentName.toLowerCase().includes(q) || r.studentId.toLowerCase().includes(q) || r.doc.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.status.toLowerCase().includes(q);
    return matchStatus && matchDoc && matchQ;
  });
  const filterKey = `${q}|${filter}|${docF}|${sortMode}`;
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

  tbody.innerHTML = pageRows.map((r) => {
    const bc = badgeClass(r.status);
    const eyeBtn = `<button onclick="openAdminDetail('${r.id}')" class="btn-ghost" style="padding:5px 12px;font-size:11px;border-radius:9px;"><i class="fa-solid fa-eye"></i></button>`;
    let actions;
    if (r.status === "Pending") {
      actions = `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
           <button onclick="adminAction('${r.id}','Approved')" style="background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:#4ade80;font-weight:800;padding:5px 12px;border-radius:9px;font-size:11px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-check" style="margin-right:4px;"></i>Approve</button>
           <button onclick="openRejectModal('${r.id}')" style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.35);color:#f87171;font-weight:800;padding:5px 12px;border-radius:9px;font-size:11px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-xmark" style="margin-right:4px;"></i>Reject</button>
           ${eyeBtn}
         </div>`;
    } else if (r.status === "Approved") {
      actions = `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
           <button onclick="adminAction('${r.id}','Ready to Claim')" style="background:rgba(245,197,24,.2);border:1px solid rgba(212,160,23,.5);color:#a16207;font-weight:800;padding:5px 12px;border-radius:9px;font-size:11px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-box-open" style="margin-right:4px;"></i>Ready to Claim</button>
           ${eyeBtn}
         </div>`;
    } else if (r.status === "Ready to Claim") {
      actions = `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
           <button onclick="adminAction('${r.id}','Completed')" style="background:rgba(37,99,235,.15);border:1px solid rgba(37,99,235,.4);color:#1e40af;font-weight:800;padding:5px 12px;border-radius:9px;font-size:11px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-flag-checkered" style="margin-right:4px;"></i>Complete</button>
           ${eyeBtn}
         </div>`;
    } else if (r.status === "Completed") {
      actions = `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
           <button onclick="printReceipt('${r.id}')" class="btn-maroon" style="padding:5px 12px;font-size:11px;border-radius:9px;"><i class="fa-solid fa-print" style="margin-right:4px;"></i>Receipt</button>
           ${eyeBtn}
         </div>`;
    } else {
      actions = `<button onclick="openAdminDetail('${r.id}')" class="btn-ghost" style="padding:5px 12px;font-size:11px;border-radius:9px;"><i class="fa-solid fa-eye" style="margin-right:4px;"></i>View</button>`;
    }
    return `<tr>
      <td><div style="font-weight:700;font-size:13px;color:#1a0505;">${r.studentName}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${r.studentId}</div></td>
      <td style="font-size:13px;color:#1a0505;">${r.doc}</td>
      <td style="font-size:12px;color:rgba(30,5,5,.68);">${r.date}</td>
      <td><span class="badge ${bc}">${r.status}</span></td>
      <td style="text-align:right;">${actions}</td>
    </tr>`;
  }).join("");
  renderTablePagination(pagination, adminRequestPage, totalPages, filtered.length, "setAdminRequestPage");
}

function setAdminRequestPage(page) {
  adminRequestPage = Math.max(1, page);
  renderAdminTable();
}
async function adminAction(reqId, newStatus, reason) {
  const { ok, error } = await api(`/api/requests/${encodeURIComponent(reqId)}`, { method: "PATCH", body: { status: newStatus, reason } });
  if (!ok) { showToast(`❌ ${error || "Could not update request."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`✅ ${reqId} marked as ${newStatus}.`);
  if (donutChart) { try { donutChart.destroy(); } catch (e) {} donutChart = null; }
  if (barChartInst) { try { barChartInst.destroy(); } catch (e) {} barChartInst = null; }
  await loadRequests();
  await loadAuditLog();
  await loadEmailLog();
  renderAdminPage();
}

function openAdminDetail(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  const detailModal = document.getElementById("adminDetailModal");
  if (detailModal && detailModal.parentElement !== document.body) document.body.appendChild(detailModal);
  const bc = badgeClass(req.status);
  document.getElementById("adminDetailContent").innerHTML = `
    <div class="detail-row"><span class="detail-label">Ref No.</span><span class="detail-value" style="font-family:monospace;">${req.id}</span></div>
    <div class="detail-row"><span class="detail-label">Student</span><span class="detail-value">${req.studentName}</span></div>
    <div class="detail-row"><span class="detail-label">Student No.</span><span class="detail-value" style="font-family:monospace;font-size:12px;">${req.studentId}</span></div>
    <div class="detail-row"><span class="detail-label">Document</span><span class="detail-value">${req.doc}</span></div>
    <div class="detail-row"><span class="detail-label">Purpose</span><span class="detail-value">${req.purpose}</span></div>
    <div class="detail-row"><span class="detail-label">Copies</span><span class="detail-value">${req.copies}</span></div>
    <div class="detail-row"><span class="detail-label">Date Submitted</span><span class="detail-value">${req.date}</span></div>
    <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value"><span class="badge ${bc}">${req.status}</span></span></div>
    ${req.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value" style="font-size:12px;color:rgba(20,4,4,.85);">${req.notes}</span></div>` : ""}
    ${req.reuploadUrl ? `<div class="detail-row"><span class="detail-label">Corrected requirement</span><span class="detail-value">${fileLink(req.reuploadName, req.reuploadUrl, "View uploaded file")}</span></div>` : ""}
    ${req.status === "Rejected" && req.rejectReason ? `
    <div style="margin-top:10px;background:rgba(220,38,38,.07);border:1px solid rgba(220,38,38,.25);border-radius:10px;padding:10px 12px;">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#b91c1c;margin-bottom:3px;"><i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>Reason for Rejection</div>
      <div style="font-size:12px;color:#7f1d1d;white-space:pre-wrap;">${req.rejectReason}</div>
      <div style="font-size:9px;color:rgba(127,29,29,.6);margin-top:4px;">${req.rejectedAt || ""}${req.rejectedBy ? " · by " + req.rejectedBy : ""}</div>
    </div>` : ""}
    ${req.claimRef ? `
    <div class="detail-row"><span class="detail-label">Claiming Ref.</span><span class="detail-value" style="font-family:monospace;font-weight:800;color:#1e40af;">${req.claimRef}</span></div>
    <div class="detail-row"><span class="detail-label">Claimed On</span><span class="detail-value">${req.claimedAt}</span></div>
    <div class="detail-row"><span class="detail-label">Released By</span><span class="detail-value">${req.claimedBy}</span></div>` : ""}
  `;
  const actDiv = document.getElementById("adminDetailActions");
  if (req.status === "Pending") {
    actDiv.innerHTML = `
      <button onclick="adminAction('${req.id}','Approved').then((updated)=>{if(updated)closeAdminDetail();})" style="flex:1;background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:#4ade80;font-weight:800;padding:10px;border-radius:12px;font-size:13px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-check" style="margin-right:6px;"></i>Approve</button>
      <button onclick="closeAdminDetail();openRejectModal('${req.id}')" style="flex:1;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.35);color:#f87171;font-weight:800;padding:10px;border-radius:12px;font-size:13px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-xmark" style="margin-right:6px;"></i>Reject</button>
      <button onclick="closeAdminDetail()" class="btn-ghost" style="padding:10px 14px;font-size:13px;">Cancel</button>`;
  } else if (req.status === "Approved") {
    actDiv.innerHTML = `
      <button onclick="adminAction('${req.id}','Ready to Claim').then((updated)=>{if(updated)closeAdminDetail();})" style="flex:1;background:rgba(245,197,24,.2);border:1px solid rgba(212,160,23,.5);color:#a16207;font-weight:800;padding:10px;border-radius:12px;font-size:13px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-box-open" style="margin-right:6px;"></i>Mark Ready to Claim</button>
      <button onclick="closeAdminDetail()" class="btn-ghost" style="padding:10px 14px;font-size:13px;">Close</button>`;
  } else if (req.status === "Ready to Claim") {
    actDiv.innerHTML = `
      <button onclick="adminAction('${req.id}','Completed').then((updated)=>{if(updated)openAdminDetail('${req.id}');})" style="flex:1;background:rgba(37,99,235,.15);border:1px solid rgba(37,99,235,.4);color:#1e40af;font-weight:800;padding:10px;border-radius:12px;font-size:13px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-flag-checkered" style="margin-right:6px;"></i>Mark Completed (Claimed)</button>
      <button onclick="closeAdminDetail()" class="btn-ghost" style="padding:10px 14px;font-size:13px;">Close</button>`;
  } else if (req.status === "Completed") {
    actDiv.innerHTML = `
      <button onclick="printReceipt('${req.id}')" class="btn-maroon" style="flex:1;padding:10px;font-size:13px;"><i class="fa-solid fa-print" style="margin-right:6px;"></i>Print Claim Receipt</button>
      <button onclick="closeAdminDetail()" class="btn-ghost" style="padding:10px 14px;font-size:13px;">Close</button>`;
  } else {
    actDiv.innerHTML = `<button onclick="closeAdminDetail()" class="btn-ghost" style="width:100%;padding:11px;">Close</button>`;
  }
  detailModal.classList.add("open");
}
function closeAdminDetail() { document.getElementById("adminDetailModal").classList.remove("open"); }


function renderQueue() {
  const servedCount = queueData.filter((q) => q.served).length;
  const qs = (document.getElementById("queueSearch")?.value || "").trim().toLowerCase();
  const list = queueData.filter((q) => !qs || q.q.toLowerCase().includes(qs) || q.name.toLowerCase().includes(qs) || q.studentId.toLowerCase().includes(qs));
  const waiting = list.filter((q) => !q.served);
  const served = list.filter((q) => q.served);
  document.getElementById("queueMeta").textContent = qs
    ? `${list.length} of ${queueData.length} appointments match "${qs}"`
    : `${queueData.length} appointments today · ${servedCount} served`;
  const item = (q) => `
    <div class="queue-item${q.served ? "" : " qi-active"}">
      <div>
        <div style="font-size:18px;font-weight:900;color:${q.served ? "rgba(30,5,5,.42)" : "#1a0505"};">${q.q}</div>
        <div style="font-size:10px;font-weight:700;color:rgba(30,5,5,.55);margin-top:1px;">${q.studentId.slice(0, 12)}… · ${q.time}</div>
      </div>
      ${q.served
        ? `<span style="font-size:11px;font-weight:700;color:rgba(30,5,5,.68);display:flex;align-items:center;gap:4px;"><i class="fa-solid fa-check-double"></i>Served</span>`
        : `<button onclick="serveQueue('${q.q}')" class="btn-maroon" style="padding:6px 14px;font-size:12px;border-radius:10px;">Serve</button>`}
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
      </div>
      ${q.served
        ? '<span style="font-size:12px;font-weight:800;color:#15803d;"><i class="fa-solid fa-check-double" style="margin-right:4px;"></i>Served</span>'
        : `<button onclick="serveQueue('${q.q}')" class="btn-maroon" style="padding:7px 15px;font-size:12px;border-radius:10px;">Serve</button>`}
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

async function serveQueue(qNum) {
  const { ok, error } = await api(`/api/queue/${encodeURIComponent(qNum)}`, { method: "PATCH", body: { served: true } });
  if (!ok) { showToast(`❌ ${error || "Could not update the queue."}`, "rgba(155,22,22,.85)"); return; }
  const entry = queueData.find((q) => q.q === qNum);
  showToast(`✅ ${qNum} — ${entry ? entry.name : ""} marked as served.`);
  await loadQueueData();
  await loadAuditLog();
  renderQueue();
  if (document.getElementById("allQueueModal")?.classList.contains("open")) renderAllAppointments();
  renderAuditLog();
}


function renderCharts() {
  const pending = DB.filter((r) => r.status === "Pending").length;
  const approved = DB.filter((r) => r.status === "Approved" || r.status === "Ready to Claim" || r.status === "Completed").length;
  const rejected = DB.filter((r) => r.status === "Rejected").length;

  const dCtx = document.getElementById("adminChart");
  if (dCtx) {
    if (donutChart) {
      try { donutChart.data.datasets[0].data = [approved, pending, rejected]; donutChart.update(); }
      catch (e) { donutChart.destroy(); donutChart = null; }
    }
    if (!donutChart) {
      donutChart = new Chart(dCtx, {
        type: "doughnut",
        data: { labels: ["Approved/Ready", "Pending", "Rejected"], datasets: [{ data: [approved, pending, rejected], backgroundColor: ["#8B1A1A", "#D4A017", "#dc2626"], borderWidth: 2, borderColor: "rgba(255,255,255,.8)" }] },
        options: { plugins: { legend: { display: false } }, cutout: "72%" },
      });
    }
  }

  const docCounts = {};
  DB.forEach((r) => { docCounts[r.docKey] = (docCounts[r.docKey] || 0) + 1; });
  const barLabels = ["gmc", "auth", "other"];
  const barData = barLabels.map((k) => docCounts[k] || 0);
  const bCtx = document.getElementById("barChart");
  if (bCtx) {
    if (barChartInst) {
      try { barChartInst.data.datasets[0].data = barData; barChartInst.update(); }
      catch (e) { barChartInst.destroy(); barChartInst = null; }
    }
    if (!barChartInst) {
      barChartInst = new Chart(bCtx, {
        type: "bar",
        data: { labels: ["Excuse Slip", "Authentication", "Other"], datasets: [{ data: barData, backgroundColor: "#8B1A1A", borderRadius: 4 }] },
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
  appointmentAvailability = { bookedTimes: [], myAppointment: null };
  document.getElementById("selectedDateLabel").textContent = "Select a date to view available business-hours time slots.";
  document.getElementById("timeSlots").innerHTML = "";
  document.getElementById("confirmCard").style.display = "none";
  buildCalendar();
}
async function selectDate(d) {
  selectedDate = d; selectedSlot = null;
  document.getElementById("selectedDateLabel").textContent = `June ${d}, 2026 — loading availability…`;
  document.getElementById("confirmCard").style.display = "none";
  buildCalendar();
  const { ok, data } = await api(`/api/queue?date=${encodeURIComponent(appointmentDateLabel(d))}`);
  appointmentAvailability = ok ? data : { bookedTimes: [], myAppointment: null };
  document.getElementById("selectedDateLabel").textContent = appointmentAvailability.myAppointment
    ? `You already booked ${appointmentAvailability.myAppointment.code} at ${appointmentAvailability.myAppointment.time} on this date.`
    : `June ${d}, 2026 — select an available business-hours time slot:`;
  buildSlots();
  if (!appointmentAvailability.myAppointment) document.getElementById("selectedDateLabel").textContent = `${appointmentDateLabel(d)} — select an available business-hours time slot:`;
}
function buildSlots() {
  const times = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];
  const taken = appointmentAvailability.bookedTimes || [];
  document.getElementById("timeSlots").innerHTML = times.map((t) => {
    const isT = taken.includes(t), hasOwnBooking = !!appointmentAvailability.myAppointment, isSel = selectedSlot === t;
    return `<button ${isT || hasOwnBooking ? "disabled" : ""} onclick="${isT || hasOwnBooking ? "" : "selectSlot('" + t + "')"}" class="slot-btn${isSel ? " selected" : ""}">${isT ? `<s>${t}</s> <small>Booked</small>` : hasOwnBooking ? `<s>${t}</s>` : t}</button>`;
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
  const dateLabel = appointmentDateLabel(selectedDate);
  const { ok, data, error } = await api("/api/queue", { method: "POST", body: { dateLabel, time: selectedSlot } });
  if (!ok) { showToast(`❌ ${error || "Could not book that slot."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`✅ Booked! ${data.q} on ${dateLabel} at ${selectedSlot}`);
  selectedDate = null; selectedSlot = null;
  setTimeout(() => goTo("page-student"), 1200);
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
  const { ok, data } = await api(`/api/queue?date=${encodeURIComponent(rescheduleDateLabel(d))}`);
  rescheduleAvailability = ok ? data : { bookedTimes: [], myAppointment: null };
  if (label) label.textContent = `${rescheduleDateLabel(d)} — select an available business-hours time slot:`;
  buildRescheduleSlots();
}
function buildRescheduleSlots() {
  const container = document.getElementById("rescheduleTimeSlots");
  if (!container) return;
  const times = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];
  const taken = rescheduleAvailability.bookedTimes || [];
  const isOwnDate = rescheduleAvailability.myAppointment?.code === rescheduleCode;
  container.innerHTML = times.map((t) => {
    const isOwnSlot = isOwnDate && rescheduleAvailability.myAppointment?.time === t;
    const isTaken = taken.includes(t) && !isOwnSlot;
    const isSel = rescheduleSelectedSlot === t;
    return `<button ${isTaken ? "disabled" : ""} onclick="${isTaken ? "" : "selectRescheduleSlot('" + t + "')"}" class="slot-btn${isSel ? " selected" : ""}">${isTaken ? `<s>${t}</s> <small>Booked</small>` : isOwnSlot ? `${t} <small>(current)</small>` : t}</button>`;
  }).join("");
}
function selectRescheduleSlot(t) {
  rescheduleSelectedSlot = t;
  buildRescheduleSlots();
}


function simulateScan(type) {
  document.getElementById("scanResultValid").style.display = "none";
  document.getElementById("scanResultInvalid").style.display = "none";
  if (type === "valid") { document.getElementById("scanResultValid").style.display = "block"; showToast("✅ QR Code verified!", "rgba(21,128,61,.85)"); }
  else { document.getElementById("scanResultInvalid").style.display = "block"; showToast("❌ Invalid QR code", "rgba(155,22,22,.85)"); }
}
function markClaimed() {
  document.getElementById("scanResultValid").style.display = "none";
  showToast("📦 REQ-2026-042 marked as claimed.");
}


function badgeClass(status) { return { Pending: "badge-pending", Approved: "badge-approved", "Ready to Claim": "badge-ready", Rejected: "badge-rejected", Completed: "badge-completed" }[status] || "badge-pending"; }
function togglePass(id, btn) { const el = document.getElementById(id); el.type = el.type === "password" ? "text" : "password"; btn.querySelector("i").className = el.type === "password" ? "fa-solid fa-eye" : "fa-solid fa-eye-slash"; }
function validateStudNum(el) { const valid = /^\d{4}-\d{5}-SP-\d$/.test(el.value); const h = document.getElementById("studNumHelper"); if (el.value.length > 3) { el.style.borderColor = valid ? "rgba(34,197,94,.5)" : "rgba(239,68,68,.5)"; h.innerHTML = valid ? '<i class="fa-solid fa-circle-check" style="color:#4ade80;margin-right:3px;"></i><span style="color:#4ade80;">Valid format</span>' : '<i class="fa-solid fa-triangle-exclamation" style="color:#f87171;margin-right:3px;"></i><span style="color:#f87171;">Format: 2024-00000-SP-0</span>'; } }
function checkStrength(val) { const bars = [1, 2, 3, 4].map((i) => document.getElementById("s" + i)); const label = document.getElementById("strengthLabel"); let score = 0; if (val.length >= 8) score++; if (/[A-Z]/.test(val)) score++; if (/[0-9]/.test(val)) score++; if (/[^A-Za-z0-9]/.test(val)) score++; const colors = ["rgba(239,68,68,.8)", "rgba(249,115,22,.8)", "rgba(245,197,24,.8)", "rgba(34,197,94,.8)"]; const labels = ["Weak", "Fair", "Good", "Strong"]; bars.forEach((b, i) => (b.style.background = i < score ? colors[score - 1] : "rgba(139,26,26,.1)")); label.textContent = val.length ? labels[score - 1] || "Weak" : "Password strength"; label.style.color = val.length ? colors[score - 1] : "rgba(30,5,5,.55)"; }
function changeCopies(d) { copies = Math.max(1, Math.min(10, copies + d)); document.getElementById("copiesVal").textContent = copies; }
function updateDocHelp(val) {
  const el = document.getElementById("docHelp");
  if (!val || !DOC_HELPS[val]) { el.style.display = "none"; return; }
  const requirements = DOC_REQUIREMENTS[val] || [];
  el.innerHTML = `<div>${esc(DOC_HELPS[val])}</div><div style="margin-top:10px;font-weight:800;font-size:11px;">Requirements checklist</div>${requirements.map((item, index) => `<label style="display:flex;gap:7px;align-items:flex-start;margin-top:6px;font-size:11px;cursor:pointer;"><input id="reqCheck-${index}" type="checkbox" style="margin-top:2px;accent-color:#8B1A1A;"><span>${esc(item)}</span></label>`).join("")}`;
  el.style.display = "block";
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

const STUDENT_SERVICES = [
  { page: "page-helpdesk", icon: "fa-robot", t: "Student Service Help", d: "Ask the FAQ chatbot" },
  { page: "page-bulletin", icon: "fa-bullhorn", t: "Student Bulletin", d: "Announcements & advisories" },
  { page: "page-faq", icon: "fa-circle-question", t: "FAQ", d: "Frequently asked questions" },
  { page: "page-forms", icon: "fa-file-arrow-down", t: "Downloadable Forms", d: "Official OSS forms" },
];
const ADMIN_STAFF_SERVICES = [
  { action: "manageMasterlist", icon: "fa-users-rectangle", t: "Masterlist Manager", d: "Add, edit, or remove masterlist entries" },
  { page: "page-referral", icon: "fa-hand-holding-heart", t: "Referrals", d: "Review & manage interventions" },
  { page: "page-idapp", icon: "fa-id-card", t: "ID Applications", d: "Verify ORs & update statuses" },
  { page: "page-helpdesk", icon: "fa-headset", t: "Help Desk", d: "Respond to student tickets" },
  { page: "page-complaint", icon: "fa-shield-heart", t: "Complaints", d: "Investigate & resolve" },
  { page: "page-events2", icon: "fa-calendar-check", t: "Event Requests", d: "Approve, reject, or revise" },
  { page: "page-bulletin", icon: "fa-bullhorn", t: "Bulletin Manager", d: "Publish, edit, archive posts" },
  { page: "page-faq", icon: "fa-circle-question", t: "FAQ Manager", d: "Maintain FAQ content" },
  { action: "viewFaqAnalytics", icon: "fa-chart-simple", t: "FAQ Usage", d: "View chatbot usage analytics" },
  { page: "page-forms", icon: "fa-file-arrow-down", t: "Forms Manager", d: "Upload & manage forms" },
  { action: "openReports", icon: "fa-chart-column", t: "Reports & Analytics", d: "Export CSV reports and view service trends" },
  { action: "reviewProfileChanges", icon: "fa-user-check", t: "Profile Verification", d: "Approve or reject student profile updates" },
  { action: "sendReminders", icon: "fa-bell", t: "Send Reminders", d: "Email appointment and document-ready reminders" },
];
const SUPER_ADMIN_SERVICES = [
  { action: "manageOrganizations", icon: "fa-people-group", t: "Organizations & Representatives", d: "Control organization access and officers" },
  { action: "manageMasterlistGroups", icon: "fa-layer-group", t: "Masterlist Groups", d: "Organize groups and assign staff owners" },
  { action: "manageStudentAccounts", icon: "fa-user-lock", t: "Student Accounts", d: "Place accounts on hold or reactivate them" },
  { action: "manageSystemSettings", icon: "fa-sliders", t: "System Settings", d: "Business hours, holidays, capacity, and cutoff" },
  { action: "manageStaffAccounts", icon: "fa-user-shield", t: "Staff Accounts", d: "Create and review Admin and Scanner accounts" },
  { page: "page-memo", icon: "fa-envelopes-bulk", t: "Email Blast", d: "Send memos to student groups" },
  { action: "downloadBackup", icon: "fa-database", t: "Database Backup", d: "Download a secure JSON backup export" },
  { action: "restoreBackup", icon: "fa-clock-rotate-left", t: "Restore Configuration", d: "Restore masterlist, settings, and FAQs from backup" },
];
function hubCard(x) {
  const icon = x.icon.split(",").pop();
  const action = x.action ? `${x.action}()` : `goTo('${x.page}')`;
  return `<button onclick="${action}" class="glass-card" style="text-align:left;padding:18px;cursor:pointer;border:1px solid rgba(139,26,26,.12);">
    <div style="width:38px;height:38px;border-radius:10px;background:rgba(139,26,26,.09);display:flex;align-items:center;justify-content:center;margin-bottom:10px;">
      <i class="fa-solid ${icon}" style="color:#8B1A1A;font-size:15px;"></i></div>
    <div style="font-size:14px;font-weight:800;color:#1a0505;">${esc(x.t)}</div>
    <div style="font-size:11px;color:rgba(30,5,5,.6);margin-top:3px;">${esc(x.d)}</div>
  </button>`;
}
function renderServicesHub() { document.getElementById("servicesGrid").innerHTML = STUDENT_SERVICES.map(hubCard).join(""); }
function renderManageHub() {
  const section = (title, subtitle, icon, tools, restricted = false) => `
    <section style="margin-bottom:28px;">
      <div style="display:flex;align-items:flex-start;gap:10px;margin:0 0 12px;padding:12px 14px;border-radius:14px;background:${restricted ? "rgba(139,26,26,.10)" : "rgba(245,197,24,.12)"};border:1px solid ${restricted ? "rgba(139,26,26,.22)" : "rgba(212,160,23,.26)"};">
        <div style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:${restricted ? "rgba(139,26,26,.16)" : "rgba(212,160,23,.16)"};"><i class="fa-solid ${icon}" style="color:${restricted ? "#8B1A1A" : "#b8860b"};"></i></div>
        <div><div style="font-size:15px;font-weight:900;color:#1a0505;">${title}${restricted ? ' <span style="font-size:10px;color:#8B1A1A;letter-spacing:.06em;">RESTRICTED</span>' : ""}</div><div style="font-size:11px;color:rgba(30,5,5,.64);margin-top:2px;">${subtitle}</div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;">${tools.map(hubCard).join("")}</div>
    </section>`;
  const output = [section("Admin Staff Tools", "Daily processing, communication, requests, and student services.", "fa-briefcase", ADMIN_STAFF_SERVICES)];
  if (isSuperAdmin()) output.push(section("Super Admin Tools", "Restricted account, organization, configuration, and recovery controls.", "fa-shield-halved", SUPER_ADMIN_SERVICES, true));
  document.getElementById("manageGrid").innerHTML = output.join("");
}

function downloadBackup() {
  if (!confirm("Download a database backup file? Keep it in a secure location.")) return;
  window.open("/api/backup", "_blank");
}

function restoreBackup() {
  if (!confirm("Restore masterlist, system settings, and FAQs from a backup? Current values will be replaced. Requests and accounts will not be changed.")) return;
  const picker = document.createElement("input"); picker.type = "file"; picker.accept = ".json,application/json";
  picker.onchange = () => {
    const file = picker.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = await api("/api/backup", { method: "POST", body: JSON.parse(String(reader.result)) });
        showToast(result.ok ? `✅ Restored ${result.data.masterlist} masterlist records, ${result.data.settings} settings, and ${result.data.faqs} FAQs.` : `❌ ${result.error || "Could not restore backup."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
      } catch { showToast("❌ The selected file is not a valid JSON backup.", "rgba(155,22,22,.85)"); }
    };
    reader.readAsText(file);
  };
  picker.click();
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

async function manageOrganizations() {
  const result = await api("/api/organizations");
  if (!result.ok) return showToast(result.error || "Could not load organizations.", "rgba(155,22,22,.85)");
  const organizations = result.data || [];
  window.__qrsOrganizationRepresentatives = organizations.flatMap((organization) => organization.representatives || []);
  const rows = organizations.map((org) => {
    const reps = (org.representatives || []).map((rep) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid rgba(139,26,26,.08);font-size:11px;"><span><b>${esc(rep.studentId)}</b> ${rep.active ? "<span style='color:#16803c;'>Active</span>" : "<span style='color:#a11;'>Revoked</span>"}${rep.expiresAt ? ` · until ${new Date(rep.expiresAt).toLocaleDateString()}` : ""}</span><button class="btn-soft" style="padding:3px 8px;font-size:10px;" onclick="setOrganizationRep('${rep.id}',${!rep.active})">${rep.active ? "Revoke" : "Reactivate"}</button></div>`).join("") || `<div style="font-size:11px;color:rgba(30,5,5,.55);padding-top:6px;">No representative assigned.</div>`;
    return `<div class="glass-card" style="padding:13px;margin-bottom:10px;"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;"><div><b style="color:#1a0505;">${esc(org.name)}</b><div style="font-size:11px;color:rgba(30,5,5,.58);margin-top:3px;">Adviser: ${esc(org.adviserName)}${org.schoolYear ? ` · ${esc(org.schoolYear)}` : ""}</div></div><div style="display:flex;gap:6px;"><button class="btn-maroon" style="padding:6px 9px;font-size:11px;" onclick="assignOrganizationRep('${org.id}','${esc(org.name)}')">Assign officer</button>${isSuperAdmin() ? `<button class="btn-soft" style="padding:6px 9px;font-size:11px;" onclick="setOrganizationActive('${org.id}',${!org.active})">${org.active ? "Deactivate" : "Activate"}</button>` : ""}</div></div><div style="margin-top:8px;">${reps}</div></div>`;
  }).join("") || emptyState("No organizations registered yet.");
  openAppModal({ title: "Organizations & Representatives", subtitle: "Only assigned, active student officers may submit Event Requests. Assignments may expire each academic year.", icon: "fa-people-group", wide: true, content: `<div style="max-height:440px;overflow:auto;">${rows}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button>${isSuperAdmin() ? `<button class="btn-maroon" onclick="createOrganization()"><i class="fa-solid fa-plus"></i> Register organization</button>` : ""}</div>` });
}
async function legacyCreateOrganization() {
  const name = prompt("Organization name:")?.trim(); if (!name) return;
  const adviserName = prompt("Faculty adviser name:")?.trim(); if (!adviserName) return;
  const schoolYear = prompt("Academic year (optional, e.g. 2026–2027):")?.trim() || "";
  const result = await api("/api/organizations", { method: "POST", body: { name, adviserName, schoolYear } });
  if (!result.ok) return showToast(result.error || "Could not register organization.", "rgba(155,22,22,.85)");
  showToast("Organization registered."); manageOrganizations();
}
async function legacyAssignOrganizationRep(organizationId, name) {
  const studentId = prompt(`Student number of the verified officer for ${name}:`)?.trim(); if (!studentId) return;
  const expiresAt = prompt("Access expiry date (YYYY-MM-DD; leave blank for no expiry):")?.trim() || "";
  const result = await api("/api/organizations/representatives", { method: "POST", body: { organizationId, studentId, expiresAt } });
  if (!result.ok) return showToast(result.error || "Could not assign representative.", "rgba(155,22,22,.85)");
  showToast("Organization representative assigned."); manageOrganizations();
}
async function createOrganization() {
  openAppModal({ title: "Register Organization", subtitle: "Create the organization before assigning verified student officers.", icon: "fa-people-group", content: `<div class="app-modal-grid">${modalField("Organization name", "orgName")}${modalField("Faculty adviser", "orgAdviser")}${modalField("Academic year", "orgSchoolYear", "2026-2027")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="manageOrganizations()">Back</button><button class="btn-maroon" onclick="saveOrganization()"><i class="fa-solid fa-floppy-disk"></i> Register organization</button></div>` });
}
async function saveOrganization() {
  const name = document.getElementById("orgName")?.value.trim(), adviserName = document.getElementById("orgAdviser")?.value.trim(), schoolYear = document.getElementById("orgSchoolYear")?.value.trim() || "";
  if (!name || !adviserName) return showToast("Organization name and faculty adviser are required.", "rgba(180,130,0,.85)");
  const result = await api("/api/organizations", { method: "POST", body: { name, adviserName, schoolYear } });
  if (!result.ok) return showToast(result.error || "Could not register organization.", "rgba(155,22,22,.85)");
  showToast("Organization registered."); manageOrganizations();
}
async function assignOrganizationRep(organizationId, name) {
  const studentsResult = await api("/api/users/students");
  if (!studentsResult.ok) return showToast(studentsResult.error || "Could not load students.", "rgba(155,22,22,.85)");
  const options = (studentsResult.data || []).filter((student) => student.active && student.approved).map((student) => `<option value="${esc(student.studentId)}">${esc(student.name)} — ${esc(student.studentId)}${student.course ? ` · ${esc(student.course)}` : ""}</option>`).join("");
  openAppModal({ title: "Assign Organization Representative", subtitle: `Select the verified student officer for ${name}. Their Student account remains unchanged.`, icon: "fa-user-check", content: `<div class="app-modal-grid"><div class="app-field" style="grid-column:1/-1;"><label for="orgRepresentativeStudent">Student officer</label><select id="orgRepresentativeStudent" class="glass-input"><option value="">Select approved student account</option>${options}</select></div><div class="app-field"><label for="orgRepresentativeExpiry">Access expires on (optional)</label><input id="orgRepresentativeExpiry" type="date" class="glass-input"></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="manageOrganizations()">Back</button><button class="btn-maroon" onclick="saveOrganizationRepresentative('${organizationId}')"><i class="fa-solid fa-user-plus"></i> Assign representative</button></div>` });
}
async function saveOrganizationRepresentative(organizationId) {
  const studentId = document.getElementById("orgRepresentativeStudent")?.value || "";
  const expiresAt = document.getElementById("orgRepresentativeExpiry")?.value || "";
  if (!studentId) return showToast("Select the student officer to assign.", "rgba(180,130,0,.85)");
  const result = await api("/api/organizations/representatives", { method: "POST", body: { organizationId, studentId, expiresAt } });
  if (!result.ok) return showToast(result.error || "Could not assign representative.", "rgba(155,22,22,.85)");
  showToast("Organization representative assigned."); manageOrganizations();
}
async function setOrganizationRep(id, active) {
  const result = await api("/api/organizations/representatives", { method: "PATCH", body: { id, active } });
  if (!result.ok) return showToast(result.error || "Could not update representative.", "rgba(155,22,22,.85)");
  showToast(active ? "Representative reactivated." : "Representative access revoked."); manageOrganizations();
}
function confirmRemoveOrganizationRep(id, studentId) {
  openAppModal({ title: "Remove Representative", subtitle: "This permanently removes the representative assignment. The student's account and request history are not deleted.", icon: "fa-user-minus", content: `<div class="glass-card" style="padding:14px;margin-bottom:16px;"><div style="font-size:13px;font-weight:800;color:#1a0505;">${esc(studentId)}</div><div style="font-size:11px;color:rgba(30,5,5,.65);margin-top:4px;">They will immediately lose Organization Representative access.</div></div><div class="app-modal-actions"><button class="btn-soft" onclick="manageOrganizations()">Cancel</button><button class="btn-maroon" onclick="removeOrganizationRep('${id}')"><i class="fa-solid fa-trash"></i> Remove permanently</button></div>` });
}
async function removeOrganizationRep(id) {
  const result = await api(`/api/organizations/representatives?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!result.ok) return showToast(result.error || "Could not remove representative.", "rgba(155,22,22,.85)");
  showToast("Representative assignment removed."); manageOrganizations();
}
async function setOrganizationActive(id, active) {
  if (!confirm(`${active ? "Activate" : "Deactivate"} this organization?`)) return;
  const result = await api("/api/organizations", { method: "PATCH", body: { id, active } });
  if (!result.ok) return showToast(result.error || "Could not update organization.", "rgba(155,22,22,.85)");
  showToast(active ? "Organization activated." : "Organization deactivated."); manageOrganizations();
}

async function requestProfileEdit() {
  const current = await api("/api/profile"); if (!current.ok) return showToast("❌ Could not load profile.", "rgba(155,22,22,.85)");
  if (current.data.pending) return showToast("⚠️ Your profile update is already awaiting staff verification.", "rgba(180,130,0,.85)");
  const u = current.data.user || session;
  openAppModal({ title: "Update Profile", subtitle: "Your changes will be reviewed by Student Services before they are applied.", icon: "fa-user-pen", content: `<div class="app-modal-grid">${modalField("Full name", "profileName", u.name)}${modalField("Email", "profileEmail", u.email)}${modalField("Course", "profileCourse", u.course || "")}${modalField("Year level", "profileYear", u.year || "")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="openSettingsMenu()">Back</button><button class="btn-maroon" onclick="saveProfileEdit()"><i class="fa-solid fa-paper-plane"></i> Submit for review</button></div>` });
}

async function saveProfileEdit() {
  const name = document.getElementById("profileName")?.value.trim(), email = document.getElementById("profileEmail")?.value.trim(), course = document.getElementById("profileCourse")?.value.trim(), year = document.getElementById("profileYear")?.value.trim();
  if (!name || !email) return showToast("Name and email are required.", "rgba(180,130,0,.85)");
  const result = await api("/api/profile", { method: "POST", body: { name, email, course, year } });
  if (result.ok) closeAppModal();
  showToast(result.ok ? "Profile update submitted for staff verification." : (result.error || "Could not submit profile update."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function reviewProfileChanges() {
  const list = await api("/api/profile"); if (!list.ok) return showToast("❌ Could not load profile updates.", "rgba(155,22,22,.85)");
  if (!list.data.length) return showToast("No profile updates awaiting review.");
  const first = list.data[0];
  const decision = prompt(`Review ${first.name} (${first.studentId})\nEmail: ${first.email}\nCourse/Year: ${first.course || "-"} / ${first.year || "-"}\n\nType APPROVED or REJECTED:`, "APPROVED");
  if (!decision) return;
  const status = decision.trim().toLowerCase() === "approved" ? "Approved" : decision.trim().toLowerCase() === "rejected" ? "Rejected" : "";
  if (!status) return showToast("⚠️ Type APPROVED or REJECTED.", "rgba(180,130,0,.85)");
  const result = await api(`/api/profile/${encodeURIComponent(first.id)}`, { method: "PATCH", body: { status } });
  showToast(result.ok ? `✅ Profile update ${status.toLowerCase()}.` : `❌ ${result.error || "Could not update profile."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function sendReminders() {
  if (!confirm("Send reminders for appointments within 24 hours and all ready-to-claim documents?")) return;
  const result = await api("/api/reminders", { method: "POST" });
  showToast(result.ok ? `✅ Sent ${result.data.appointmentEmails} appointment and ${result.data.readyEmails} document reminders.` : `❌ ${result.error || "Could not send reminders."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
}


async function openReports() {
  const analytics = await api("/api/reports/analytics");
  if (!analytics.ok) { showToast("❌ Could not load analytics.", "rgba(155,22,22,.85)"); return; }
  const a = analytics.data;
  const summarize = (items) => (items || []).map((x) => `${x.label}: ${x.count}`).join("\n") || "No data";
  const choice = prompt(`Analytics\n\nMost requested services:\n${summarize(a.services)}\n\nPeak appointment times:\n${summarize(a.peakTimes)}\n\nType requests, appointments, or complaints to download its CSV report:`, "requests");
  if (!choice) return;
  const type = choice.trim().toLowerCase();
  if (!["requests", "appointments", "complaints"].includes(type)) { showToast("⚠️ Choose requests, appointments, or complaints.", "rgba(180,130,0,.85)"); return; }
  window.open(`/api/reports/export?type=${encodeURIComponent(type)}`, "_blank");
}

async function viewFaqAnalytics() {
  const result = await api("/api/faq-analytics");
  showToast(result.ok ? `FAQ chatbot queries recorded: ${result.data.totalQueries}` : "❌ Could not load FAQ analytics.", result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function openReports() {
  const analytics = await api("/api/reports/analytics");
  if (!analytics.ok) return showToast("Could not load analytics.", "rgba(155,22,22,.85)");
  const a = analytics.data;
  const summarize = (items) => (items || []).map((x) => `${x.label}: ${x.count}`).join("\n") || "No data";
  const choice = prompt(`Analytics\n\nStudents by course:\n${summarize(a.byCourse)}\n\nStudents by year level:\n${summarize(a.byYear)}\n\nMost requested services:\n${summarize(a.services)}\n\nPeak appointment times:\n${summarize(a.peakTimes)}\n\nType requests, appointments, complaints for CSV, or PDF for a printable analytics report:`, "requests");
  if (!choice) return;
  const type = choice.trim().toLowerCase();
  if (type === "pdf") return printAnalyticsReport(a);
  if (!["requests", "appointments", "complaints"].includes(type)) return showToast("Choose requests, appointments, or complaints.", "rgba(180,130,0,.85)");
  window.open(`/api/reports/export?type=${encodeURIComponent(type)}`, "_blank");
}

function printAnalyticsReport(data) {
  const rows = (items) => (items || []).map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.count)}</td></tr>`).join("") || "<tr><td colspan='2'>No data</td></tr>";
  const section = (title, items) => `<h2>${esc(title)}</h2><table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${rows(items)}</tbody></table>`;
  const html = `<!doctype html><html><head><title>QR-SASMS Analytics Report</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#1a0505}h1{color:#8B1A1A}h2{margin-top:24px;font-size:16px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:8px;text-align:left}th{background:#8B1A1A;color:#fff}.foot{font-size:10px;color:#666;margin-top:24px}@media print{body{padding:0}.noprint{display:none}}</style></head><body><h1>QR-SASMS Analytics Report</h1><p>PUP San Pedro Student Services Office</p>${section("Students by Course",data.byCourse)}${section("Students by Year Level",data.byYear)}${section("Most Requested Services",data.services)}${section("Peak Appointment Times",data.peakTimes)}<div class="foot">Generated ${esc(fnow())} · QR-SASMS</div><div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div><script>setTimeout(()=>window.print(),300);<\/script></body></html>`;
  const w = window.open("", "_blank"); if (!w) return showToast("Please allow pop-ups to save the PDF.", "rgba(180,130,0,.85)"); w.document.write(html); w.document.close();
}

async function viewFaqAnalytics() {
  const result = await api("/api/faq-analytics");
  if (!result.ok) return showToast("Could not load FAQ analytics.", "rgba(155,22,22,.85)");
  const details = (result.data.matches || []).map((x, i) => `${i + 1}. ${x.question}: ${x.count}`).join("\n") || "No chatbot questions recorded yet.";
  alert(`FAQ Chatbot Analytics\n\nTotal queries: ${result.data.totalQueries}\n\nTop matched/unmatched questions:\n${details}`);
}

async function manageSystemSettings() {
  const current = await api("/api/settings"); if (!current.ok) { showToast("❌ Could not load settings.", "rgba(155,22,22,.85)"); return; }
  const data = current.data;
  const businessHours = prompt("Business hours (comma-separated time slots):", (data.businessHours || []).join(", ")); if (businessHours === null) return;
  const capacity = prompt("Appointment capacity per slot:", data.appointmentCapacity); if (capacity === null) return;
  const cutoff = prompt("Cancellation/reschedule cutoff in hours:", data.cancellationCutoffHours); if (cutoff === null) return;
  const holidays = prompt("Closed dates (comma-separated, e.g. December 25, 2026):", (data.holidays || []).join(", ")); if (holidays === null) return;
  const emailTemplate = prompt("Email template. You may use {{name}}, {{title}}, and {{message}}:", data.emailTemplate || "{{message}}\n\n— QR-SASMS"); if (emailTemplate === null) return;
  const result = await api("/api/settings", { method: "PUT", body: { businessHours: businessHours.split(",").map((x) => x.trim()).filter(Boolean), appointmentCapacity: Number(capacity), cancellationCutoffHours: Number(cutoff), holidays: holidays.split(",").map((x) => x.trim()).filter(Boolean), emailTemplate } });
  showToast(result.ok ? "✅ System settings saved." : `❌ ${result.error || "Could not save settings."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function manageStaffAccounts() {
  const list = await api("/api/users/staff"); if (!list.ok) { showToast("❌ Could not load staff accounts.", "rgba(155,22,22,.85)"); return; }
  const summary = list.data.map((u) => `${u.name} — ${u.role}`).join("\n") || "No staff accounts yet.";
  if (!confirm(`${summary}\n\nCreate a new staff account?`)) return;
  const name = prompt("Staff name:"); const email = prompt("Staff email:"); const password = prompt("Temporary password (minimum 10 characters):"); const role = prompt("Role: ADMIN or SCANNER", "ADMIN");
  if (!name || !email || !password || !role) return;
  const created = await api("/api/users/staff", { method: "POST", body: { name, email, password, role: role.toUpperCase() } });
  showToast(created.ok ? "✅ Staff account created." : `❌ ${created.error || "Could not create staff account."}`, created.ok ? undefined : "rgba(155,22,22,.85)");
}


function matchQ(q, fields) { if (!q) return true; q = q.toLowerCase(); return fields.some((f) => (f == null ? "" : String(f)).toLowerCase().includes(q)); }
let refAdminQ = "", idaAdminQ = "", hdAdminQ = "", evtAdminQ = "", cmpAdminQ = "";
async function manageStaffAccounts() {
  const list = await api("/api/users/staff");
  if (!list.ok) return showToast("Could not load staff accounts.", "rgba(155,22,22,.85)");
  const summary = list.data.map((u) => `${u.name} (${u.email}) — ${u.role} · ${u.active ? "Active" : "Deactivated"}`).join("\n") || "No staff accounts yet.";
  const action = prompt(`${summary}\n\nType CREATE to add staff, or enter a staff email to edit/deactivate:`, "CREATE");
  if (!action) return;
  const target = list.data.find((u) => u.email.toLowerCase() === action.trim().toLowerCase());
  if (target) {
    const name = prompt("Staff name:", target.name); if (name === null) return;
    const role = prompt("Role: ADMIN or SCANNER", target.role); if (role === null) return;
    const active = confirm("Keep this account active? Click Cancel to deactivate it.");
    const updated = await api(`/api/users/staff/${encodeURIComponent(target.id)}`, { method: "PATCH", body: { name, role: role.toUpperCase(), active } });
    return showToast(updated.ok ? "Staff account updated." : (updated.error || "Could not update account."), updated.ok ? undefined : "rgba(155,22,22,.85)");
  }
  if (action.trim().toUpperCase() !== "CREATE") return showToast("Enter CREATE or an email from the list.", "rgba(180,130,0,.85)");
  const name = prompt("Staff name:"), email = prompt("Staff email:"), password = prompt("Temporary password (minimum 10 characters):"), role = prompt("Role: ADMIN or SCANNER", "ADMIN");
  if (!name || !email || !password || !role) return;
  const created = await api("/api/users/staff", { method: "POST", body: { name, email, password, role: role.toUpperCase() } });
  showToast(created.ok ? "Staff account created." : (created.error || "Could not create staff account."), created.ok ? undefined : "rgba(155,22,22,.85)");
}
function adminSearchBox(id, varName, renderFn, placeholder, currentVal) {
  return `<div style="position:relative;margin-bottom:12px;">
    <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:rgba(30,5,5,.4);font-size:12px;"></i>
    <input id="${id}" class="glass-input" style="padding-left:34px;" placeholder="${placeholder}" value="${esc(currentVal)}"
      oninput="${varName}=this.value;${renderFn}();(function(){var e=document.getElementById('${id}');if(e){e.focus();e.setSelectionRange(e.value.length,e.value.length);}})();">
  </div>`;
}
function emptyState(msg) { return `<div class="glass-card" style="padding:26px;text-align:center;color:rgba(30,5,5,.5);font-size:12px;"><i class="fa-solid fa-inbox" style="font-size:20px;display:block;margin-bottom:8px;color:rgba(139,26,26,.35);"></i>${esc(msg)}</div>`; }

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


const REF_STATUSES = ["Pending", "Under Review", "Approved", "Ongoing Intervention", "Completed", "Rejected"];
function renderReferral() {
  const el = document.getElementById("referralBody");
  if (isAdmin()) {
    const list = [...MOD.referrals].reverse().filter((r) => matchQ(refAdminQ, [r.name, r.sn, r.id, r.category, r.status]));
    const rows = getModulePage("ref-admin", list).items.map((r) => `
      <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(r.name)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(r.sn)} · ${esc(r.category)} · ${esc(r.ts)}</span></div>
          ${pill(r.status)}
        </div>
        <div style="font-size:12px;color:rgba(30,5,5,.8);margin:8px 0;white-space:pre-wrap;">${esc(r.details)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select id="refst-${r.id}" class="glass-input" style="max-width:210px;padding:8px;font-size:12px;">
            ${REF_STATUSES.map((s) => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <input id="refrm-${r.id}" class="glass-input" style="flex:1;min-width:160px;padding:8px;font-size:12px;" placeholder="Remarks (optional)" value="${esc(r.remarks || "")}">
          <button onclick="refUpdate('${r.id}')" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Update</button>
        </div>
        ${r.history && r.history.length ? `<div style="margin-top:8px;font-size:10px;color:rgba(30,5,5,.5);font-family:monospace;">${r.history.map((h) => `${esc(h.ts)} — ${esc(h.status)} by ${esc(h.by)}`).join("<br>")}</div>` : ""}
      </div>`).join("");
    el.innerHTML = adminSearchBox("refAdminQBox", "refAdminQ", "renderReferral", "Search by name or student ID…", refAdminQ)
      + (rows || emptyState(refAdminQ ? "No referrals match your search." : "No referrals submitted yet.")) + modulePagination("ref-admin", list.length, "renderReferral");
    enableRequestDropdowns(el);
  } else {
    const mine = MOD.referrals.filter((r) => r.sn === session.id).reverse();
    const minePage = getModulePage("ref-student", mine);
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>New Referral / Intervention Request</div>
        <div style="display:grid;gap:10px;">
          <div><span class="input-label">Category</span>
            <select id="refCat" class="glass-input"><option>Academic Concern</option><option>Personal / Emotional</option><option>Behavioral</option><option>Financial Assistance</option><option>Health &amp; Wellness</option><option>Others</option></select></div>
          <div><span class="input-label">Details</span>
            <textarea id="refDetails" class="glass-input" rows="4" placeholder="Describe the concern or the support you need…"></textarea></div>
          <button onclick="refSubmit()" class="btn-gold" style="padding:11px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Request</button>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Referrals</div>
      ${mine.length ? minePage.items.map((r) => `
        <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(r.category)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(r.ts)}</span></div>
            ${pill(r.status)}
          </div>
          <div style="font-size:12px;color:rgba(30,5,5,.75);margin-top:6px;white-space:pre-wrap;">${esc(r.details)}</div>
          ${r.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>OSS remarks:</b> ${esc(r.remarks)}</div>` : ""}
        </div>`).join("") : emptyState("You have not submitted any referrals yet.")}
      ${modulePagination("ref-student", mine.length, "renderReferral")}
    `;
    enableRequestDropdowns(el);
  }
}
async function refSubmit() {
  const cat = document.getElementById("refCat").value;
  const det = document.getElementById("refDetails").value.trim();
  if (!det) { showToast("⚠️ Please describe your concern.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/referrals", { method: "POST", body: { category: cat, details: det } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Referral submitted.");
  await loadModule("referrals"); renderReferral();
}
async function refUpdate(id) {
  const st = document.getElementById("refst-" + id).value;
  const rm = document.getElementById("refrm-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/referrals/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, remarks: rm } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and student notified.");
  await loadModule("referrals"); renderReferral();
}


const ID_STATUSES = ["Pending", "OR Verified", "Approved", "Processing", "Ready for Claiming", "Claimed", "Rejected"];
function renderIdApp() {
  const el = document.getElementById("idappBody");
  if (isAdmin()) {
    const list = [...MOD.idapps].reverse().filter((a) => matchQ(idaAdminQ, [a.name, a.sn, a.id, a.type, a.status]));
    const rows = getModulePage("idapp-admin", list).items.map((a) => `
      <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(a.name)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(a.sn)} · ${esc(a.type)} · ${esc(a.ts)}</span></div>
          ${pill(a.status)}
        </div>
        <div style="font-size:12px;color:rgba(30,5,5,.8);margin:6px 0;">${esc(a.reason)}</div>
        <div style="margin-bottom:8px;display:flex;gap:12px;flex-wrap:wrap;">${fileLink(a.orName, a.orUrl, "View Official Receipt")}${a.affidavitUrl ? fileLink(a.affidavitName, a.affidavitUrl, "View Affidavit of Loss") : ""}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select id="idst-${a.id}" class="glass-input" style="max-width:210px;padding:8px;font-size:12px;">
            ${ID_STATUSES.map((s) => `<option ${s === a.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <input id="idrm-${a.id}" class="glass-input" style="flex:1;min-width:160px;padding:8px;font-size:12px;" placeholder="Remarks (optional)" value="${esc(a.remarks || "")}">
          <button onclick="idUpdate('${a.id}')" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Update</button>
        </div>
      </div>`).join("");
    el.innerHTML = adminSearchBox("idaAdminQBox", "idaAdminQ", "renderIdApp", "Search by name or student ID…", idaAdminQ)
      + (rows || emptyState(idaAdminQ ? "No applications match your search." : "No ID applications yet.")) + modulePagination("idapp-admin", list.length, "renderIdApp");
    enableRequestDropdowns(el);
  } else {
    const mine = MOD.idapps.filter((a) => a.sn === session.id).reverse();
    const minePage = getModulePage("idapp-student", mine);
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>New ID Application</div>
        <div style="display:grid;gap:10px;">
          <div><span class="input-label">Application Type</span>
            <select id="idType" class="glass-input" onchange="toggleAffidavitField()"><option>New ID</option><option>ID Replacement — Lost</option><option>ID Replacement — Damaged</option></select></div>
          <div><span class="input-label">Reason / Details</span>
            <textarea id="idReason" class="glass-input" rows="3" placeholder="e.g., Lost my ID on campus last week…"></textarea></div>
          <div id="idReceiptField"><span class="input-label">Official Receipt (OR) — required for New ID and damaged replacement</span>
            <input id="idOr" type="file" accept=".jpg,.jpeg,.png,.pdf" class="glass-input" style="padding:9px;">
            <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Pay at the cashier first, then upload a photo/scan of your OR (JPG, PNG, or PDF, max 1.5 MB).</div></div>
          <div id="lostIdNoFee" class="info-box" style="display:none;font-size:11px;padding:10px 12px;"><i class="fa-solid fa-circle-info" style="color:#D4A017;margin-right:5px;"></i>Lost ID replacement has no payment. Upload the Affidavit of Loss below.</div>
          <div id="affidavitField" style="display:none;"><span class="input-label">Affidavit of Loss — required for a lost ID</span>
            <input id="idAffidavit" type="file" accept=".jpg,.jpeg,.png,.pdf" class="glass-input" style="padding:9px;">
            <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Upload the signed Affidavit of Loss (JPG, PNG, or PDF, max 1.5 MB).</div></div>
          <button onclick="idSubmit()" class="btn-gold" style="padding:11px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Application</button>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Applications</div>
      ${mine.length ? minePage.items.map((a) => `
        <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(a.type)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(a.ts)}</span></div>
            ${pill(a.status)}
          </div>
          <div style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;">${fileLink(a.orName, a.orUrl, "My uploaded OR")}${a.affidavitUrl ? fileLink(a.affidavitName, a.affidavitUrl, "My Affidavit of Loss") : ""}</div>
          ${a.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>OSS remarks:</b> ${esc(a.remarks)}</div>` : ""}
        </div>`).join("") : emptyState("No applications yet.")}
      ${modulePagination("idapp-student", mine.length, "renderIdApp")}
    `;
    enableRequestDropdowns(el);
  }
}
async function idSubmit() {
  const type = document.getElementById("idType").value;
  const reason = document.getElementById("idReason").value.trim();
  const orInput = document.getElementById("idOr");
  const affidavitInput = document.getElementById("idAffidavit");
  if (!reason) { showToast("⚠️ Please provide the reason/details.", "rgba(180,130,0,.85)"); return; }
  let uploaded = { fileName: "", url: "" };
  if (type !== "ID Replacement — Lost") {
    if (!orInput.files.length) { showToast("⚠️ Official Receipt upload is required.", "rgba(180,130,0,.85)"); return; }
    uploaded = await uploadFile(orInput);
    if (uploaded === false || !uploaded.url) { showToast("⚠️ Official Receipt upload is required.", "rgba(180,130,0,.85)"); return; }
  }
  let affidavit = { fileName: "", url: "" };
  if (type === "ID Replacement — Lost") {
    if (!affidavitInput.files.length) { showToast("⚠️ An Affidavit of Loss is required for a lost ID.", "rgba(180,130,0,.85)"); return; }
    affidavit = await uploadFile(affidavitInput);
    if (affidavit === false || !affidavit.url) return;
  }
  const { ok, error } = await api("/api/modules/idapps", { method: "POST", body: { type, reason, orName: uploaded.fileName, orUrl: uploaded.url, affidavitName: affidavit.fileName, affidavitUrl: affidavit.url } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast(type === "ID Replacement — Lost" ? "✅ Lost ID application submitted." : "✅ Application submitted with OR.");
  await loadModule("idapps"); renderIdApp();
}
function toggleAffidavitField() {
  const field = document.getElementById("affidavitField");
  const isLost = document.getElementById("idType").value === "ID Replacement — Lost";
  if (field) field.style.display = isLost ? "block" : "none";
  const receipt = document.getElementById("idReceiptField");
  if (receipt) receipt.style.display = isLost ? "none" : "block";
  const noFee = document.getElementById("lostIdNoFee");
  if (noFee) noFee.style.display = isLost ? "block" : "none";
}
async function idUpdate(id) {
  const st = document.getElementById("idst-" + id).value;
  const rm = document.getElementById("idrm-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/idapps/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, remarks: rm } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and student notified.");
  await loadModule("idapps"); renderIdApp();
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
function renderHelpdesk() {
  const el = document.getElementById("helpdeskBody");
  const thread = (t) => `
    <div style="background:rgba(255,255,255,.55);border:1px solid rgba(139,26,26,.08);border-radius:10px;padding:10px;margin-top:8px;max-height:220px;overflow-y:auto;">
      ${t.msgs.map((m) => `
        <div style="margin-bottom:8px;${m.from === "admin" ? "text-align:right;" : ""}">
          <div style="display:inline-block;max-width:85%;text-align:left;background:${m.from === "admin" ? "rgba(139,26,26,.08)" : "rgba(245,197,24,.12)"};border-radius:10px;padding:7px 10px;">
            <div style="font-size:9px;font-weight:800;color:rgba(30,5,5,.5);">${esc(m.by)} · ${esc(m.ts)}</div>
            <div style="font-size:12px;color:#1a0505;white-space:pre-wrap;">${esc(m.text)}</div>
          </div>
        </div>`).join("")}
    </div>`;
  const replyBox = (t, who) => t.status === "Closed" ? "" : `
    <div style="display:flex;gap:8px;margin-top:8px;">
      <input id="hdrep-${t.id}" class="glass-input" style="flex:1;padding:8px;font-size:12px;" placeholder="Type a ${who === "admin" ? "response" : "reply"}…">
      <button onclick="hdReply('${t.id}', this)" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Send</button>
      ${who === "admin" ? `<button onclick="hdClose('${t.id}')" class="btn-ghost" style="padding:8px 12px;font-size:12px;">Close</button>` : ""}
    </div>`;
  if (isAdmin()) {
    const list = [...MOD.tickets].reverse().filter((t) => matchQ(hdAdminQ, [t.name, t.sn, t.id, t.subject, t.category, t.status]));
    const rows = getModulePage("helpdesk-admin", list).items.map((t) => `
      <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(t.subject)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(t.name)} (${esc(t.sn)}) · ${esc(t.category)} · ${esc(t.ts)}</span></div>
          ${pill(t.status)}
        </div>
        ${thread(t)}${replyBox(t, "admin")}
      </div>`).join("");
    el.innerHTML = adminSearchBox("hdAdminQBox", "hdAdminQ", "renderHelpdesk", "Search by name or student ID…", hdAdminQ)
      + (rows || emptyState(hdAdminQ ? "No tickets match your search." : "No tickets yet.")) + modulePagination("helpdesk-admin", list.length, "renderHelpdesk");
    enableRequestDropdowns(el);
  } else {
    if (!chatbotMessages.length) chatbotMessages = [{ from: "bot", text: "Hi! I can answer questions using the Student Services FAQ. Ask about documents, enrollment, ID concerns, events, or other listed services." }];
    const mine = [...MOD.tickets].filter((t) => t.sn === session.id).reverse();
    const rows = getModulePage("helpdesk-student", mine).items.map((t) => `
      <div class="glass-card" data-module-request style="padding:14px;margin-top:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(t.subject)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(t.category)} · ${esc(t.ts)}</span></div>
          ${pill(t.status)}
        </div>
        ${thread(t)}${replyBox(t, "student")}
      </div>`).join("");
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;max-width:820px;margin:0 auto;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;"><div style="width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:#8B1A1A;color:#F5C518;"><i class="fa-solid fa-robot"></i></div><div><div style="font-size:15px;font-weight:900;color:#1a0505;">Student Service Help</div><div style="font-size:11px;color:rgba(30,5,5,.6);">FAQ chatbot · Answers are based on approved FAQs</div></div></div>
        <div id="chatbotMessages" style="height:420px;overflow-y:auto;padding:14px;background:rgba(255,255,255,.48);border:1px solid rgba(139,26,26,.12);border-radius:14px;display:flex;flex-direction:column;gap:10px;">
          ${chatbotMessages.map((m) => `<div style="display:flex;justify-content:${m.from === "user" ? "flex-end" : "flex-start"};"><div style="max-width:82%;padding:10px 12px;border-radius:12px;background:${m.from === "user" ? "rgba(139,26,26,.14)" : "rgba(245,197,24,.16)"};font-size:13px;color:#1a0505;line-height:1.5;white-space:pre-wrap;">${esc(m.text)}</div></div>`).join("")}
        </div>
        ${chatbotEscalationQuestion ? `<div style="margin-top:10px;padding:10px 12px;border:1px solid rgba(139,26,26,.18);background:rgba(139,26,26,.06);border-radius:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;"><span style="font-size:11px;color:rgba(30,5,5,.72);"><i class="fa-solid fa-headset" style="color:#8B1A1A;margin-right:5px;"></i>Need more help? Send this question to the Help Desk.</span><button onclick="submitChatbotTicket()" class="btn-maroon" style="padding:7px 10px;font-size:11px;"><i class="fa-solid fa-paper-plane" style="margin-right:4px;"></i>Submit Ticket</button></div>` : ""}
        <div style="margin-top:12px;"><div style="font-size:11px;font-weight:800;color:#8B1A1A;margin-bottom:7px;">Choose a frequently asked question</div><div style="display:flex;gap:7px;flex-wrap:wrap;max-height:108px;overflow-y:auto;padding-right:3px;">${MOD.faqs.length ? MOD.faqs.map((faq) => `<button onclick="chatbotAskFaq('${esc(faq.id)}')" class="btn-ghost" style="padding:7px 10px;font-size:11px;text-align:left;">${esc(faq.q)}</button>`).join("") : '<span style="font-size:11px;color:rgba(30,5,5,.55);">No FAQs are available yet.</span>'}</div></div>
        <div style="display:flex;gap:8px;margin-top:12px;"><input id="chatbotInput" class="glass-input" style="flex:1" placeholder="Ask a question about Student Services…" onkeydown="if(event.key==='Enter')chatbotAsk()"><button onclick="chatbotAsk()" class="btn-maroon" style="padding:10px 16px;"><i class="fa-solid fa-paper-plane"></i> Send</button></div>
      </div>
      <div style="margin:18px auto 0;max-width:820px;">
        <div style="font-size:15px;font-weight:900;color:#1a0505;margin-bottom:8px;"><i class="fa-solid fa-ticket" style="color:#D4A017;margin-right:7px;"></i>My Help Desk Tickets</div>
        ${rows || emptyState("No help desk tickets yet.")}
        ${modulePagination("helpdesk-student", mine.length, "renderHelpdesk")}
      </div>`;
    enableRequestDropdowns(el);
    requestAnimationFrame(() => { const box = document.getElementById("chatbotMessages"); if (box) box.scrollTop = box.scrollHeight; });
  }
}
function chatbotAsk() {
  const input = document.getElementById("chatbotInput");
  const question = input.value.trim();
  if (!question) return;
  chatbotEscalationQuestion = "";
  chatbotMessages.push({ from: "user", text: question });
  const words = chatbotKeywords(question);
  const specificWords = words.filter((word) => !chatbotGenericKeywords.has(word));
  const scored = MOD.faqs.map((faq) => ({ faq, score: chatbotFaqScore(faq, words), specificScore: chatbotFaqScore(faq, specificWords) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const minimumScore = words.length > 1 ? 2 : 3;
  const isRelevant = best?.score >= minimumScore && (!specificWords.length || best.specificScore > 0);
  api("/api/faq-analytics", { method: "POST", body: { faqId: isRelevant ? best.faq.id : "unmatched" } });
  if (isRelevant) {
    chatbotMessages.push({ from: "bot", text: `${best.faq.a}\n\nSource: ${best.faq.q}` });
  } else {
    chatbotEscalationQuestion = question;
    chatbotMessages.push({ from: "bot", text: "I couldn't find a matching FAQ for that question. You can send it to the Help Desk so an SSO staff member can assist you." });
  }
  renderHelpdesk();
}
function chatbotAskFaq(id) {
  const faq = MOD.faqs.find((item) => item.id === id);
  if (!faq) return;
  chatbotEscalationQuestion = "";
  chatbotMessages.push({ from: "user", text: faq.q });
  chatbotMessages.push({ from: "bot", text: faq.a });
  api("/api/faq-analytics", { method: "POST", body: { faqId: faq.id } });
  renderHelpdesk();
}
async function submitChatbotTicket() {
  const question = chatbotEscalationQuestion.trim();
  if (!question) return;
  const subject = `Chatbot assistance: ${question.length > 70 ? `${question.slice(0, 67)}...` : question}`;
  const { ok, error } = await api("/api/modules/tickets", { method: "POST", body: { category: "Chatbot question", subject, message: question } });
  if (!ok) { showToast(`❌ ${error || "Could not submit the Help Desk ticket."}`, "rgba(155,22,22,.85)"); return; }
  chatbotEscalationQuestion = "";
  chatbotMessages.push({ from: "bot", text: "Your question was submitted to the Help Desk. An SSO staff member will respond through your ticket." });
  await loadModule("tickets");
  showToast("✅ Help Desk ticket submitted.");
  renderHelpdesk();
}
async function hdSubmit() {
  const cat = document.getElementById("hdCat").value;
  const subj = document.getElementById("hdSubj").value.trim();
  const msg = document.getElementById("hdMsg").value.trim();
  if (!subj || !msg) { showToast("⚠️ Subject and message are required.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/tickets", { method: "POST", body: { category: cat, subject: subj, message: msg } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Ticket submitted.");
  await loadModule("tickets"); renderHelpdesk();
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
    await loadModule("tickets"); renderHelpdesk();
  } finally {
    helpDeskRepliesInFlight.delete(id);
    if (button?.isConnected) { button.disabled = false; button.textContent = "Send"; }
    if (inp?.isConnected) inp.disabled = false;
  }
}
async function hdClose(id) {
  const { ok, error } = await api(`/api/modules/tickets/${encodeURIComponent(id)}/close`, { method: "POST" });
  if (!ok) { showToast(`❌ ${error || "Could not close ticket."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("tickets"); renderHelpdesk();
}


let faqQuery = "";
let faqCategoryForEntry = "";
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
          <input id="faqCategoryName" class="glass-input" style="flex:1;min-width:220px;" placeholder="Category name (e.g., Document Requests)">
          <button onclick="faqCategoryAdd()" class="btn-gold" style="padding:10px 16px;">Add Category</button>
        </div>
      </div>`;
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
function openFaqEntryForm(category) {
  faqCategoryForEntry = category;
  openAppModal({ title: "Add FAQ", subtitle: `Category: ${category}`, icon: "fa-circle-question", content: `<div style="display:grid;gap:10px;"><input id="faqQ" class="glass-input" placeholder="Question"><textarea id="faqA" class="glass-input" rows="4" placeholder="Answer"></textarea></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button onclick="faqAdd()" class="btn-gold">Add FAQ</button></div>` });
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
  await Promise.all([loadModule("faqs"), loadFaqCategories()]); renderFaq();
}
async function faqDelete(id) {
  if (!confirm("Delete this FAQ?")) return;
  const { ok, error } = await api(`/api/modules/faqs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { showToast(`❌ ${error || "Could not delete."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("faqs"); renderFaq();
}


const EVT_STATUSES = ["Pending", "Under Review", "Approved", "Rejected", "Needs Revision", "Completed"];
let evtEditingId = null;
function renderEvents2() {
  const el = document.getElementById("events2Body");
  if (isAdmin()) {
    const list = [...MOD.events2].reverse().filter((e) => matchQ(evtAdminQ, [e.name, e.sn, e.id, e.title, e.org, e.status]));
    const rows = getModulePage("events-admin", list).items.map((e) => `
      <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(e.title)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(e.org)} · filed by ${esc(e.name)} · ${esc(e.ts)}</span></div>
          ${pill(e.status)}
        </div>
        <div style="font-size:11px;color:rgba(30,5,5,.75);margin:6px 0;line-height:1.6;">
          <b>Type:</b> ${esc(e.type)} · <b>Date:</b> ${esc(e.date)} ${esc(e.time)} · <b>Venue:</b> ${esc(e.venue)} · <b>Participants:</b> ${esc(e.participants)}${e.budget ? ` · <b>Budget:</b> ₱${esc(e.budget)}` : ""}<br>
          <b>Adviser:</b> ${esc(e.adviser)}<br>
          <b>Objectives:</b> ${esc(e.desc)}
        </div>
        <div style="margin-bottom:8px;">${fileLink(e.docName, e.docUrl, "Supporting document")}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select id="evst-${e.id}" class="glass-input" style="max-width:190px;padding:8px;font-size:12px;">
            ${EVT_STATUSES.map((s) => `<option ${s === e.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <input id="evnt-${e.id}" class="glass-input" style="flex:1;min-width:160px;padding:8px;font-size:12px;" placeholder="Note / revision request (optional)">
          <button onclick="evtUpdate('${e.id}')" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Update</button>
        </div>
        ${e.history.length ? `<div style="margin-top:8px;font-size:10px;color:rgba(30,5,5,.5);font-family:monospace;">${e.history.map((h) => `${esc(h.ts)} — ${esc(h.status)}${h.note ? ": " + esc(h.note) : ""} (${esc(h.by)})`).join("<br>")}</div>` : ""}
      </div>`).join("");
    el.innerHTML = adminSearchBox("evtAdminQBox", "evtAdminQ", "renderEvents2", "Search by name, student ID, or org…", evtAdminQ)
      + (rows || emptyState(evtAdminQ ? "No event requests match your search." : "No event requests yet.")) + modulePagination("events-admin", list.length, "renderEvents2");
    enableRequestDropdowns(el);
  } else {
    const mine = MOD.events2.filter((e) => e.sn === session.id).reverse();
    const minePage = getModulePage("events-student", mine);
    const editing = evtEditingId ? MOD.events2.find((e) => e.id === evtEditingId) : null;
    const canSubmit = MY_ORGANIZATIONS.length > 0;
    const organizationOptions = MY_ORGANIZATIONS.map((o) => `<option value="${esc(o.id)}" ${editing && editing.organizationId === o.id ? "selected" : ""}>${esc(o.name)}</option>`).join("");
    el.innerHTML = `
      ${canSubmit ? `<div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>${editing ? "Revise Event Request" : "New Event Request"}</div>
        <div style="display:grid;gap:10px;">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
            <div><span class="input-label">Event Title</span><input id="evTitle" class="glass-input" value="${editing ? esc(editing.title) : ""}"></div>
            <div><span class="input-label">Event Type</span><select id="evType" class="glass-input"><option ${editing && editing.type === "Inside Campus" ? "selected" : ""}>Inside Campus</option><option ${editing && editing.type === "Outside Campus" ? "selected" : ""}>Outside Campus</option></select></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div><span class="input-label">Organization</span><select id="evOrgId" onchange="syncEventAdviser()" class="glass-input"><option value="">Select assigned organization</option>${organizationOptions}</select></div>
            <div><span class="input-label">Faculty Adviser</span><input id="evAdv" class="glass-input" readonly value="${editing ? esc(editing.adviser) : ""}" placeholder="Auto-filled from organization"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
            <div><span class="input-label">Date</span><input id="evDate" type="date" class="glass-input" value="${editing ? esc(editing.date) : ""}"></div>
            <div><span class="input-label">Time</span><input id="evTime" type="time" class="glass-input" value="${editing ? esc(editing.time) : ""}"></div>
            <div><span class="input-label">Expected Participants</span><input id="evPart" type="number" min="1" class="glass-input" value="${editing ? esc(editing.participants) : ""}"></div>
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
            <div><span class="input-label">Venue</span><input id="evVenue" class="glass-input" value="${editing ? esc(editing.venue) : ""}"></div>
            <div><span class="input-label">Budget (₱, optional)</span><input id="evBudget" type="number" min="0" class="glass-input" value="${editing ? esc(editing.budget) : ""}"></div>
          </div>
          <div><span class="input-label">Objectives / Description</span><textarea id="evDesc" class="glass-input" rows="3">${editing ? esc(editing.desc) : ""}</textarea></div>
          <div><span class="input-label">Supporting Document (adviser endorsement, program flow…) ${editing && editing.docName ? "— current: " + esc(editing.docName) : ""}</span>
            <input id="evDoc" type="file" accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" class="glass-input" style="padding:9px;"></div>
          <div style="display:flex;gap:8px;">
            <button onclick="evtSubmit()" class="btn-gold" style="padding:11px 18px;">${editing ? "Resubmit for Review" : "Submit Request"}</button>
            ${editing ? '<button onclick="evtEditingId=null;renderEvents2()" class="btn-ghost" style="padding:11px 14px;">Cancel</button>' : ""}
          </div>
        </div>
      </div>` : `<div class="glass-card" style="padding:18px;margin-bottom:16px;border:1px solid rgba(139,26,26,.20);"><div style="font-weight:800;color:#8B1A1A;margin-bottom:5px;"><i class="fa-solid fa-user-shield" style="margin-right:6px;"></i>Organization representative access required</div><div style="font-size:12px;color:rgba(30,5,5,.68);line-height:1.6;">Only active student officers assigned by the Super Admin or SSO Admin can submit an Event Request. Contact the Student Services Office if a representative needs to be assigned.</div></div>`}
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Event Requests</div>
      ${mine.length ? minePage.items.map((e) => `
        <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(e.title)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(e.org)} · ${esc(e.date)}</span></div>
            <div style="display:flex;gap:6px;align-items:center;">
              ${pill(e.status)}
              ${e.status === "Needs Revision" ? `<button onclick="evtEditingId='${e.id}';renderEvents2();window.scrollTo(0,0);" class="btn-maroon" style="padding:6px 10px;font-size:11px;">Revise</button>` : ""}
            </div>
          </div>
          ${e.history.length ? `<div style="margin-top:6px;font-size:10px;color:rgba(30,5,5,.55);font-family:monospace;">${e.history.map((h) => `${esc(h.ts)} — ${esc(h.status)}${h.note ? ": " + esc(h.note) : ""}`).join("<br>")}</div>` : ""}
        </div>`).join("") : emptyState("No event requests yet.")}
      ${modulePagination("events-student", mine.length, "renderEvents2")}
    `;
    enableRequestDropdowns(el);
    if (canSubmit) syncEventAdviser();
  }
}
function syncEventAdviser() {
  const selected = MY_ORGANIZATIONS.find((org) => org.id === document.getElementById("evOrgId")?.value);
  const adviser = document.getElementById("evAdv");
  if (adviser) adviser.value = selected ? selected.adviserName : "";
}
async function evtSubmit() {
  const g = (id) => document.getElementById(id).value.trim();
  const title = g("evTitle"), organizationId = document.getElementById("evOrgId").value, org = MY_ORGANIZATIONS.find((o) => o.id === organizationId)?.name || "", adviser = g("evAdv"), date = g("evDate"), time = g("evTime"),
    venue = g("evVenue"), participants = g("evPart"), budget = g("evBudget"), desc = g("evDesc"),
    type = document.getElementById("evType").value;
  if (!title || !org || !adviser || !date || !venue || !participants || !desc) { showToast("⚠️ Please complete all required fields.", "rgba(180,130,0,.85)"); return; }

  const docInput = document.getElementById("evDoc");
  let docName = "", docUrl = "";
  if (docInput.files.length) {
    const uploaded = await uploadFile(docInput);
    if (uploaded === false) return;
    docName = uploaded.fileName || ""; docUrl = uploaded.url || "";
  }

  if (!organizationId) { showToast("Select an assigned organization first.", "rgba(180,130,0,.85)"); return; }
  if (!docName && !evtEditingId) { showToast("Upload the adviser endorsement or supporting document.", "rgba(180,130,0,.85)"); return; }
  const body = { title, organizationId, org, adviser, date, time, venue, participants, budget, desc, type, docName, docUrl };
  const res = evtEditingId
    ? await api(`/api/modules/events2/${encodeURIComponent(evtEditingId)}/resubmit`, { method: "POST", body })
    : await api("/api/modules/events2", { method: "POST", body });

  if (!res.ok) { showToast(`❌ ${res.error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  evtEditingId = null;
  showToast("✅ Event request submitted.");
  await loadModule("events2"); renderEvents2();
}
async function evtUpdate(id) {
  const st = document.getElementById("evst-" + id).value;
  const note = document.getElementById("evnt-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/events2/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, note } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and requester notified.");
  await loadModule("events2"); renderEvents2();
}


const CMP_STATUSES = ["Submitted", "Under Investigation", "Resolved", "Dismissed"];
function renderComplaint() {
  const el = document.getElementById("complaintBody");
  if (isAdmin()) {
    const list = [...MOD.complaints].reverse().filter((c) => matchQ(cmpAdminQ, [c.name, c.sn, c.id, c.category, c.status]));
    const rows = getModulePage("complaints-admin", list).items.map((c) => `
      <div class="glass-card" data-module-request style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(c.id)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(c.category)} · ${esc(c.ts)}</span></div>
          ${pill(c.status)}
        </div>
        <div style="font-size:10px;color:#8B1A1A;margin:4px 0;"><i class="fa-solid fa-lock" style="margin-right:4px;"></i>CONFIDENTIAL — Complainant: ${esc(c.name)} (${esc(c.sn)})</div>
        <div style="font-size:12px;color:rgba(30,5,5,.8);margin:6px 0;white-space:pre-wrap;">${esc(c.details)}</div>
        <div style="margin-bottom:8px;">${fileLink(c.attName, c.attUrl, "Attachment")}</div>
        <div style="font-size:11px;color:#8B1A1A;margin:0 0 8px;"><i class="fa-solid fa-user-shield" style="margin-right:4px;"></i>${esc(c.confidentiality || "Standard")}${c.assignedTo ? ` · Assigned: ${esc(c.assignedTo)}` : ""}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select id="cmst-${c.id}" class="glass-input" style="max-width:210px;padding:8px;font-size:12px;">
            ${CMP_STATUSES.map((s) => `<option ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <input id="cmnt-${c.id}" class="glass-input" style="flex:1;min-width:160px;padding:8px;font-size:12px;" placeholder="Resolution note (visible to student)" value="${esc(c.note || "")}">
          <input id="cmassign-${c.id}" class="glass-input" style="flex:1;min-width:130px;padding:8px;font-size:12px;" placeholder="Assigned staff" value="${esc(c.assignedTo || "")}">
          <select id="cmconf-${c.id}" class="glass-input" style="max-width:170px;padding:8px;font-size:12px;">${["Standard", "Restricted", "Strictly Confidential"].map((level) => `<option ${level === (c.confidentiality || "Standard") ? "selected" : ""}>${level}</option>`).join("")}</select>
          <input id="cmstaff-${c.id}" class="glass-input" style="flex-basis:100%;padding:8px;font-size:12px;" placeholder="Internal staff notes (never visible to student)" value="${esc(c.staffNotes || "")}">
          <button onclick="cmpUpdate('${c.id}')" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Update</button>
        </div>
      </div>`).join("");
    el.innerHTML = adminSearchBox("cmpAdminQBox", "cmpAdminQ", "renderComplaint", "Search by name, student ID, or ref code…", cmpAdminQ)
      + (rows || emptyState(cmpAdminQ ? "No complaints match your search." : "No complaints filed.")) + modulePagination("complaints-admin", list.length, "renderComplaint");
    enableRequestDropdowns(el);
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
async function cmpUpdate(id) {
  const st = document.getElementById("cmst-" + id).value;
  const note = document.getElementById("cmnt-" + id).value.trim();
  const assignedTo = document.getElementById("cmassign-" + id).value.trim();
  const confidentiality = document.getElementById("cmconf-" + id).value;
  const staffNotes = document.getElementById("cmstaff-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/complaints/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, note, assignedTo, confidentiality, staffNotes } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and complainant notified.");
  await loadModule("complaints"); renderComplaint();
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


function printReceipt(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  if (!req.claimRef) { showToast("⚠️ No claim record yet — transaction must be Completed first.", "rgba(180,130,0,.85)"); return; }
  const html = `<!DOCTYPE html><html><head><title>Claim Receipt — ${esc(req.claimRef)}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',Arial,sans-serif;}
    body{padding:28px;color:#1a0505;}
    .rc{max-width:420px;margin:0 auto;border:2px solid #8B1A1A;border-radius:10px;overflow:hidden;}
    .hd{background:#8B1A1A;color:#fff;text-align:center;padding:16px 12px;}
    .hd h1{font-size:15px;letter-spacing:.08em;} .hd p{font-size:10px;opacity:.85;margin-top:2px;}
    .ttl{text-align:center;padding:12px;border-bottom:1px dashed #c9a227;}
    .ttl b{font-size:13px;letter-spacing:.14em;color:#8B1A1A;}
    .clm{text-align:center;padding:14px 12px;background:#fdf6e3;border-bottom:1px dashed #c9a227;}
    .clm .ref{font-family:'Courier New',monospace;font-size:21px;font-weight:900;letter-spacing:.06em;color:#1e40af;}
    .clm .lbl{font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:#7a4f00;margin-bottom:3px;}
    table{width:100%;border-collapse:collapse;font-size:12px;}
    td{padding:7px 14px;vertical-align:top;} td:first-child{color:#666;width:38%;font-size:11px;} td:last-child{font-weight:700;}
    .mono{font-family:'Courier New',monospace;}
    .sig{display:flex;gap:20px;padding:26px 14px 14px;}
    .sig div{flex:1;text-align:center;font-size:10px;color:#555;}
    .sig div span{display:block;border-top:1px solid #999;margin-top:26px;padding-top:4px;}
    .ft{text-align:center;font-size:9px;color:#888;padding:10px;border-top:1px dashed #c9a227;}
    @media print{ body{padding:0;} .noprint{display:none;} }
  </style></head><body>
  <div class="rc">
    <div class="hd"><h1>POLYTECHNIC UNIVERSITY OF THE PHILIPPINES</h1><p>San Pedro Campus · Student Services Office · QR-SASMS</p></div>
    <div class="ttl"><b>DOCUMENT CLAIM RECEIPT</b></div>
    <div class="clm"><div class="lbl">Claiming Reference No.</div><div class="ref">${esc(req.claimRef)}</div></div>
    <table>
      <tr><td>Request Ref No.</td><td class="mono">${esc(req.id)}</td></tr>
      <tr><td>Student Name</td><td>${esc(req.studentName)}</td></tr>
      <tr><td>Student Number</td><td class="mono">${esc(req.studentId)}</td></tr>
      <tr><td>Document</td><td>${esc(req.doc)}</td></tr>
      <tr><td>Copies</td><td>${esc(req.copies)}</td></tr>
      <tr><td>Purpose</td><td>${esc(req.purpose)}</td></tr>
      <tr><td>Date Requested</td><td>${esc(req.date)}</td></tr>
      <tr><td>Date &amp; Time Claimed</td><td>${esc(req.claimedAt)}</td></tr>
      <tr><td>Released By</td><td>${esc(req.claimedBy)}</td></tr>
      <tr><td>Status</td><td>COMPLETED — TRANSACTION CLOSED</td></tr>
    </table>
    <div class="sig">
      <div><span>Released by (SSO)</span></div>
      <div><span>Received by (Student)</span></div>
    </div>
    <div class="ft"><b>Digitally issued by QR-SASMS · PUP San Pedro Student Services Office</b><br>System-generated receipt · Verify anytime at the SSO using the claiming reference above.<br>Printed: ${esc(fnow())} · QR-SASMS v${APP_VERSION}</div>
  </div>
  <div class="noprint" style="text-align:center;margin-top:16px;">
    <button onclick="window.print()" style="background:#8B1A1A;color:#fff;border:none;padding:10px 22px;border-radius:8px;font-weight:800;cursor:pointer;">Print</button>
    <button onclick="window.close()" style="background:#eee;border:1px solid #ccc;padding:10px 18px;border-radius:8px;font-weight:700;cursor:pointer;margin-left:6px;">Close</button>
  </div>
  <script>setTimeout(function(){ try{window.print();}catch(e){} }, 400);<\/script>
  </body></html>`;
  const w = window.open("", "_blank", "width=520,height=720");
  if (!w) { showToast("⚠️ Pop-up blocked — please allow pop-ups to print the receipt.", "rgba(180,130,0,.85)"); return; }
  w.document.write(html);
  w.document.close();
}

function printApproval(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req || !["Approved", "Ready to Claim", "Completed"].includes(req.status)) return showToast("⚠️ This request has not been approved yet.", "rgba(180,130,0,.85)");
  const html = `<!DOCTYPE html><html><head><title>Approval Certificate — ${esc(req.id)}</title><style>*{box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif}body{padding:32px;color:#1a0505}.card{max-width:650px;margin:auto;border:2px solid #8B1A1A;padding:32px;text-align:center}.seal{color:#8B1A1A;font-weight:900;letter-spacing:.08em}.title{font-size:25px;font-weight:900;margin:30px 0 12px}.body{font-size:15px;line-height:1.75;text-align:left}.ref{font-family:monospace;color:#1e40af;font-weight:900}.signature{margin-top:42px;border-top:1px solid #555;padding-top:6px;width:240px;margin-left:auto;text-align:center;font-size:12px}.foot{margin-top:30px;font-size:10px;color:#666}@media print{body{padding:0}.noprint{display:none}}</style></head><body><div class="card"><div class="seal">POLYTECHNIC UNIVERSITY OF THE PHILIPPINES<br><small>San Pedro Campus · Student Services Office</small></div><div class="title">DOCUMENT APPROVAL CERTIFICATE</div><div class="body">This certifies that the document request <span class="ref">${esc(req.id)}</span> submitted by <b>${esc(req.studentName)}</b> (${esc(req.studentId)}) for <b>${esc(req.doc)}</b> has been approved by the Student Services Office.<br><br><b>Purpose:</b> ${esc(req.purpose)}<br><b>Copies:</b> ${esc(req.copies)}<br><b>Current status:</b> ${esc(req.status)}<br><b>Date submitted:</b> ${esc(req.date)}</div><div class="signature">Server-signed by QR-SASMS<br>Student Services Office</div><div class="foot">Verification reference: ${esc(req.id)}<br>Integrity signature: ${esc(req.signature || "Issued before signing was enabled")}<br>Generated ${esc(fnow())}.</div></div><div class="noprint" style="text-align:center;margin-top:16px"><button onclick="window.print()">Print / Save as PDF</button></div><script>setTimeout(()=>window.print(),400);<\/script></body></html>`;
  const w = window.open("", "_blank", "width=760,height=780");
  if (!w) return showToast("⚠️ Please allow pop-ups to print the certificate.", "rgba(180,130,0,.85)");
  w.document.write(html); w.document.close();
}


async function verifyRef() {
  const q = (document.getElementById("verifyRefInput").value || "").trim();
  const box = document.getElementById("verifyRefResult");
  if (!q) { box.innerHTML = ""; return; }

  const { ok, data } = await api(`/api/requests/verify?ref=${encodeURIComponent(q)}`);
  if (!ok || !data || !data.found) {
    box.innerHTML = `<div class="glass-card" style="padding:16px;border:1px solid rgba(220,38,38,.4);">
      <div style="font-size:13px;font-weight:800;color:#991b1b;"><i class="fa-solid fa-circle-xmark" style="margin-right:6px;"></i>NOT FOUND</div>
      <div style="font-size:12px;color:rgba(30,5,5,.7);margin-top:4px;">No record matches "<span style="font-family:monospace;">${esc(q.toUpperCase())}</span>". The reference may be mistyped or the document was not issued by this office.</div>
    </div>`;
    showToast("❌ Reference not found.", "rgba(155,22,22,.85)");
    return;
  }

  const req = data.request;
  const bc = badgeClass(req.status);
  const claimBlock = req.claimRef ? `
      <div class="detail-row"><span class="detail-label">Claiming Ref.</span><span class="detail-value" style="font-family:monospace;font-weight:800;color:#1e40af;">${req.claimRef}</span></div>
      <div class="detail-row"><span class="detail-label">Claimed On</span><span class="detail-value">${req.claimedAt}</span></div>
      <div class="detail-row"><span class="detail-label">Released By</span><span class="detail-value">${req.claimedBy}</span></div>` : "";
  const action = req.status === "Ready to Claim"
    ? `<button onclick="adminAction('${req.id}','Completed').then(verifyRef)" class="btn-maroon" style="width:100%;margin-top:12px;padding:11px;font-size:13px;"><i class="fa-solid fa-flag-checkered" style="margin-right:6px;"></i>Mark as Claimed — Complete Transaction</button>`
    : (req.status === "Completed"
      ? `<button onclick="printReceipt('${req.id}')" class="btn-maroon" style="width:100%;margin-top:12px;padding:11px;font-size:13px;"><i class="fa-solid fa-print" style="margin-right:6px;"></i>Print Claim Receipt</button>`
      : "");
  box.innerHTML = `<div class="glass-card" style="padding:16px;border:1px solid rgba(34,197,94,.4);">
    <div style="font-size:13px;font-weight:800;color:#166534;margin-bottom:10px;"><i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>RECORD VERIFIED — AUTHENTIC</div>
    <div class="detail-row"><span class="detail-label">Request Ref.</span><span class="detail-value" style="font-family:monospace;">${req.id}</span></div>
    <div class="detail-row"><span class="detail-label">Student</span><span class="detail-value">${req.studentName}</span></div>
    <div class="detail-row"><span class="detail-label">Student No.</span><span class="detail-value" style="font-family:monospace;font-size:12px;">${req.studentId}</span></div>
    <div class="detail-row"><span class="detail-label">Document</span><span class="detail-value">${req.doc}</span></div>
    <div class="detail-row"><span class="detail-label">Purpose</span><span class="detail-value">${req.purpose}</span></div>
    <div class="detail-row"><span class="detail-label">Copies</span><span class="detail-value">${req.copies}</span></div>
    <div class="detail-row"><span class="detail-label">Date Requested</span><span class="detail-value">${req.date}</span></div>
    <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value"><span class="badge ${bc}">${req.status}</span></span></div>
    ${claimBlock}
    <div style="margin-top:10px;font-size:11px;font-weight:700;color:#166534;background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:9px;padding:8px 10px;"><i class="fa-solid fa-file-circle-check" style="margin-right:5px;"></i>Matches the student's request receipt on file — details above are exactly as submitted.</div>
    ${action}
  </div>`;
  showToast("✅ Record verified.", "rgba(21,128,61,.85)");
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
    requests: DB.map((r) => `${r.id}:${r.status}`),
    appointments: queueData.map((q) => `${q.q}:${q.served}`),
  });
  window.setInterval(async () => {
    if (!session || !isAdmin() || adminDashboardRefreshInFlight || document.querySelector(".page.active")?.id !== "page-admin") return;
    adminDashboardRefreshInFlight = true;
    try {
      await Promise.all([loadRequests(), loadQueueData(), loadAdminActivity(), loadPendingAccounts()]);
      const nextSnapshot = JSON.stringify({
        requests: DB.map((r) => `${r.id}:${r.status}`),
        appointments: queueData.map((q) => `${q.q}:${q.served}`),
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
  if (text.includes("event request") || text.includes("event ")) return "page-events2";
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


let rejectTargetId = null;
function openRejectModal(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  const rejectModal = document.getElementById("rejectModal");
  if (rejectModal && rejectModal.parentElement !== document.body) document.body.appendChild(rejectModal);
  rejectTargetId = reqId;
  document.getElementById("rejectModalMeta").innerHTML = `<b>${esc(req.studentName)}</b> · ${esc(req.doc)} · <span style="font-family:monospace;">${esc(req.id)}</span>`;
  document.getElementById("rejectReasonInput").value = "";
  document.getElementById("rejectReasonErr").style.display = "none";
  rejectModal.classList.add("open");
  setTimeout(() => { const t = document.getElementById("rejectReasonInput"); if (t) t.focus(); }, 80);
}
function closeRejectModal() { rejectTargetId = null; document.getElementById("rejectModal").classList.remove("open"); }
function confirmReject() {
  const reason = document.getElementById("rejectReasonInput").value.trim();
  if (!reason) { document.getElementById("rejectReasonErr").style.display = "block"; return; }
  const id = rejectTargetId;
  closeRejectModal();
  if (id) adminAction(id, "Rejected", reason);
}


function mountVersionBadge() {
  const vb = document.createElement("div");
  vb.style.cssText = "position:fixed;bottom:8px;right:12px;font-size:10px;font-weight:800;color:rgba(30,5,5,.45);z-index:60;pointer-events:none;letter-spacing:.04em;";
  vb.textContent = "QR-SASMS v" + APP_VERSION;
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


async function openReports() {
  const result = await api("/api/reports/analytics");
  if (!result.ok) return showToast("Could not load analytics.", "rgba(155,22,22,.85)");
  const a = result.data;
  const group = (title, items) => `<div class="app-field"><label>${esc(title)}</label><div class="app-list">${(items || []).length ? items.map((x) => `<div class="app-row"><span class="app-row-title">${esc(x.label)}</span><b style="color:#8B1A1A">${esc(x.count)}</b></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No data yet.</span></div>`}</div></div>`;
  openAppModal({ title: "Reports & Analytics", subtitle: "View service trends or export an official CSV report.", icon: "fa-chart-column", wide: true, content: `<div class="app-modal-grid">${group("Students by course", a.byCourse)}${group("Students by year level", a.byYear)}${group("Most requested services", a.services)}${group("Peak appointment times", a.peakTimes)}</div><div class="app-modal-actions"><button class="btn-soft" onclick="window.open('/api/reports/export?type=requests','_blank')">Requests CSV</button><button class="btn-soft" onclick="window.open('/api/reports/export?type=appointments','_blank')">Appointments CSV</button><button class="btn-soft" onclick="window.open('/api/reports/export?type=complaints','_blank')">Complaints CSV</button><button class="btn-maroon" onclick="printAnalyticsReport(window.__qrsAnalytics);">Print / Save PDF</button></div>` });
  window.__qrsAnalytics = a;
}

async function viewFaqAnalytics() {
  const result = await api("/api/faq-analytics");
  if (!result.ok) return showToast("Could not load FAQ analytics.", "rgba(155,22,22,.85)");
  const items = result.data.matches || [];
  openAppModal({ title: "FAQ Chatbot Usage", subtitle: "Questions recorded from the Student Service Help chatbot.", icon: "fa-chart-simple", content: `<div class="app-metric"><span class="app-row-meta">Total chatbot queries</span><b>${esc(result.data.totalQueries)}</b></div><div class="app-list" style="margin-top:16px;">${items.length ? items.map((x) => `<div class="app-row"><div><div class="app-row-title">${esc(x.question)}</div><div class="app-row-meta">Matched or unmatched FAQ query</div></div><b style="color:#8B1A1A">${esc(x.count)}</b></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No chatbot questions recorded yet.</span></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button></div>` });
}

async function manageSystemSettings() {
  const result = await api("/api/settings");
  if (!result.ok) return showToast("Could not load settings.", "rgba(155,22,22,.85)");
  const s = result.data;
  openAppModal({ title: "System Settings", subtitle: "Control appointments, registration courses, and outgoing email content.", icon: "fa-sliders", wide: true, content: `<div class="app-modal-grid">${modalField("Business hours (comma-separated)", "setHours", (s.businessHours || []).join(", "), "full")}${modalField("Capacity per appointment slot", "setCapacity", s.appointmentCapacity)}${modalField("Cancellation / reschedule cutoff (hours)", "setCutoff", s.cancellationCutoffHours)}${modalField("Closed dates / holidays", "setHolidays", (s.holidays || []).join(", "), "full")}${modalField("Available registration courses (comma-separated)", "setCourses", (s.courses || DEFAULT_REGISTRATION_COURSES).join(", "), "full")}<div class="app-field full"><label for="setEmailTemplate">Email template</label><textarea id="setEmailTemplate" class="glass-input">${esc(s.emailTemplate || "{{message}}\n\n— QR-SASMS")}</textarea><span class="app-row-meta">Available placeholders: {{name}}, {{title}}, {{message}}</span></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="saveSystemSettings()"><i class="fa-solid fa-floppy-disk"></i> Save settings</button></div>` });
}
async function saveSystemSettings() {
  const hours = document.getElementById("setHours")?.value.split(",").map((x) => x.trim()).filter(Boolean) || [];
  const result = await api("/api/settings", { method: "PUT", body: { businessHours: hours, appointmentCapacity: Number(document.getElementById("setCapacity")?.value), cancellationCutoffHours: Number(document.getElementById("setCutoff")?.value), holidays: (document.getElementById("setHolidays")?.value || "").split(",").map((x) => x.trim()).filter(Boolean), courses: (document.getElementById("setCourses")?.value || "").split(",").map((x) => x.trim()).filter(Boolean), emailTemplate: document.getElementById("setEmailTemplate")?.value || "" } });
  if (result.ok) closeAppModal();
  showToast(result.ok ? "System settings saved." : (result.error || "Could not save settings."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function manageStaffAccounts() {
  const result = await api("/api/users/staff");
  if (!result.ok) return showToast("Could not load staff accounts.", "rgba(155,22,22,.85)");
  window.__qrsStaff = result.data;
  const list = result.data;
  openAppModal({ title: "Staff Accounts", subtitle: "Super Admin controls for Admin and Scanner accounts.", icon: "fa-user-shield", wide: true, content: `<div class="app-list">${list.length ? list.map((u) => `<div class="app-row"><div><div class="app-row-title">${esc(u.name)} ${pill(u.role)}</div><div class="app-row-meta">${esc(u.email)} · ${u.active ? "Active" : "Deactivated"}</div></div><button class="btn-soft" onclick="openStaffEditor('${esc(u.id)}')">Edit</button></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No staff accounts yet.</span></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button><button class="btn-maroon" onclick="openStaffEditor()"><i class="fa-solid fa-user-plus"></i> Add staff account</button></div>` });
}
function openStaffEditor(id) {
  const u = id ? (window.__qrsStaff || []).find((x) => x.id === id) : null;
  openAppModal({ title: u ? "Edit Staff Account" : "Create Staff Account", subtitle: u ? "Update access role or deactivate this account." : "Create an Admin or Scanner account with a temporary password.", icon: "fa-user-gear", content: `<div class="app-modal-grid">${modalField("Full name", "staffName", u?.name || "")}${modalField("Email", "staffEmail", u?.email || "")}<div class="app-field"><label for="staffRole">Role</label><select id="staffRole" class="glass-input"><option value="ADMIN" ${u?.role === "ADMIN" ? "selected" : ""}>Admin</option><option value="SCANNER" ${u?.role === "SCANNER" ? "selected" : ""}>Scanner</option></select></div>${u ? `<div class="app-field"><label for="staffActive">Account status</label><select id="staffActive" class="glass-input"><option value="true" ${u.active ? "selected" : ""}>Active</option><option value="false" ${!u.active ? "selected" : ""}>Deactivated</option></select></div>` : `<div class="app-field"><label for="staffPassword">Temporary password</label><input id="staffPassword" class="glass-input" type="password" placeholder="At least 10 characters"></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="manageStaffAccounts()">Back</button><button class="btn-maroon" onclick="saveStaffAccount('${u?.id || ""}')">${u ? "Save changes" : "Create account"}</button></div>` });
}
async function saveStaffAccount(id) {
  const name = document.getElementById("staffName")?.value.trim(), email = document.getElementById("staffEmail")?.value.trim(), role = document.getElementById("staffRole")?.value;
  const result = id ? await api(`/api/users/staff/${encodeURIComponent(id)}`, { method: "PATCH", body: { name, role, active: document.getElementById("staffActive")?.value === "true" } }) : await api("/api/users/staff", { method: "POST", body: { name, email, role, password: document.getElementById("staffPassword")?.value } });
  if (result.ok) return manageStaffAccounts();
  showToast(result.error || "Could not save staff account.", "rgba(155,22,22,.85)");
}

function scopeArgOf(scope) { return scope ? `{schoolYear:'${esc(scope.schoolYear)}',course:'${esc(scope.course)}',year:'${esc(scope.year)}'}` : "null"; }

async function manageMasterlist(query = "", scope = null) {
  const result = await api("/api/masterlist?full=1");
  if (!result.ok) return showToast("Could not load the masterlist.", "rgba(155,22,22,.85)");
  window.__qrsMasterlist = result.data;
  renderMasterlistShell(query, scope);
}
function renderMasterlistShell(query, scope) {
  const all = window.__qrsMasterlist || [];
  const scopeArg = scopeArgOf(scope);
  const scoped = scope ? all.filter((e) => e.schoolYear === scope.schoolYear && e.course === scope.course && e.year === scope.year) : all;
  const toolbar = scope
    ? `<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;"><button class="btn-soft" onclick="manageMasterlistGroups()"><i class="fa-solid fa-arrow-left"></i> Back to Groups</button><label class="btn-soft" style="cursor:pointer;"><i class="fa-solid fa-file-import"></i> Import CSV for this group<input type="file" accept=".csv" style="display:none;" onchange="handleGroupCSV(this,'${esc(scope.schoolYear)}','${esc(scope.course)}','${esc(scope.year)}')"></label></div>`
    : "";
  openAppModal({
    title: scope ? `Masterlist — ${scope.schoolYear} · ${scope.course} · ${scope.year}` : "Masterlist Manager",
    subtitle: scope ? `${scoped.length} student${scoped.length === 1 ? "" : "s"} in this group.` : `${all.length} student${all.length === 1 ? "" : "s"} in the masterlist. Add, edit, or remove individual entries.`,
    icon: "fa-users-rectangle",
    wide: true,
    content: `${toolbar}<input class="glass-input" placeholder="Search student no., name, or course…" value="${esc(query)}" oninput="filterMasterlistList(this.value, ${scopeArg})" style="margin-bottom:12px;"><div id="mlResultsList" class="app-list" style="max-height:340px;overflow-y:auto;"></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button><button class="btn-maroon" onclick="openMasterlistEditor(null, ${scopeArg})"><i class="fa-solid fa-user-plus"></i> Add entry</button></div>`,
  });
  renderMasterlistResults(query, scope);
}
function renderMasterlistResults(query, scope) {
  const container = document.getElementById("mlResultsList");
  if (!container) return;
  const all = window.__qrsMasterlist || [];
  const q = (query || "").toLowerCase();
  let list = scope ? all.filter((e) => e.schoolYear === scope.schoolYear && e.course === scope.course && e.year === scope.year) : all;
  list = list.filter((e) => !q || e.sn.toLowerCase().includes(q) || (e.name || "").toLowerCase().includes(q) || (e.course || "").toLowerCase().includes(q));
  const scopeArg = scopeArgOf(scope);
  container.innerHTML = list.length ? list.map((e) => `<div class="app-row"><div><div class="app-row-title">${esc(e.sn)} — ${esc(e.name || "—")}</div><div class="app-row-meta">${esc(e.email || "no email")} · ${esc(e.course || "—")} ${esc(e.year || "")}${e.schoolYear ? ` · ${esc(e.schoolYear)}` : ""}</div></div><div style="display:flex;gap:6px;"><button class="btn-soft" onclick="openMasterlistEditor('${esc(e.sn)}', ${scopeArg})">Edit</button><button class="btn-soft" style="color:#b91c1c;" onclick="removeMasterlistEntry('${esc(e.sn)}', ${scopeArg})">Remove</button></div></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No matching entries.</span></div>`;
}
function filterMasterlistList(query, scope) {
  renderMasterlistResults(query, scope);
}
function openMasterlistEditor(sn, scope = null) {
  const e = sn ? (window.__qrsMasterlist || []).find((x) => x.sn === sn) : null;
  const scopeArg = scopeArgOf(scope);
  openAppModal({ title: e ? "Edit Masterlist Entry" : "Add Masterlist Entry", subtitle: e ? "Update this student's masterlist record." : scope ? `Add a student to ${scope.schoolYear} · ${scope.course} · ${scope.year}.` : "Add a single student to the masterlist.", icon: "fa-user-pen", content: `<div class="app-modal-grid">${modalField("Student number", "mlSn", e?.sn || "", "full")}${modalField("Full name", "mlName", e?.name || "")}${modalField("Email", "mlEmail", e?.email || "")}${modalField("Course", "mlCourse", e?.course || scope?.course || "")}${modalField("Year level", "mlYear", e?.year || scope?.year || "")}${schoolYearField("mlSchoolYear", e?.schoolYear || scope?.schoolYear || "")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="${scope ? `manageMasterlist('', ${scopeArg})` : "manageMasterlist()"}">Back</button><button class="btn-maroon" onclick="saveMasterlistEntry('${e?.sn || ""}', ${scopeArg})">${e ? "Save changes" : "Add entry"}</button></div>` });
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
  if (result.ok) { await refreshMasterlistStatus(); showToast(originalSn ? "Masterlist entry updated." : "Masterlist entry added."); return manageMasterlist("", scope); }
  showToast(result.error || "Could not save masterlist entry.", "rgba(155,22,22,.85)");
}
function removeMasterlistEntry(sn, scope = null) {
  const scopeArg = scopeArgOf(scope);
  openAppModal({ title: "Remove Masterlist Entry", subtitle: `Remove ${sn} from the masterlist? This does not delete any registered account.`, icon: "fa-user-xmark", content: `<div class="app-modal-actions"><button class="btn-soft" onclick="manageMasterlist('', ${scopeArg})">Cancel</button><button class="btn-maroon" onclick="confirmRemoveMasterlistEntry('${esc(sn)}', ${scopeArg})">Remove</button></div>` });
}
async function confirmRemoveMasterlistEntry(sn, scope = null) {
  const result = await api(`/api/masterlist/${encodeURIComponent(sn)}`, { method: "DELETE" });
  if (result.ok) { await refreshMasterlistStatus(); showToast("Masterlist entry removed."); return manageMasterlist("", scope); }
  showToast(result.error || "Could not remove masterlist entry.", "rgba(155,22,22,.85)");
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

async function manageMasterlistGroups() {
  const result = await api("/api/masterlist/groups");
  if (!result.ok) return showToast("Could not load masterlist groups.", "rgba(155,22,22,.85)");
  window.__qrsGroups = result.data;
  const superAdmin = isSuperAdmin();
  openAppModal({ title: "Masterlist Groups", subtitle: "Organized by school year, course, and year level, each with an optional owner.", icon: "fa-layer-group", wide: true, content: `<div class="app-list" style="max-height:400px;overflow-y:auto;">${result.data.length ? result.data.map((g) => `<div class="app-row"><div><div class="app-row-title">${esc(g.schoolYear)} · ${esc(g.course)} · ${esc(g.year)}</div><div class="app-row-meta">${g.count} student${g.count === 1 ? "" : "s"} · Owner: ${g.owner ? esc(g.owner.name) : "Unassigned"}</div></div><div style="display:flex;gap:6px;"><button class="btn-soft" onclick="manageMasterlist('', {schoolYear:'${esc(g.schoolYear)}',course:'${esc(g.course)}',year:'${esc(g.year)}'})">View students</button>${superAdmin ? `<button class="btn-soft" onclick="openGroupOwnerEditor('${esc(g.id || "")}','${esc(g.schoolYear)}','${esc(g.course)}','${esc(g.year)}','${esc(g.owner?.id || "")}')">Assign owner</button>` : ""}</div></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No groups yet.</span></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button><button class="btn-maroon" onclick="addMasterlistGroupPrompt()"><i class="fa-solid fa-plus"></i> Add group</button></div>` });
}
function addMasterlistGroupPrompt() {
  openAppModal({ title: "Add Masterlist Group", subtitle: "Register a school year, course, and year level — useful for assigning an owner before any students are imported.", icon: "fa-layer-group", content: `<div class="app-modal-grid">${schoolYearField("grpSchoolYear", "", "full")}${modalField("Course", "grpCourse", "")}${modalField("Year level", "grpYear", "")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="manageMasterlistGroups()">Back</button><button class="btn-maroon" onclick="saveMasterlistGroup()">Add group</button></div>` });
}
async function saveMasterlistGroup() {
  const schoolYear = document.getElementById("grpSchoolYear")?.value.trim();
  const course = document.getElementById("grpCourse")?.value.trim();
  const year = document.getElementById("grpYear")?.value.trim();
  if (!validSchoolYear(schoolYear)) return showToast("School year must be in YYYY-YYYY format, e.g. 2026-2027.", "rgba(155,22,22,.85)");
  const result = await api("/api/masterlist/groups", { method: "POST", body: { schoolYear, course, year } });
  if (result.ok) { showToast("Masterlist group added."); return manageMasterlistGroups(); }
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
  openAppModal({ title: "Assign Group Owner", subtitle: `${schoolYear} · ${course} · ${year}`, icon: "fa-user-shield", content: `<div class="app-modal-grid"><div class="app-field full"><label for="grpOwner">Owner</label><select id="grpOwner" class="glass-input"><option value="">Unassigned</option>${eligible.map((u) => `<option value="${esc(u.id)}" ${u.id === currentOwnerId ? "selected" : ""}>${esc(u.name)} (${u.role === "SUPER_ADMIN" ? "Super Admin" : "Admin"})</option>`).join("")}</select></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="manageMasterlistGroups()">Back</button><button class="btn-maroon" onclick="saveGroupOwner('${esc(groupId)}')">Save</button></div>` });
}
async function saveGroupOwner(groupId) {
  const ownerId = document.getElementById("grpOwner")?.value || null;
  const result = await api(`/api/masterlist/groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: { ownerId } });
  if (result.ok) { showToast("Group owner updated."); return manageMasterlistGroups(); }
  showToast(result.error || "Could not update the group owner.", "rgba(155,22,22,.85)");
}

async function manageStudentAccounts(query = "") {
  const result = await api("/api/users/students");
  if (!result.ok) return showToast("Could not load student accounts.", "rgba(155,22,22,.85)");
  window.__qrsStudents = result.data;
  openAppModal({ title: "Student Accounts", subtitle: `${result.data.length} registered student${result.data.length === 1 ? "" : "s"}. Place accounts on hold or reactivate them.`, icon: "fa-user-lock", wide: true, content: `<input class="glass-input" placeholder="Search student no., name, or email…" value="${esc(query)}" oninput="filterStudentAccountsList(this.value)" style="margin-bottom:12px;"><div id="saResultsList" class="app-list" style="max-height:400px;overflow-y:auto;"></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button></div>` });
  renderStudentAccountsResults(query);
}
function renderStudentAccountsResults(query) {
  const container = document.getElementById("saResultsList");
  if (!container) return;
  const q = (query || "").toLowerCase();
  const list = (window.__qrsStudents || []).filter((u) => !q || (u.studentId || "").toLowerCase().includes(q) || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  container.innerHTML = list.length ? list.map((u) => `<div class="app-row"><div><div class="app-row-title">${esc(u.name)} <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:99px;${u.active ? "background:rgba(22,163,74,.12);color:#15803d;" : "background:rgba(220,38,38,.10);color:#b91c1c;"}">${u.active ? "Active" : "On Hold"}</span></div><div class="app-row-meta">${esc(u.studentId || "")} · ${esc(u.email)}${u.course ? ` · ${esc(u.course)} ${esc(u.year || "")}` : ""}</div></div><button class="btn-soft" style="${u.active ? "color:#b91c1c;" : "color:#15803d;"}" onclick="toggleStudentHold('${esc(u.studentId)}', ${!u.active})">${u.active ? "Put on hold" : "Reactivate"}</button></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No matching student accounts.</span></div>`;
}
function filterStudentAccountsList(query) {
  renderStudentAccountsResults(query);
}
async function toggleStudentHold(sn, active) {
  const result = await api(`/api/users/students/${encodeURIComponent(sn)}`, { method: "PATCH", body: { active } });
  if (result.ok) { showToast(active ? "Account reactivated." : "Account put on hold."); return manageStudentAccounts(); }
  showToast(result.error || "Could not update the account.", "rgba(155,22,22,.85)");
}

async function giveFeedback(requestId) {
  openAppModal({ title: "Service Feedback", subtitle: "Your feedback helps Student Services improve completed services.", icon: "fa-star", content: `<div class="app-modal-grid"><div class="app-field"><label for="feedbackRating">Rating</label><select id="feedbackRating" class="glass-input"><option value="5">5 — Excellent</option><option value="4">4 — Very good</option><option value="3">3 — Good</option><option value="2">2 — Needs improvement</option><option value="1">1 — Poor</option></select></div><div class="app-field full"><label for="feedbackComment">Optional comment</label><textarea id="feedbackComment" class="glass-input" placeholder="Tell us about your experience..."></textarea></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-gold" onclick="submitFeedback('${esc(requestId)}')"><i class="fa-solid fa-star"></i> Submit feedback</button></div>` });
}
async function submitFeedback(requestId) {
  const result = await api("/api/feedback", { method: "POST", body: { requestId, rating: Number(document.getElementById("feedbackRating")?.value), comment: document.getElementById("feedbackComment")?.value.trim() || "" } });
  if (result.ok) closeAppModal();
  showToast(result.ok ? "Thank you for your feedback." : (result.error || "Could not submit feedback."), result.ok ? undefined : "rgba(155,22,22,.85)");
}


async function cancelAppointment(code) {
  openAppModal({ title: "Cancel Appointment", subtitle: `Cancel appointment ${code}? This action follows the cancellation cutoff in System Settings.`, icon: "fa-calendar-xmark", content: `<div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Keep appointment</button><button class="btn-maroon" onclick="confirmCancelAppointment('${esc(code)}')">Cancel appointment</button></div>` });
}
async function confirmCancelAppointment(code) {
  const result = await api(`/api/queue/${encodeURIComponent(code)}/cancel`, { method: "DELETE" });
  if (result.ok) { closeAppModal(); await renderStudentAppointment(); }
  showToast(result.ok ? "Appointment cancelled." : (result.error || "Could not cancel appointment."), result.ok ? undefined : "rgba(155,22,22,.85)");
}
async function rescheduleAppointment(code) {
  rescheduleCode = code; rescheduleSelectedDate = null; rescheduleSelectedSlot = null;
  rescheduleCalMonth = new Date().getMonth(); rescheduleCalYear = new Date().getFullYear();
  rescheduleAvailability = { bookedTimes: [], myAppointment: null };
  openAppModal({ title: "Reschedule Appointment", subtitle: "Choose a new date and available business-hours time slot.", icon: "fa-calendar-days", wide: true, content: `<div class="app-modal-grid"><div class="app-field full"><label>New date</label><div style="background:rgba(139,26,26,.05);border-radius:14px;padding:16px;margin-top:6px;"><div id="rescheduleCalendar"></div></div></div><div class="app-field full"><label>New time</label><div id="rescheduleDateLabel" style="font-size:11px;color:rgba(30,5,5,.62);margin:6px 0 10px;">Select a date first.</div><div id="rescheduleTimeSlots" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"></div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="confirmRescheduleAppointment()">Save new schedule</button></div>` });
  buildRescheduleCalendar();
}
async function confirmRescheduleAppointment() {
  if (!rescheduleSelectedDate || !rescheduleSelectedSlot) return showToast("Select both a new date and time.", "rgba(180,130,0,.85)");
  const dateLabel = rescheduleDateLabel(rescheduleSelectedDate);
  const result = await api(`/api/queue/${encodeURIComponent(rescheduleCode)}/reschedule`, { method: "POST", body: { dateLabel, time: rescheduleSelectedSlot } });
  if (result.ok) { closeAppModal(); await renderStudentAppointment(); }
  showToast(result.ok ? "Appointment rescheduled." : (result.error || "Could not reschedule appointment."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

function restoreBackup() {
  openAppModal({ title: "Restore Configuration", subtitle: "Restore a previously downloaded JSON backup. Accounts, requests, and appointments will not be changed.", icon: "fa-clock-rotate-left", content: `<div class="app-row"><div><div class="app-row-title">What will be restored</div><div class="app-row-meta">CSV masterlist, System Settings, and FAQs.</div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="pickBackupFile()"><i class="fa-solid fa-file-arrow-up"></i> Choose backup file</button></div>` });
}
function pickBackupFile() {
  const picker = document.createElement("input"); picker.type = "file"; picker.accept = ".json,application/json";
  picker.onchange = () => { const file = picker.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = async () => { try { const result = await api("/api/backup", { method: "POST", body: JSON.parse(String(reader.result)) }); if (result.ok) closeAppModal(); showToast(result.ok ? `Restored ${result.data.masterlist} masterlist records, ${result.data.settings} settings, and ${result.data.faqs} FAQs.` : (result.error || "Could not restore backup."), result.ok ? undefined : "rgba(155,22,22,.85)"); } catch { showToast("The selected file is not a valid JSON backup.", "rgba(155,22,22,.85)"); } }; reader.readAsText(file); };
  picker.click();
}

async function sendReminders() {
  openAppModal({ title: "Send Email Reminders", subtitle: "This will email students with appointments within 24 hours and documents ready to claim.", icon: "fa-bell", content: `<div class="app-row"><div><div class="app-row-title">Email delivery</div><div class="app-row-meta">Messages are sent through the configured SMTP account. Already-sent reminders are skipped.</div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="confirmSendReminders()"><i class="fa-solid fa-paper-plane"></i> Send reminders</button></div>` });
}
async function confirmSendReminders() {
  const result = await api("/api/reminders", { method: "POST" });
  if (result.ok) closeAppModal();
  showToast(result.ok ? `Sent ${result.data.appointmentEmails} appointment and ${result.data.readyEmails} document reminders.` : (result.error || "Could not send reminders."), result.ok ? undefined : "rgba(155,22,22,.85)");
}


async function reviewProfileChanges() {
  const result = await api("/api/profile");
  if (!result.ok) return showToast("Could not load profile updates.", "rgba(155,22,22,.85)");
  const list = result.data || [];
  openAppModal({ title: "Profile Verification", subtitle: "Approve or reject student updates before their profile is changed.", icon: "fa-user-check", wide: true, content: `<div class="app-list">${list.length ? list.map((p) => `<div class="app-row"><div><div class="app-row-title">${esc(p.name)} <span class="app-row-meta">(${esc(p.studentId)})</span></div><div class="app-row-meta">${esc(p.email)} · ${esc(p.course || "No course")} · ${esc(p.year || "No year level")}</div></div><div style="display:flex;gap:7px"><button class="btn-soft" onclick="resolveProfileChange('${esc(p.id)}','Rejected')">Reject</button><button class="btn-maroon" onclick="resolveProfileChange('${esc(p.id)}','Approved')">Approve</button></div></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No profile updates awaiting review.</span></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button></div>` });
}
async function resolveProfileChange(id, status) {
  const result = await api(`/api/profile/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
  if (!result.ok) return showToast(result.error || "Could not update profile.", "rgba(155,22,22,.85)");
  showToast(`Profile update ${status.toLowerCase()}.`); reviewProfileChanges();
}
async function adminAction(reqId, newStatus, reason) {
  const { ok, data, error } = await api(`/api/requests/${encodeURIComponent(reqId)}`, {
    method: "PATCH",
    body: { status: newStatus, reason },
  });
  if (!ok) {
    await Promise.all([loadRequests(), loadAuditLog(), loadEmailLog(), loadAdminActivity()]);
    renderAdminPage();
    showToast(error || "Could not update request.", "rgba(155,22,22,.85)");
    return false;
  }

  const rowIndex = DB.findIndex((request) => request.id === reqId);
  if (rowIndex >= 0 && data) DB[rowIndex] = data;

  if (donutChart) { try { donutChart.destroy(); } catch {} donutChart = null; }
  if (barChartInst) { try { barChartInst.destroy(); } catch {} barChartInst = null; }
  renderAdminPage();
  showToast(`${reqId} marked as ${newStatus}.`);

  await Promise.all([loadRequests(), loadAuditLog(), loadEmailLog(), loadAdminActivity()]);
  renderAdminPage();
  return true;
}


function downloadRequestPdf(reqId, type) {
  window.location.assign(`/api/requests/${encodeURIComponent(reqId)}/pdf?type=${encodeURIComponent(type)}`);
}
function printReceipt(reqId) { downloadRequestPdf(reqId, "receipt"); }
function printApproval(reqId) { downloadRequestPdf(reqId, "approval"); }

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
    await Promise.all([loadRequests(), loadQueueData(), loadAdminActivity(), loadPendingAccounts(), loadAuditLog(), loadEmailLog()]);
    renderAdminPage();
  } else if (page === "page-student") {
    await Promise.all([loadRequests(), loadModule("events2"), loadMyOrganizations()]); renderStudentPage();
  } else if (page === "page-scanner") {
    await loadRequests();
  }
}

function scannerResult(html, valid) {
  const box = document.getElementById("verifyRefResult");
  if (box) box.innerHTML = `<div class="glass-card" style="padding:16px;border:1px solid ${valid ? "rgba(34,197,94,.4)" : "rgba(220,38,38,.4)"};">${html}</div>`;
}
async function completeScannedQr(decodedText) {
  if (qrClaimBusy) return;
  qrClaimBusy = true;
  scannerResult(`<b><i class="fa-solid fa-spinner fa-spin" style="margin-right:7px;"></i>Verifying secure QR code…</b>`, true);
  const result = await api("/api/requests/verify", { method: "POST", body: { token: decodedText } });
  qrClaimBusy = false;
  if (!result.ok || !result.data?.completed) {
    scannerResult(`<div style="font-weight:900;color:#991b1b;"><i class="fa-solid fa-circle-xmark" style="margin-right:7px;"></i>QR CODE NOT ACCEPTED</div><div style="font-size:12px;margin-top:6px;">${esc(result.error || "The QR code is invalid, expired, or already used.")}</div>`, false);
    showToast(result.error || "QR verification failed.", "rgba(155,22,22,.85)");
    return;
  }
  const r = result.data.request;
  scannerResult(`<div style="font-weight:900;color:#166534;"><i class="fa-solid fa-circle-check" style="margin-right:7px;"></i>DOCUMENT RELEASED</div><div style="font-size:12px;margin-top:8px;line-height:1.6;"><b>${esc(r.doc)}</b><br>${esc(r.studentName)} · ${esc(r.id)}<br>Claim reference: <b>${esc(r.claimRef)}</b></div><button class="btn-maroon" style="margin-top:12px;padding:9px 14px;" onclick="printReceipt('${esc(r.id)}')"><i class="fa-solid fa-file-pdf"></i> Download Receipt PDF</button>`, true);
  await refreshLiveData();
  showToast("Document verified and marked Completed.");
}
async function startScanner() {
  if (qrScannerRunning) return;
  if (!window.Html5Qrcode) return showToast("QR camera library is unavailable. Check your internet connection and reload.", "rgba(155,22,22,.85)");
  const reader = document.getElementById("reader");
  if (!reader) return showToast("Scanner view is unavailable.", "rgba(155,22,22,.85)");
  try {
    qrScanner = qrScanner || new Html5Qrcode("reader");
    const config = { fps: 10, qrbox: { width: 220, height: 220 } };
    const onScan = async (decodedText) => {
      if (!qrScannerRunning) return;
      await stopScanner();
      await completeScannedQr(decodedText);
    };
    try {
      await qrScanner.start({ facingMode: "environment" }, config, onScan, () => {});
    } catch (preferredCameraError) {
      const cameras = await Html5Qrcode.getCameras();
      if (!cameras.length) throw preferredCameraError;
      await qrScanner.start(cameras[0].id, config, onScan, () => {});
    }
    qrScannerRunning = true;
    document.getElementById("scanBtn")?.style && (document.getElementById("scanBtn").style.display = "none");
    document.getElementById("stopBtn")?.style && (document.getElementById("stopBtn").style.display = "inline-block");
  } catch (error) {
    qrScannerRunning = false;
    showToast("Camera could not start. Allow camera permission and use HTTPS in production.", "rgba(155,22,22,.85)");
  }
}
async function stopScanner() {
  if (qrScanner && qrScannerRunning) { try { await qrScanner.stop(); } catch (_) {} }
  qrScannerRunning = false;
  const start = document.getElementById("scanBtn"), stop = document.getElementById("stopBtn");
  if (start) start.style.display = "inline-block";
  if (stop) stop.style.display = "none";
}

function restoreBackup() {
  openAppModal({ title: "Full Database Restore", subtitle: "This replaces all QR-SASMS records using a version 2 backup. This cannot be undone.", icon: "fa-triangle-exclamation", content: `<div class="app-row"><div><div class="app-row-title" style="color:#991b1b;">Danger: all current records will be replaced</div><div class="app-row-meta">Users, requests, appointments, complaints, settings, modules, notifications, and logs will be restored from the selected backup.</div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="pickBackupFile()"><i class="fa-solid fa-file-arrow-up"></i> Choose full backup</button></div>` });
}
function pickBackupFile() {
  const picker = document.createElement("input"); picker.type = "file"; picker.accept = ".json,application/json";
  picker.onchange = () => { const file = picker.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = async () => {
    try {
      const backup = JSON.parse(String(reader.result));
      if (backup.version !== 2) return showToast("Use a full version 2 QR-SASMS backup file.", "rgba(155,22,22,.85)");
      const confirmation = prompt("This permanently replaces ALL current data. Type RESTORE ALL DATA to continue:", "");
      if (confirmation !== "RESTORE ALL DATA") return showToast("Restore cancelled — confirmation did not match.", "rgba(180,130,0,.85)");
      const result = await api("/api/backup", { method: "POST", body: { backup, confirmation } });
      if (result.ok) { closeAppModal(); showToast(`Full backup restored: ${result.data.restored.users} users and ${result.data.restored.requests} requests.`); setTimeout(() => window.location.reload(), 900); }
      else showToast(result.error || "Could not restore backup.", "rgba(155,22,22,.85)");
    } catch { showToast("The selected file is not a valid QR-SASMS full backup.", "rgba(155,22,22,.85)"); }
  }; reader.readAsText(file); };
  picker.click();
}
