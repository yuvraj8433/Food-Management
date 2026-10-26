import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, updatePassword }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, SCRIPT_URL, EMAIL_DOMAIN } from "./config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);
const $app = document.getElementById("app");

let me = null;          // current user's profile doc
let unsub = null;       // active realtime listener
let tick = null;        // timer that refreshes open/closed state as cut-off times pass
const DEFAULT_MEALS = [{ id: "lunch", name: "Lunch", cutoff: "10:30" }];

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
// Date and time are always India time (same as the Firestore rules and the Apps Script), whatever the device timezone is
const istParts = d => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map(p => [p.type, p.value]));
const today = () => { const p = istParts(new Date()); return `${p.year}-${p.month}-${p.day}`; };
const hhmm = d => { const p = istParts(d); return `${p.hour}:${p.minute}`; };
const toEmail = id => id.includes("@") ? id.trim().toLowerCase() : `${id.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
const $ = (sel, root = document) => root.querySelector(sel);
const orderId = (date, uid, meal) => `${date}_${uid}_${meal}`;

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 3000);
}
function stopListening() { if (unsub) { unsub(); unsub = null; } clearInterval(tick); }

async function getConfig() {
  const s = await getDoc(doc(db, "settings", "config"));
  return s.exists() && s.data().meals?.length ? s.data() : { meals: DEFAULT_MEALS };
}
const pastCutoff = meal => hhmm(new Date()) > (meal.cutoff || "23:59");
// The Firestore rules cannot loop over the meals array, so they read these lookup maps instead
const ruleMaps = meals => ({
  cutoffs: Object.fromEntries(meals.map(m => [m.id, m.cutoff || "23:59"])),
  names: Object.fromEntries(meals.map(m => [m.id, m.name]))
});
async function syncRuleConfig(cfg) {
  if (cfg.cutoffs && cfg.names) return;
  await setDoc(doc(db, "settings", "config"), { meals: cfg.meals, ...ruleMaps(cfg.meals) });
  cfg.cutoffs = true; cfg.names = true;
}

// ---------- Apps Script bridge (Drive storage) ----------
async function api(action, payload) {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(SCRIPT_URL, { method: "POST", body: JSON.stringify({ action, idToken, ...payload }) });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || "Server error");
  return out;
}
const photoCache = new Map();
async function photoSrc(fileId) {
  if (!photoCache.has(fileId)) photoCache.set(fileId, api("image", { fileId }).then(r => "data:image/jpeg;base64," + r.data));
  return photoCache.get(fileId);
}
async function uploadPhoto(kind, dataUrl, date) {
  const r = await api("upload", { kind, date, data: dataUrl.split(",")[1] });
  return r.fileId;
}

// ---------- camera capture + compression ----------
function capturePhoto(label) {
  return new Promise(resolve => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="box"><h3 style="margin-top:0">${esc(label)}</h3>
      <video autoplay playsinline muted></video><img class="shot" hidden>
      <p class="small muted" id="camMsg">Look at the camera and take the photo.</p>
      <div class="row"><button id="cancel">Cancel</button><button id="snap" class="primary">Take photo</button><button id="retake" hidden>Retake</button><button id="use" class="primary" hidden>Use this photo</button></div></div>`;
    document.body.append(m);
    const video = $("video", m), img = $("img.shot", m);
    let stream, result = null;
    const done = v => { stream?.getTracks().forEach(t => t.stop()); m.remove(); resolve(v); };
    const show = (cam) => { video.hidden = !cam; img.hidden = cam; $("#snap", m).hidden = !cam; $("#retake", m).hidden = cam; $("#use", m).hidden = cam; };
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 960 } }, audio: false })
      .then(s => { stream = s; video.srcObject = s; })
      .catch(() => { $("#camMsg", m).textContent = "Camera not available. Allow camera permission and try again."; $("#snap", m).disabled = true; });
    $("#cancel", m).onclick = () => done(null);
    $("#snap", m).onclick = () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w) return;
      const scale = Math.min(1, 640 / w);
      const c = document.createElement("canvas");
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const x = c.getContext("2d");
      x.drawImage(video, 0, 0, c.width, c.height);
      const stamp = new Date().toLocaleString("en-IN");
      x.font = "14px sans-serif"; x.fillStyle = "rgba(0,0,0,.55)"; x.fillRect(0, c.height - 24, c.width, 24);
      x.fillStyle = "#fff"; x.fillText(stamp, 8, c.height - 8);
      result = c.toDataURL("image/jpeg", 0.6);   // compressed ~30-60 KB
      img.src = result; show(false);
    };
    $("#retake", m).onclick = () => { result = null; show(true); };
    $("#use", m).onclick = () => done(result);
  });
}

function showPhoto(fileId, title) {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="box"><h3 style="margin-top:0">${esc(title)}</h3><p class="muted" id="ph">Loading…</p><img class="shot" hidden><div class="row"><button id="x">Close</button></div></div>`;
  document.body.append(m);
  $("#x", m).onclick = () => m.remove();
  photoSrc(fileId).then(src => { $("img", m).src = src; $("img", m).hidden = false; $("#ph", m).hidden = true; })
    .catch(e => { $("#ph", m).textContent = "Could not load photo: " + e.message; });
}

// ---------- auth + routing ----------
onAuthStateChanged(auth, async user => {
  stopListening();
  if (!user) { me = null; return loginView(); }
  let s;
  try { s = await getDoc(doc(db, "users", user.uid)); }
  catch (e) { await signOut(auth); return loginView("Could not load your profile (" + (e.code || e.message) + "). Try again."); }
  if (!s.exists() || s.data().active === false) {
    await signOut(auth);
    return loginView("This account is not active. Contact admin.");
  }
  me = { uid: user.uid, ...s.data() };
  if (me.mustChangePw) return forcePasswordView();
  me.role === "admin" ? adminView() : employeeView();
});

// First login with an admin-issued password: choose your own before using the app
function forcePasswordView() {
  $app.innerHTML = `<div class="card login"><h2 class="center" style="margin-top:0">Set a new password</h2>
    <p class="small muted">Your password was issued by the admin. Choose your own to continue.</p>
    <form id="f"><label>New password (min 8 characters)</label><input id="np" type="password" minlength="8" required autocomplete="new-password">
    <label>Repeat password</label><input id="np2" type="password" minlength="8" required autocomplete="new-password">
    <p class="small" style="color:var(--bad)" id="err"></p>
    <button class="primary" style="width:100%">Save password</button> <button type="button" id="out" style="width:100%;margin-top:8px">Sign out</button></form></div>`;
  $("#out").onclick = () => signOut(auth);
  $("#f").onsubmit = async e => {
    e.preventDefault();
    if ($("#np").value !== $("#np2").value) return $("#err").textContent = "Passwords do not match.";
    try {
      await updatePassword(auth.currentUser, $("#np").value);
      await updateDoc(doc(db, "users", me.uid), { mustChangePw: false }); me.mustChangePw = false;
      me.role === "admin" ? adminView() : employeeView();
    } catch (err) { $("#err").textContent = err.code === "auth/requires-recent-login" ? "Sign out and sign in again, then retry." : err.message; }
  };
}

function loginView(msg = "") {
  $app.innerHTML = `<div class="card login"><div class="logo">🍽</div><h2>Air Flow Pvt. Ltd.<small>Food Desk</small></h2>
    <form id="f"><label>Employee ID</label><input id="id" required autocomplete="username">
    <label>Password</label><input id="pw" type="password" required autocomplete="current-password">
    <p class="small" style="color:var(--bad)" id="err">${esc(msg)}</p>
    <button class="primary" style="width:100%">Sign in</button></form></div>`;
  $("#f").onsubmit = async e => {
    e.preventDefault();
    try { await signInWithEmailAndPassword(auth, toEmail($("#id").value), $("#pw").value); }
    catch (err) {
      const c = err.code || "";
      $("#err").textContent = c === "auth/invalid-credential" || c === "auth/user-not-found" || c === "auth/wrong-password"
        ? "Wrong Employee ID or password, or this login was not created in Firebase Authentication."
        : `Login problem (${c || err.message}). Check Firebase setup.`;
    }
  };
}

function shell(title, tabs, active) {
  $app.innerHTML = `<header class="top"><div class="who"><h1>${esc(title)}</h1><div class="small">${esc(me.name)} (${esc(me.empId)})</div></div><button id="out">Sign out</button></header>
    <div class="tabs">${tabs.map(([k, n]) => `<button data-t="${k}" class="${k === active ? "active" : ""}">${n}</button>`).join("")}</div><div id="body"></div>`;
  $("#out").onclick = () => signOut(auth);
  return $("#body");
}

// ---------- EMPLOYEE ----------
function employeeView(tab = "order") {
  stopListening();
  const body = shell("Food Desk", [["order", "Today's food"], ["profile", "My profile"]], tab);
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => employeeView(b.dataset.t));
  tab === "order" ? employeeOrder(body) : employeeProfile(body);
}

async function employeeOrder(body) {
  const cfg = await getConfig(), date = today();
  const q = query(collection(db, "orders"), where("uid", "==", me.uid), where("date", "==", date));
  stopListening();   // the awaits above may have let a stale listener be registered
  let last = null;
  const render = snap => {
    const mine = Object.fromEntries(snap.docs.map(d => [d.data().meal, { id: d.id, ...d.data() }]));
    body.innerHTML = `<p class="muted">${date}. Order before the cut-off time. A live photo is required.</p>` +
      cfg.meals.map(m => {
        const o = mine[m.id], late = pastCutoff(m);
        return `<div class="card meal"><div class="row" style="align-items:center"><div><b style="font-size:18px">${esc(m.name)}</b><div class="small muted">Order until ${esc(m.cutoff)}</div></div>
          <div style="text-align:right">${o
            ? `<span class="badge ok">Ordered</span> <button data-cancel="${esc(o.id)}" ${late ? "disabled" : ""}>Cancel</button>`
            : late ? `<span class="badge bad">Closed</span>` : `<button class="primary" data-order="${esc(m.id)}">I need food</button>`}</div></div>
          ${o?.photoFileId ? `<button class="small" data-view="${esc(o.photoFileId)}">View my photo</button>` : ""}</div>`;
      }).join("");
    body.querySelectorAll("[data-order]").forEach(b => b.onclick = () => placeOrder(cfg.meals.find(m => m.id === b.dataset.order)));
    body.querySelectorAll("[data-cancel]").forEach(b => b.onclick = async () => {
      if (confirm("Cancel this order?")) { await deleteDoc(doc(db, "orders", b.dataset.cancel)); toast("Order cancelled"); }
    });
    body.querySelectorAll("[data-view]").forEach(b => b.onclick = () => showPhoto(b.dataset.view, "Order photo"));
  };
  unsub = onSnapshot(q, snap => { last = snap; render(snap); }, err => toast(err.message));
  tick = setInterval(() => last && render(last), 30000);   // "Closed" and the disabled Cancel button appear on time
}

async function placeOrder(meal) {
  if (pastCutoff(meal)) return toast("Ordering is closed for " + meal.name);
  const shot = await capturePhoto(`Verify yourself – ${meal.name}`);
  if (!shot) return;
  toast("Uploading photo…");
  try {
    const date = today();
    const photoFileId = await uploadPhoto("order", shot, date);
    await setDoc(doc(db, "orders", orderId(date, me.uid, meal.id)), {
      date, uid: me.uid, empId: me.empId, name: me.name, dept: me.dept || "",
      meal: meal.id, mealName: meal.name, photoFileId, source: "employee",
      createdAt: new Date().toISOString(), synced: false
    });
    toast("Food ordered ✔");
  } catch (e) { toast("Failed: " + e.message); }
}

async function employeeProfile(body) {
  const hist = await getDocs(query(collection(db, "orders"), where("uid", "==", me.uid)));
  const rows = hist.docs.map(d => d.data()).sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  const month = today().slice(0, 7);
  body.innerHTML = `<div class="card"><div class="row" style="align-items:center">
      <div style="flex:0 0 auto;min-width:0"><img class="avatar" id="av" alt=""></div>
      <div><h3 style="margin:0">${esc(me.name)}</h3><div class="muted">ID: ${esc(me.empId)} · ${esc(me.dept || "—")}</div>
      <div class="muted">${esc(me.phone || "")}</div><div class="small">Meals this month: <b>${rows.filter(r => String(r.date).startsWith(month)).length}</b></div></div></div>
      <div class="row" style="margin-top:10px"><button id="chPhoto">Update profile photo</button><button id="chPw">Change password</button></div></div>
    <div class="card"><h3 style="margin-top:0">My order history</h3><div class="tablewrap"><table><tr><th>Date</th><th>Meal</th><th>Photo</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.mealName || r.meal)}</td><td>${r.photoFileId ? `<button data-view="${esc(r.photoFileId)}">View</button>` : "—"}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No orders yet</td></tr>`}</table></div></div>`;
  if (me.photoFileId) photoSrc(me.photoFileId).then(s => $("#av").src = s).catch(() => {});
  body.querySelectorAll("[data-view]").forEach(b => b.onclick = () => showPhoto(b.dataset.view, "Order photo"));
  $("#chPhoto").onclick = async () => {
    const shot = await capturePhoto("Profile photo"); if (!shot) return;
    try {
      const id = await uploadPhoto("profile", shot);
      await updateDoc(doc(db, "users", me.uid), { photoFileId: id }); me.photoFileId = id;
      employeeView("profile"); toast("Profile photo updated");
    } catch (e) { toast("Failed: " + e.message); }
  };
  $("#chPw").onclick = async () => {
    const pw = prompt("New password (min 6 characters):"); if (!pw) return;
    try { await updatePassword(auth.currentUser, pw); toast("Password changed"); }
    catch (e) { toast(e.code === "auth/requires-recent-login" ? "Sign out and in again, then retry" : e.message); }
  };
}

// ---------- ADMIN ----------
function adminView(tab = "today") {
  stopListening();
  const body = shell("Food Desk – Admin", [["today", "Today"], ["employees", "Employees"], ["reports", "Reports"], ["settings", "Settings"]], tab);
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => adminView(b.dataset.t));
  ({ today: adminToday, employees: adminEmployees, reports: adminReports, settings: adminSettings })[tab](body);
}

async function loadEmployees() {
  const s = await getDocs(collection(db, "users"));
  return s.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.role !== "admin").sort((a, b) => a.name.localeCompare(b.name));
}

async function adminToday(body) {
  const cfg = await getConfig(), date = today(), emps = await loadEmployees();
  await syncRuleConfig(cfg).catch(e => toast("Could not update meal settings: " + e.message));
  stopListening();
  unsub = onSnapshot(query(collection(db, "orders"), where("date", "==", date)), snap => {
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
    const count = id => orders.filter(o => o.meal === id).length;
    const ordered = new Set(orders.map(o => o.uid));
    body.innerHTML = `<div class="grid">${cfg.meals.map(m => `<div class="card stat"><b>${count(m.id)}</b>${esc(m.name)}</div>`).join("")}
      <div class="card stat"><b>${emps.filter(e => e.active !== false && !ordered.has(e.uid)).length}</b>Not ordered</div></div>
      <div class="card"><h3 style="margin-top:0">Add an order manually</h3><div class="row">
        <div><label>Employee</label><select id="aoEmp">${emps.filter(e => e.active !== false).map(e => `<option value="${esc(e.uid)}">${esc(e.name)} (${esc(e.empId)})</option>`).join("")}</select></div>
        <div><label>Meal</label><select id="aoMeal">${cfg.meals.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select></div>
        <button class="primary" id="aoAdd">Add</button></div></div>
      <div class="card"><h3 style="margin-top:0">Orders – ${date}</h3><div class="tablewrap"><table><tr><th>Emp ID</th><th>Name</th><th>Dept</th><th>Meal</th><th>Time</th><th>Photo</th><th></th></tr>
      ${orders.map(o => `<tr><td>${esc(o.empId)}</td><td>${esc(o.name)}</td><td>${esc(o.dept)}</td><td>${esc(o.mealName || o.meal)}</td>
        <td>${new Date(o.createdAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}${o.source === "admin" ? ' <span class="badge">admin</span>' : ""}</td>
        <td>${o.photoFileId ? `<button data-view="${esc(o.photoFileId)}">View</button>` : "—"}</td><td><button class="danger" data-del="${esc(o.id)}">Remove</button></td></tr>`).join("") || `<tr><td colspan="7" class="muted">No orders yet</td></tr>`}</table></div></div>`;
    body.querySelectorAll("[data-view]").forEach(b => b.onclick = () => showPhoto(b.dataset.view, "Order photo"));
    body.querySelectorAll("[data-del]").forEach(b => b.onclick = () => deleteDoc(doc(db, "orders", b.dataset.del)).then(() => toast("Removed")));
    const add = $("#aoAdd"); if (add) add.onclick = async () => {
      const e = emps.find(x => x.uid === $("#aoEmp").value), m = cfg.meals.find(x => x.id === $("#aoMeal").value);
      if (!e || !m) return;
      const id = orderId(date, e.uid, m.id);
      if ((await getDoc(doc(db, "orders", id))).exists() && !confirm(`${e.name} already has this order. Replace it? Their photo link will be lost.`)) return;
      await setDoc(doc(db, "orders", id), {
        date, uid: e.uid, empId: e.empId, name: e.name, dept: e.dept || "", meal: m.id, mealName: m.name,
        photoFileId: "", source: "admin", createdAt: new Date().toISOString(), synced: false
      });
      toast("Order added");
    };
  }, err => toast(err.message));
}

function genPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no look-alike characters
  return Array.from(crypto.getRandomValues(new Uint32Array(10)), n => chars[n % chars.length]).join("");
}

async function adminEmployees(body) {
  const emps = await loadEmployees();
  body.innerHTML = `<div class="card"><h3 style="margin-top:0">Add employee</h3><form id="f"><div class="row">
      <div><label>Employee ID</label><input id="eId" required></div><div><label>Name</label><input id="eName" required></div>
      <div><label>Department</label><input id="eDept"></div><div><label>Phone</label><input id="ePhone"></div>
      <div><label>Initial password (employee must change it at first login)</label><input id="ePw" required minlength="8" value="${esc(genPassword())}"></div><button class="primary">Add</button></div></form></div>
    <div class="card"><h3 style="margin-top:0">Employees (${emps.length})</h3><div class="tablewrap"><table><tr><th>ID</th><th>Name</th><th>Dept</th><th>Phone</th><th>Status</th><th></th></tr>
    ${emps.map(e => `<tr><td>${esc(e.empId)}</td><td>${esc(e.name)}</td><td>${esc(e.dept)}</td><td>${esc(e.phone)}</td>
      <td><span class="badge ${e.active === false ? "bad" : "ok"}">${e.active === false ? "Disabled" : "Active"}</span></td>
      <td><button data-tog="${esc(e.uid)}">${e.active === false ? "Enable" : "Disable"}</button> <button class="danger" data-rm="${esc(e.uid)}">Remove</button></td></tr>`).join("")}</table></div></div>`;
  $("#f").onsubmit = async ev => {
    ev.preventDefault();
    const empId = $("#eId").value.trim(), pw = $("#ePw").value;
    if (!/^[A-Za-z0-9._-]{2,30}$/.test(empId)) return toast("Employee ID: letters, numbers . _ - only (2–30 characters)");
    const secondary = initializeApp(firebaseConfig, "secondary-" + Date.now());
    try {
      // secondary app so the admin stays signed in while the new account is created
      const sauth = getAuth(secondary);
      let cred;
      try { cred = await createUserWithEmailAndPassword(sauth, toEmail(empId), pw); }
      catch (err) {
        if (err.code !== "auth/email-already-in-use") throw err;
        // a login left behind by a half-finished earlier attempt: reuse it only if the password matches and it has no profile
        cred = await signInWithEmailAndPassword(sauth, toEmail(empId), pw).catch(() => null);
        if (!cred || (await getDoc(doc(db, "users", cred.user.uid))).exists()) throw err;
      }
      await setDoc(doc(db, "users", cred.user.uid), {
        empId, name: $("#eName").value.trim(), dept: $("#eDept").value.trim(), phone: $("#ePhone").value.trim(),
        role: "employee", active: true, mustChangePw: true, photoFileId: "", createdAt: new Date().toISOString()
      });
      alert(`Employee added.\n\nEmployee ID: ${empId}\nInitial password: ${pw}\n\nShare this with the employee. They must set their own password at first login.`);
      adminView("employees");
    } catch (e) { toast(e.code === "auth/email-already-in-use" ? "That Employee ID already exists" : e.message); }
    finally { await getAuth(secondary).signOut(); deleteApp(secondary); }
  };
  body.querySelectorAll("[data-tog]").forEach(b => b.onclick = async () => {
    const e = emps.find(x => x.uid === b.dataset.tog);
    await updateDoc(doc(db, "users", e.uid), { active: e.active === false }); adminView("employees");
  });
  body.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => {
    const e = emps.find(x => x.uid === b.dataset.rm);
    if (!confirm(`Remove ${e.name}? Their order history stays for records. To free the ID for reuse, also delete the login in Firebase Console.`)) return;
    await deleteDoc(doc(db, "users", e.uid)); adminView("employees");
  });
}

async function adminReports(body) {
  const d = today();
  body.innerHTML = `<div class="card"><div class="row"><div><label>From</label><input type="date" id="from" value="${d.slice(0, 8)}01"></div>
    <div><label>To</label><input type="date" id="to" value="${d}"></div><button class="primary" id="go">Show</button><button id="csv" disabled>Download CSV</button></div></div><div id="out"></div>`;
  let rows = [];
  $("#go").onclick = async () => {
    const s = await getDocs(query(collection(db, "orders"), where("date", ">=", $("#from").value), where("date", "<=", $("#to").value)));
    rows = s.docs.map(x => x.data()).sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")) || String(a.empId ?? "").localeCompare(String(b.empId ?? "")));
    const per = {};
    rows.forEach(r => { (per[r.empId] ??= { name: r.name, n: 0 }).n++; });
    $("#csv").disabled = !rows.length;
    $("#out").innerHTML = `<div class="card"><b>${rows.length}</b> meals in range</div><div class="card"><div class="tablewrap"><table><tr><th>Emp ID</th><th>Name</th><th>Meals</th></tr>
      ${Object.entries(per).map(([id, p]) => `<tr><td>${esc(id)}</td><td>${esc(p.name)}</td><td>${p.n}</td></tr>`).join("")}</table></div></div>`;
  };
  $("#csv").onclick = () => {
    // a leading ' stops Excel/Sheets from running cells that start with = + - @ as formulas
    const q = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const csv = ["Date,EmpID,Name,Dept,Meal,Source"].concat(rows.map(r => [r.date, r.empId, r.name, r.dept, r.mealName || r.meal, r.source].map(q).join(","))).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `food-orders-${$("#from").value}_${$("#to").value}.csv`; a.click();
  };
  $("#go").click();
}

async function adminSettings(body) {
  const cfg = await getConfig(); let meals = cfg.meals.map(m => ({ ...m }));
  const draw = () => {
    body.innerHTML = `<div class="card"><h3 style="margin-top:0">Meals &amp; order cut-off times</h3>
      ${meals.map((m, i) => `<div class="row"><div><label>Name</label><input data-n="${i}" value="${esc(m.name)}"></div>
        <div><label>Cut-off (24h)</label><input type="time" data-c="${i}" value="${esc(m.cutoff)}"></div><button class="danger" data-r="${i}">Remove</button></div>`).join("")}
      <div class="row" style="margin-top:12px"><button id="add">+ Add meal</button><button class="primary" id="save">Save</button></div></div>`;
    body.querySelectorAll("[data-n]").forEach(i => i.oninput = () => meals[i.dataset.n].name = i.value);
    body.querySelectorAll("[data-c]").forEach(i => i.oninput = () => meals[i.dataset.c].cutoff = i.value);
    body.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { meals.splice(b.dataset.r, 1); draw(); });
    $("#add").onclick = () => { meals.push({ id: "m" + Date.now().toString(36), name: "New meal", cutoff: "10:30" }); draw(); };
    $("#save").onclick = async () => {
      if (!meals.length) return toast("Keep at least one meal");
      if (meals.some(m => !m.name.trim() || !/^\d\d:\d\d$/.test(m.cutoff || ""))) return toast("Every meal needs a name and a cut-off time");
      meals.forEach(m => m.name = m.name.trim());
      await setDoc(doc(db, "settings", "config"), { meals, ...ruleMaps(meals) }); toast("Saved");
    };
  };
  draw();
}
