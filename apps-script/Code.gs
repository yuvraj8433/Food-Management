/**
 * Air Flow Food Desk – Google Apps Script backend
 *  - doPost: saves compressed photos to Drive, serves them back to authorised users
 *  - dailySync: copies new Firestore orders into a Google Sheet (long-term backup)
 * Deploy as Web app: Execute as "Me", access "Anyone".
 */
const CFG = {
  API_KEY: 'AIzaSyB4gR7_j1RPJLo4rTVZUQO6SvpoHlsJFjY',
  PROJECT_ID: 'food-management-90588',
  ROOT_FOLDER_ID: '1Dbpo3_BTPQcPBUsPz4782xqk9mJS9rfw',   // folder that will hold all photos
  SHEET_ID: '1djuEaY577widnyPoQ3cpK-n-FVs1hglGdxZvsQ2qZJQ'          // backup spreadsheet
};
const FS = 'https://firestore.googleapis.com/v1/projects/' + CFG.PROJECT_ID + '/databases/(default)/documents';

// ---------- web endpoint ----------
function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents);
    const uid = verifyToken(b.idToken);
    if (b.action === 'upload') return json({ ok: true, fileId: saveImage(uid, b) });
    if (b.action === 'image') return json({ ok: true, data: readImage(uid, b.fileId) });
    throw new Error('Unknown action');
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}
function doGet() { return json({ ok: true, service: 'Air Flow Food Desk' }); }
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// Verifies the Firebase ID token and returns the user's uid
function verifyToken(idToken) {
  if (!idToken) throw new Error('Not signed in');
  const cache = CacheService.getScriptCache(), key = 'tok' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const hit = cache.get(key);
  if (hit) return hit;
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + CFG.API_KEY, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('Invalid session, please sign in again');
  const uid = JSON.parse(r.getContentText()).users[0].localId;
  cache.put(key, uid, 300);
  return uid;
}

function isAdmin(uid) {
  const r = fsFetch('/users/' + uid);
  return r.getResponseCode() === 200 && JSON.parse(r.getContentText()).fields.role.stringValue === 'admin';
}

function subFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function saveImage(uid, b) {
  if (!b.data || b.data.length > 600000) throw new Error('Image missing or too large');
  const root = DriveApp.getFolderById(CFG.ROOT_FOLDER_ID);
  const folder = b.kind === 'order'
    ? subFolder(subFolder(root, 'Orders'), /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : 'unknown')
    : subFolder(root, 'Profiles');
  const name = uid + '_' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd_HHmmss') + '.jpg';
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b.data), 'image/jpeg', name));
  return file.getId();
}

function readImage(uid, fileId) {
  const file = DriveApp.getFileById(fileId);
  const root = CFG.ROOT_FOLDER_ID;
  // only files inside our photo folder tree, owned by the caller (name starts with uid) or any file for admins
  if (file.getName().indexOf(uid + '_') !== 0 && !isAdmin(uid)) throw new Error('Not allowed');
  if (!isInside(file, root)) throw new Error('Not allowed');
  return Utilities.base64Encode(file.getBlob().getBytes());
}
function isInside(file, rootId) {
  let parents = file.getParents();
  for (let depth = 0; depth < 4 && parents.hasNext(); depth++) {
    const p = parents.next();
    if (p.getId() === rootId) return true;
    parents = p.getParents();
  }
  return false;
}

// ---------- Firestore REST (runs as the script owner, bypasses security rules) ----------
function fsFetch(path, opt) {
  opt = opt || {};
  opt.headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  opt.muteHttpExceptions = true;
  return UrlFetchApp.fetch(FS + path, opt);
}
function val(v) {
  if (!v) return '';
  return v.stringValue !== undefined ? v.stringValue : v.booleanValue !== undefined ? v.booleanValue : v.integerValue !== undefined ? v.integerValue : '';
}

// ---------- daily backup to Google Sheet ----------
function dailySync() {
  const ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  let sh = ss.getSheetByName('Orders');
  if (!sh) {
    sh = ss.insertSheet('Orders');
    sh.appendRow(['Date', 'Time', 'Emp ID', 'Name', 'Department', 'Meal', 'Source', 'Photo link', 'Order key']);
    sh.setFrozenRows(1);
  }
  const res = UrlFetchApp.fetch(FS + ':runQuery', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'orders' }],
      where: { fieldFilter: { field: { fieldPath: 'synced' }, op: 'EQUAL', value: { booleanValue: false } } }
    } })
  });
  if (res.getResponseCode() !== 200) throw new Error('Firestore query failed: ' + res.getContentText());
  const docs = JSON.parse(res.getContentText()).filter(function (r) { return r.document; }).map(function (r) { return r.document; });
  if (!docs.length) return;

  const rows = docs.map(function (d) {
    const f = d.fields, created = new Date(val(f.createdAt));
    return [val(f.date), Utilities.formatDate(created, 'Asia/Kolkata', 'HH:mm'), val(f.empId), val(f.name), val(f.dept),
      val(f.mealName) || val(f.meal), val(f.source),
      val(f.photoFileId) ? 'https://drive.google.com/file/d/' + val(f.photoFileId) + '/view' : '', d.name.split('/').pop()];
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

  // mark as synced (batches of 400)
  for (let i = 0; i < docs.length; i += 400) {
    const writes = docs.slice(i, i + 400).map(function (d) {
      return { update: { name: d.name, fields: { synced: { booleanValue: true } } }, updateMask: { fieldPaths: ['synced'] } };
    });
    const r = UrlFetchApp.fetch(FS + ':commit', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ writes: writes })
    });
    if (r.getResponseCode() !== 200) throw new Error('Marking synced failed: ' + r.getContentText());
  }
  syncEmployees(ss);
}

function syncEmployees(ss) {
  const r = fsFetch('/users?pageSize=300');
  if (r.getResponseCode() !== 200) return;
  const users = (JSON.parse(r.getContentText()).documents || []);
  const sh = ss.getSheetByName('Employees') || ss.insertSheet('Employees');
  sh.clear();
  sh.appendRow(['Emp ID', 'Name', 'Department', 'Phone', 'Role', 'Active']);
  const rows = users.map(function (d) { const f = d.fields; return [val(f.empId), val(f.name), val(f.dept), val(f.phone), val(f.role), f.active ? val(f.active) : true]; });
  if (rows.length) sh.getRange(2, 1, rows.length, 6).setValues(rows);
}

// Run once from the editor to schedule the nightly backup (11 PM)
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailySync') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailySync').timeBased().everyDays(1).atHour(23).inTimezone('Asia/Kolkata').create();
}
