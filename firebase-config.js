/* =====================================================
   Firebase connection settings
   -----------------------------------------------------
   Paste the config object from the Firebase console here
   (Project settings → Your apps → Web app → SDK setup).
   See FIREBASE-SETUP.md for the full walkthrough.

   While these values are blank the app keeps working
   exactly as before, storing data only in this browser.
   ===================================================== */

window.FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

/* Logins are email based in Firebase. You sign in with just "admin" or
   "guest" and this domain is added automatically, so the accounts you
   create in Firebase must be admin@<this domain> and guest@<this domain>. */
window.LOGIN_DOMAIN = 'shivtravels.app';
