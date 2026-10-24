# Air Flow Food Desk

Employees order daily food with a live verification photo. Admin manages everything. Data flow:

- **Firebase** (Auth + Firestore + Hosting): logins, profiles, orders. Fast.
- **Google Drive**: compressed photos (~640px JPEG, ~40 KB), saved through Apps Script.
- **Google Sheet**: nightly backup of new orders (Apps Script trigger, 11 PM IST).

## One-time setup

### 1. Firebase
1. [console.firebase.google.com](https://console.firebase.google.com) → create project.
2. **Build → Authentication → Sign-in method** → enable **Email/Password**.
3. **Build → Firestore Database** → create (production mode).
4. **Project settings → Your apps → Web (`</>`)** → register, copy the config into `public/js/config.js`.
5. Install CLI and deploy rules + site:
   ```
   npm i -g firebase-tools
   firebase login
   firebase use --add        # pick your project
   firebase deploy
   ```

### 2. First admin account (once)
1. Authentication → Users → **Add user**: email `admin@airflow.app`, a strong password. Copy its **User UID**.
2. Firestore → start collection `users` → document ID = that UID, fields:
   `empId`="admin", `name`="Administrator", `role`="admin", `active`=true (boolean), `dept`="", `phone`="".
3. Sign in with Employee ID `admin`. Add all employees from the **Employees** tab.

### 3. Google Drive + Sheet + Apps Script
1. Create a Drive folder "FoodDesk Photos" (keep it private); copy its ID from the URL.
2. Create a Google Sheet "FoodDesk Backup"; copy its ID.
3. [script.google.com](https://script.google.com) → New project. Paste `apps-script/Code.gs`; fill `CFG`
   (Firebase Web API key, project ID, folder ID, sheet ID). Project settings → show `appsscript.json` and paste ours.
4. **Important – Firestore access:** Project settings → *Google Cloud Platform project* → **Change project** →
   enter your Firebase project number (Firebase Console → Project settings). Use the Google account that owns the Firebase project. Enable the *Cloud Firestore API* if prompted.
5. Run `installDailyTrigger` once (approve permissions). Run `dailySync` once manually to test.
6. **Deploy → New deployment → Web app**: Execute as *Me*, access *Anyone*. Copy the `/exec` URL into `SCRIPT_URL` in `public/js/config.js`, then `firebase deploy` again.

Whenever you change `Code.gs`, use **Deploy → Manage deployments → Edit → New version**.

## Using it
- **Employee**: sign in → "I need food" → live camera photo (stamped with time) → ordered. Can cancel before cut-off. Profile tab has photo, password, history, monthly count.
- **Admin**: Today (live counts, photos, add/remove any order without approval), Employees (add/disable/remove), Reports (date range + CSV), Settings (meals and cut-off times).

## Notes / limits
- Photos are only readable via the script by their owner or an admin (Firebase ID token is verified server-side).
- Cut-off time is enforced in the app, not server-side; an employee with technical skill could bypass it. Admin sees every order and its photo.
- Removing an employee deletes their profile and blocks login; to reuse the same ID, also delete the login in Firebase Authentication.
- Password resets for others: Firebase Console → Authentication (or ask admin to remove + re-add after deleting the login).
- Cameras require HTTPS (Firebase Hosting provides it).
