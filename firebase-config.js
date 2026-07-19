/* =====================================================
   Firebase connection settings
   -----------------------------------------------------
   From the Firebase console: Project settings → Your apps
   → shiv-travels-web. See FIREBASE-SETUP.md.

   These values are not secrets — Firebase web config is
   public by design. What protects the data is firestore.rules,
   which must stay published in the console.
   ===================================================== */

window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBGIHF_PUoqJuhX0twLIdnA9pZMKKSC-_g',
  authDomain: 'shiv-urbania.firebaseapp.com',
  projectId: 'shiv-urbania',
  storageBucket: 'shiv-urbania.firebasestorage.app',
  messagingSenderId: '173145848940',
  appId: '1:173145848940:web:be0ec051dfcc4e95216c49',
};

/* Logins are email based in Firebase. You sign in with just "admin" or
   "guest" and this domain is added automatically, matching the accounts
   created in Authentication → Users. */
window.LOGIN_DOMAIN = 'shivtravels.app';
