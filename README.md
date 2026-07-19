# Shiv Travels — Urbania Partner Manager

Local-first web app for the Urbania rental business. All data is stored in the
browser on the device (Settings → Backup to export/restore as JSON).

## Logins

| Username | Password   | Access |
|----------|------------|--------|
| `admin`  | `admin123` | Full rights — add, edit, delete, settings, backup, restore |
| `guest`  | `guest123` | View rights only — sees every screen and record, changes nothing |

The credentials are deliberately **not** shown on the login screen. Change them
under **Settings → Login & Access → Change Password**. If a password is
forgotten, **Reset Logins to Default** restores both accounts without touching
any business data.

Passwords are hashed (SHA-256) before being stored. This is access control for
people sharing a device, not server-grade security — anyone with the device can
read localStorage directly.

### What a guest can and cannot do

Guests keep every read feature: all eleven tabs, dashboards, reports, CSV
export, invoice printing, WhatsApp share, and the full read-only detail view of
any trip, driver, client, vehicle or expense. Every control that writes is
removed from the page, and each write function additionally refuses to run, so
the restriction holds even from the console or a stale button.

## Mobile

The app is fully responsive — every screen and every form works on a phone with
the same functionality as desktop.

Navigation adapts to the width. At 1000px and above the menu is a permanent
left column. Below that it collapses into a slide-in drawer opened with the ☰
button, so no screen needs a sideways-scrolling tab strip. The drawer closes on
item pick, backdrop tap, ✕, or ESC.

On a phone the top bar carries only ☰, the business name, notifications and the
theme toggle. Who is signed in, and the Sign Out button, move into the drawer
where there is room for them.

Pop-up forms become full-screen sheets with a sticky action bar. Wide data
tables become stacked cards — one card per row, with the column name printed
beside each value — so **nothing in the app scrolls sideways on a phone**.

Cards are produced by `applyCardTables()` in `app.js`, which reads the header
row already present in each table and copies the column names onto the cells as
`data-label`; the layout itself is CSS on `table.as-cards`. New tables get the
treatment automatically as long as they start with a `<th>` header row. Tables
of only two columns are left as-is since they already fit.

It is also installable as a phone app: open the site in Chrome (Android) or
Safari (iOS) and choose **Add to Home screen**. A service worker caches the app
shell so it opens and works with no network.

> After changing `app.js`, `auth.js` or `styles.css`, bump `CACHE` in `sw.js` so
> installed phones pick up the new build.

## Running locally

```
python -m http.server 5173
```

Then open http://localhost:5173. Serving over http (not `file://`) is
recommended — it enables the service worker and the SHA-256 hashing.
